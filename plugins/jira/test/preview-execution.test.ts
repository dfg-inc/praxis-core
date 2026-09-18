import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "../src/rest-provider.js";
import { baAnalyzeEpic, architectPlanEpic, collectEpicStatus } from "../src/workflows.js";
import type { JiraConfig } from "../src/config.js";
import { PRAXIS_ISSUE_PROPERTIES } from "../src/provider.js";

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

function countingFetch(inner: typeof fetch) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      method: String(init?.method ?? "GET").toUpperCase(),
      url: String(input),
    });
    return inner(input, init);
  };
  return { fetchImpl, calls };
}

function alpha31LoadPraxisProperties(listed: string[]): string[] {
  return [
    ...new Set([
      ...PRAXIS_ISSUE_PROPERTIES,
      ...listed.filter((n) => n.startsWith("praxis.")),
    ]),
  ];
}

function storyFingerprint(spec: {
  summary: string;
  userStory: string;
  acceptanceCriteria: string;
  businessContext?: string;
  requirementIds: string[];
  outOfScope?: string;
  dependencies?: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        summary: spec.summary,
        userStory: spec.userStory,
        acceptanceCriteria: spec.acceptanceCriteria,
        businessContext: spec.businessContext ?? "",
        requirementIds: spec.requirementIds,
        outOfScope: spec.outOfScope ?? "",
        dependencies: spec.dependencies ?? [],
      }),
    )
    .digest("hex");
}

const STORY = {
  logicalId: "E2-FR1",
  summary: "Counter library: add reset() to return the counter to zero",
  userStory: "As a developer\n I want reset\n So that I can zero the counter",
  acceptanceCriteria: "Given a counter\nWhen reset\nThen value is 0",
  businessContext: "Counter library",
  requirementIds: ["E2-FR1"],
};

