import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "@praxis/jira";
import {
  architectPreviewOp,
  baPreviewOp,
  previewFingerprint,
} from "./operations.js";
import type { JiraConfig } from "@praxis/jira";

function cfg(): JiraConfig {
  return {
    mode: "cloud",
    baseUrl: "https://acme.atlassian.net",
    token: "tok",
    projectKey: "PRX",
    email: "dev@example.com",
    authMode: "cloud-basic",
    epicType: "Epic",
    storyType: "Story",
    taskType: "Task",
    bugType: "Bug",
    workPackageType: "",
    transitions: {},
    workPackageMaxHours: 16,
  };
}

function seedRepo(repo: string, epicKey: string) {
  writeFileSync(
    join(repo, ".project"),
    `stack:\n  - node\n  - javascript\nrequirementsFormat: user-story-gherkin\nrequiredArtifacts: []\nenvironments: []\nknowledge:\n  ref: main\njira: {}\nquality:\n  test: npm test\n`,
  );
  const dir = join(repo, "design", "WP-20260914-002");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "# Counter Reset\n\nadd reset() to src/counter.js\n");
  writeFileSync(join(dir, "change-spec.json"), `${JSON.stringify({ id: "WP-20260914-002" }, null, 2)}\n`);
  const proposalDir = join(repo, ".praxis-jira", "proposals");
  mkdirSync(proposalDir, { recursive: true });
  writeFileSync(
    join(proposalDir, `${epicKey}.json`),
    `${JSON.stringify(
      {
        contract: "jira.ba.proposal",
        version: "1.0.0",
        epicKey,
        stories: [
          {
            logicalId: "E2-FR1",
            artifactId: `ba:${epicKey}:E2-FR1`,
            summary: "Counter library: add reset() to return the counter to zero",
            userStory: { asA: "developer", iWant: "reset", soThat: "I can zero the counter" },
            businessContext: "Counter library",
            acceptanceCriteria: [{ given: "a counter", when: "reset", then: "value is 0" }],
            outOfScope: [],
            dependencies: [],
            requirementIds: ["E2-FR1"],
          },
        ],
        nfrs: [],
        businessRules: [],
        openQuestions: [],
      },
      null,
      2,
    )}\n`,
  );
}

describe("preview operations timeout and fingerprint", () => {
  it("does not import Quality into the preview source path", () => {
    const src = readFileSync(new URL("./operations.ts", import.meta.url), "utf8");
    const ba = src.slice(src.indexOf("export async function baPreviewOp"), src.indexOf("export async function baApplyOp"));
    const arch = src.slice(
      src.indexOf("export async function architectPreviewOp"),
      src.indexOf("export async function architectApplyOp"),
    );
    expect(ba).not.toMatch(/ensureQuality|quality_status|8792/);
    expect(arch).not.toMatch(/ensureQuality|quality_status|8792/);
  });

  it("direct BA and Architect preview complete under budget with deterministic fingerprints", async () => {
    const state = createMockJiraState();
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const epic = await provider.createIssue({ summary: "Counter", issueType: "Epic" });
    const dup = await provider.createIssue({
      summary: "[DUPLICATE — superseded by PRX-3] reset",
      issueType: "Story",
      parentKey: epic.key,
      labels: ["praxis-duplicate"],
    });
    const canon = await provider.createIssue({
      summary: "Counter library: add reset() to return the counter to zero",
      issueType: "Story",
      parentKey: epic.key,
    });
    await provider.setIssueProperty(dup.key, "praxis.superseded", true);
    await provider.setIssueProperty(dup.key, "praxis.supersededBy", canon.key);
    const repo = mkdtempSync(join(tmpdir(), "praxis-cli-preview-"));
    seedRepo(repo, epic.key);
    await provider.setIssueProperty(canon.key, "praxis.artifactId", `ba:${epic.key}:E2-FR1`);
    await provider.setIssueProperty(canon.key, "praxis.managed", true);
    await provider.setIssueProperty(epic.key, "praxis.baHandoff", {
      contract: "jira.ba.architect.handoff",
      version: "1.0.0",
      epicKey: epic.key,
      storyKeys: [canon.key],
      canonicalStoryKeys: [canon.key],
      supersededStoryKeys: [dup.key],
      requirementIds: ["E2-FR1"],
      baArtifacts: [],
      openQuestions: [],
      nfrs: [],
      businessRules: [],
      constraints: [],
      acceptanceSummary: "Given a counter",
      dependencies: [],
      proposalReady: true,
      readyForArchitecture: true,
    });
    const ctx = { repo, epic: epic.key, provider };
    const ba1 = await baPreviewOp(ctx);
    const ba2 = await baPreviewOp(ctx);
    expect(ba1.durationMs).toBeLessThan(5000);
    expect(ba1.previewFingerprint).toMatch(/^sha256:/);
    expect(ba1.previewFingerprint).toBe(ba2.previewFingerprint);
    expect(ba1.previewFingerprint).toBe(previewFingerprint(ba1.plan));
    expect(ba1.handoff.readyForArchitecture).toBe(true);
    expect(ba1.plan.filter((p: { action: string }) => p.action === "CREATE")).toEqual([]);
    const arch1 = await architectPreviewOp(ctx);
    const arch2 = await architectPreviewOp(ctx);
    expect(arch1.durationMs).toBeLessThan(5000);
    expect(arch1.previewFingerprint).toBe(arch2.previewFingerprint);
    const plan = arch1.plan as Array<{ action: string; kind: string }>;
    expect(plan.filter((p) => p.action === "CREATE" && p.kind === "work-package")).toHaveLength(1);
    expect(plan.filter((p) => p.action === "IGNORED")).toHaveLength(1);
  });

  it("returns BA_PREVIEW_TIMEOUT with stage when Jira hangs", async () => {
    const hung: typeof fetch = async (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: hung,
      timeoutMs: 50,
    });
    const repo = mkdtempSync(join(tmpdir(), "praxis-cli-timeout-"));
    writeFileSync(join(repo, ".project"), "stack: [node]\n");
    await expect(
      baPreviewOp({
        repo,
        epic: "PRX-1",
        provider,
        deadlineMs: 200,
      }),
    ).rejects.toMatchObject({
      code: "BA_PREVIEW_TIMEOUT",
    });
  });
});