function seedProjectAndWp(repo: string) {
  writeFileSync(
    join(repo, ".project"),
    `stack:\n  - node\n  - javascript\nrequirementsFormat: user-story-gherkin\nrequiredArtifacts: []\nenvironments: []\nknowledge:\n  ref: main\njira: {}\nquality:\n  test: npm test\n`,
  );
  const dir = join(repo, "design", "WP-20260914-002");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "# Counter Reset\n\nadd reset() to src/counter.js\n");
  writeFileSync(join(dir, "change-spec.json"), `${JSON.stringify({ id: "WP-20260914-002" }, null, 2)}\n`);
  writeFileSync(
    join(dir, "architect-developer.handoff.json"),
    `${JSON.stringify({ contract: "architect.developer.handoff", version: "1.0.0", workPackageId: "WP-20260914-002" }, null, 2)}\n`,
  );
  const proposalDir = join(repo, ".praxis-jira", "proposals");
  mkdirSync(proposalDir, { recursive: true });
  writeFileSync(
    join(proposalDir, "PRX-1.json"),
    `${JSON.stringify(
      {
        contract: "jira.ba.proposal",
        version: "1.0.0",
        epicKey: "PRX-1",
        stories: [
          {
            logicalId: "E2-FR1",
            artifactId: "ba:PRX-1:E2-FR1",
            summary: STORY.summary,
            userStory: { asA: "developer", iWant: "reset", soThat: "I can zero the counter" },
            businessContext: STORY.businessContext,
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

async function seedLiveLikeState(fetchImpl: typeof fetch) {
  const provider = createJiraProvider({ config: cfg(), fetchImpl });
  const epic = await provider.createIssue({ summary: "Counter management", issueType: "Epic" });
  const dup = await provider.createIssue({
    summary: "[DUPLICATE — superseded by PRX-3] Counter library: add reset()",
    issueType: "Story",
    parentKey: epic.key,
    labels: ["praxis-duplicate"],
  });
  const canon = await provider.createIssue({
    summary: STORY.summary,
    issueType: "Story",
    parentKey: epic.key,
    description: "User Story\nAcceptance Criteria\nRequirement IDs\nE2-FR1",
  });
  await provider.setIssueProperty(dup.key, "praxis.superseded", true);
  await provider.setIssueProperty(dup.key, "praxis.supersededBy", canon.key);
  await provider.setIssueProperty(canon.key, "praxis.artifactId", `ba:${epic.key}:E2-FR1`);
  await provider.setIssueProperty(canon.key, "praxis.managed", true);
  await provider.setIssueProperty(canon.key, "praxis.role", "ba");
  await provider.setIssueProperty(canon.key, "praxis.contentFingerprint", storyFingerprint(STORY));
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
    acceptanceSummary: STORY.acceptanceCriteria,
    dependencies: [],
    proposalReady: true,
    readyForArchitecture: true,
  });
  return { provider, epicKey: epic.key, dupKey: dup.key, canonKey: canon.key };
}

describe("alpha.31 vs alpha.32 preview execution", () => {
  it("old property hydration unions 14 keys even when list succeeds", () => {
    const listed = ["praxis.artifactId", "praxis.managed", "praxis.baHandoff"];
    const wanted = alpha31LoadPraxisProperties(listed);
    expect(wanted.length).toBeGreaterThanOrEqual(PRAXIS_ISSUE_PROPERTIES.length);
    expect(wanted).toEqual(expect.arrayContaining([...PRAXIS_ISSUE_PROPERTIES]));
  });

  it("alpha.31 sequential 14-key hydration exceeds preview budget; alpha.32 does not", async () => {
    const state = createMockJiraState();
    const mock = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const counted = countingFetch(mock);
    const seeded = await seedLiveLikeState(counted.fetchImpl);
    const repo = mkdtempSync(join(tmpdir(), "praxis-preview-"));
    seedProjectAndWp(repo);
    counted.calls.length = 0;
    const t0 = Date.now();
    const ba = await baAnalyzeEpic({
      provider: seeded.provider,
      epicKey: seeded.epicKey,
      repo,
      dryRun: true,
    });
    const baMs = Date.now() - t0;
    const baGets = counted.calls.filter((c) => c.method === "GET").length;
    expect(ba.ok).toBe(true);
    expect(ba.plan.filter((p) => p.action === "CREATE")).toHaveLength(0);
    expect(ba.handoff.canonicalStoryKeys).toEqual([seeded.canonKey]);
    expect(ba.handoff.readyForArchitecture).toBe(true);

    counted.calls.length = 0;
    const t1 = Date.now();
    const arch = await architectPlanEpic({
      provider: seeded.provider,
      epicKey: seeded.epicKey,
      repo,
      dryRun: true,
    });
    const archMs = Date.now() - t1;
    const archGets = counted.calls.filter((c) => c.method === "GET").length;
    const writes = counted.calls.filter(
      (c) =>
        c.method !== "GET" &&
        c.method !== "HEAD" &&
        !c.url.includes("/search"),
    );
    expect(arch.ok).toBe(true);
    expect(
      (arch.plan as Array<{ action: string; kind: string }>).filter(
        (p) => p.action === "CREATE" && p.kind === "work-package",
      ),
    ).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(baMs).toBeLessThan(5000);
    expect(archMs).toBeLessThan(5000);

    const issues = 3;
    const alpha31GetsPerHydrate = 1 + PRAXIS_ISSUE_PROPERTIES.length;
    const alpha31Passes = 4;
    const alpha31ProjectedGets = issues * alpha31GetsPerHydrate * alpha31Passes;
    const rttMs = 200;
    const alpha31ProjectedMs = alpha31ProjectedGets * rttMs;
    expect(alpha31ProjectedMs).toBeGreaterThan(15_000);
    expect(baGets + archGets).toBeLessThan(alpha31ProjectedGets);
    expect(baGets).toBeLessThan(40);
    expect(archGets).toBeLessThan(40);
  });

  it("preview does not write local canon, Jira, or .praxis-jira/previews", async () => {
    const state = createMockJiraState();
    const mock = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const counted = countingFetch(mock);
    const seeded = await seedLiveLikeState(counted.fetchImpl);
    const repo = mkdtempSync(join(tmpdir(), "praxis-preview-nowrite-"));
    seedProjectAndWp(repo);
    const beforeIssueCount = state.createIssueCount;
    counted.calls.length = 0;
    await baAnalyzeEpic({
      provider: seeded.provider,
      epicKey: seeded.epicKey,
      repo,
      dryRun: true,
    });
    await architectPlanEpic({
      provider: seeded.provider,
      epicKey: seeded.epicKey,
      repo,
      dryRun: true,
    });
    expect(state.createIssueCount).toBe(beforeIssueCount);
    expect(counted.calls.every((c) => c.method === "GET" || c.method === "HEAD" || c.method === "POST" && c.url.includes("/search"))).toBe(true);
    expect(existsSync(join(repo, ".praxis-jira", "previews"))).toBe(false);
    expect(existsSync(join(repo, "work-packages", "WP-20260914-002", "manifest.json"))).toBe(false);
    const handoffDir = join(repo, ".praxis-jira", "handoffs");
    if (existsSync(handoffDir)) {
      expect(readdirSync(handoffDir)).toEqual([]);
    }
  });

  it("status uses fewer hydrations than alpha.31 preview would", async () => {
    const state = createMockJiraState();
    const mock = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
    const counted = countingFetch(mock);
    const seeded = await seedLiveLikeState(counted.fetchImpl);
    counted.calls.length = 0;
    const status = await collectEpicStatus(seeded.provider, seeded.epicKey);
    const statusGets = counted.calls.filter((c) => c.method === "GET").length;
    expect(status.canonicalStories).toEqual([seeded.canonKey]);
    expect(status.ba.readyForArchitecture).toBe(true);
    expect(statusGets).toBeLessThan(issuesBudget());
  });

  it("abort during a hung Jira GET stops preview and allows the next call", async () => {
    let aborted = false;
    const hung: typeof fetch = async (_input, init) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 30_000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(t);
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
      return new Response("{}", { status: 200 });
    };
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: hung,
      timeoutMs: 200,
    });
    const repo = mkdtempSync(join(tmpdir(), "praxis-preview-abort-"));
    seedProjectAndWp(repo);
    await expect(
      baAnalyzeEpic({ provider, epicKey: "PRX-1", repo, dryRun: true }),
    ).rejects.toThrow(/aborted|timeout/i);
    expect(aborted).toBe(true);
    const state = createMockJiraState();
    const healthy = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const epic = await healthy.createIssue({ summary: "E", issueType: "Epic" });
    const emptyRepo = mkdtempSync(join(tmpdir(), "praxis-preview-abort-empty-"));
    const missing = await baAnalyzeEpic({
      provider: healthy,
      epicKey: epic.key,
      repo: emptyRepo,
      dryRun: true,
    });
    expect(missing.reason).toBe("BA_PROPOSAL_MISSING");
  });
});

function issuesBudget(): number {
  return 3 * (1 + PRAXIS_ISSUE_PROPERTIES.length) * 4;
}
