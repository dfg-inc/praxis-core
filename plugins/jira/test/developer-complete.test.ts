import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "../src/rest-provider.js";
import {
  architectPlanEpic,
  baAnalyzeEpic,
  claimWorkPackage,
} from "../src/workflows.js";
import {
  applyDeveloperCompleteRecovery,
  developerCompleteWp,
  inspectDeveloperCompletion,
  parseTestCounts,
  previewDeveloperCompleteRecovery,
} from "../src/developer-complete.js";
import type { JiraConfig } from "../src/config.js";

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

function seedDesign(repo: string, id = "WP-20260914-002") {
  const dir = join(repo, "design", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "reset() returns the counter to zero.\n");
  writeFileSync(
    join(dir, "change-spec.json"),
    `${JSON.stringify(
      {
        id,
        requirementIds: ["E2-FR1"],
        files: ["src/counter.js", "src/counter.test.js"],
        features: [
          { id: "FEAT-RESET-IMPL", title: "reset() implementation", readyForDev: true },
          { id: "FEAT-RESET-TESTS", title: "reset() tests", readyForDev: true },
        ],
        acceptanceChecks: [
          { file: "src/counter.js", contains: "function reset" },
          { file: "src/counter.js", contains: "return 0" },
          { file: "src/counter.test.js", contains: "reset" },
          { type: "npm-test" },
        ],
        design: { title: "Add reset() to the counter library" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "architect-developer.handoff.json"),
    `${JSON.stringify(
      {
        contract: "architect.developer.handoff",
        version: "1.0.0",
        workPackageId: id,
        features: [
          { id: "FEAT-RESET-IMPL", title: "reset() implementation", readyForDev: true },
          { id: "FEAT-RESET-TESTS", title: "reset() tests", readyForDev: true },
        ],
        decisionIds: [],
      },
      null,
      2,
    )}\n`,
  );
}

function writePassingProject(repo: string) {
  writeFileSync(
    join(repo, "_praxis_verify.mjs"),
    "console.log('Tests 5 passed'); process.exit(0);\n",
  );
  writeFileSync(
    join(repo, ".project"),
    "stack: [node]\nquality:\n  test: node _praxis_verify.mjs\n",
  );
}

async function seedReady(opts?: { availableTransitions?: typeof LOCALIZED_RU_TRANSITIONS }) {
  const state = createMockJiraState({
    availableTransitions: opts?.availableTransitions ?? LOCALIZED_RU_TRANSITIONS,
  });
  const fetchImpl = createMockFetch(state, { flavor: "cloud", projectKey: "PRX" });
  const provider = createJiraProvider({ config: cfg(), fetchImpl });
  const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
  const repo = mkdtempSync(join(tmpdir(), "praxis-complete-"));
  await baAnalyzeEpic({
    provider,
    epicKey: epic.key,
    repo,
    stories: [
      {
        logicalId: "E2-FR1",
        summary: "Counter library: add reset() to return the counter to zero",
        userStory: "As a developer I want reset So that I can zero the counter",
        acceptanceCriteria: "Given a counter When reset Then value is 0",
        requirementIds: ["E2-FR1"],
      },
    ],
  });
  seedDesign(repo);
  const { workPackages } = await architectPlanEpic({ provider, epicKey: epic.key, repo });
  const wpKey = workPackages[0]!.jiraIssueKey;
  await claimWorkPackage({
    provider,
    wpKey,
    repo,
    actor: "dev-a",
    accountId: "acct-a",
  });
  return { provider, state, repo, wpKey };
}

describe("parseTestCounts", () => {
  it("reads vitest-style summaries", () => {
    expect(parseTestCounts("Tests 5 passed (5)\n")).toEqual({
      passed: 5,
      failed: 0,
      total: 5,
    });
  });
});

describe("developer complete", () => {
  it("keeps Jira in progress, writes evidence and quality handoff", async () => {
    const { provider, state, repo, wpKey } = await seedReady();
    writePassingProject(repo);
    const beforeDone = state.transitionPosts.filter((p) => (p.body as { id?: string }).id === "31").length;
    const result = await developerCompleteWp({ provider, wpKey, repo });
    expect(result.completed).toBe(true);
    expect(result.workPackageId).toBe("WP-20260914-002");
    expect(result.jiraWorkPackageKey).toBe(wpKey);
    expect(result.implementationState).toBe("complete");
    expect(result.readyForQuality).toBe(true);
    expect(result.qualityStarted).toBe(false);
    expect(result.qualityApproved).toBe(false);
    expect(result.claimState).toBe("active");
    expect(result.jiraStatusCategory).toBe("indeterminate");
    expect(result.verification.passed).toBe(5);
    expect(result.verification.failed).toBe(0);
    expect(existsSync(result.evidencePath)).toBe(true);
    expect(existsSync(result.qualityHandoffPath)).toBe(true);
    const evidence = JSON.parse(readFileSync(result.evidencePath, "utf8"));
    expect(evidence.contract).toBe("developer.completion.evidence");
    expect(evidence.canonicalStoryKeys.length).toBeGreaterThan(0);
    expect(evidence.requirementIds).toContain("E2-FR1");
    expect(evidence.implementationScope).toContain("FEAT-RESET-IMPL");
    const handoff = JSON.parse(readFileSync(result.qualityHandoffPath, "utf8"));
    expect(handoff.contract).toBe("developer.quality.handoff");
    expect(handoff.jiraWorkPackageKey).toBe(wpKey);
    const claim = await provider.getIssueProperty<{ state: string }>(wpKey, "praxis.claim");
    expect(claim?.state).toBe("active");
    const afterDone = state.transitionPosts.filter((p) => (p.body as { id?: string }).id === "31").length;
    expect(afterDone).toBe(beforeDone);
    const inspection = inspectDeveloperCompletion(repo, "WP-20260914-002");
    expect(inspection.readyForQuality).toBe(true);
    expect(inspection.localClaim && (inspection.localClaim as { state?: string }).state).toBe("active");
  });

  it("blocks completion when verification fails and does not Done Jira", async () => {
    const { provider, state, repo, wpKey } = await seedReady();
    writeFileSync(join(repo, "_praxis_fail.mjs"), "process.exit(1);\n");
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  test: node _praxis_fail.mjs\n",
    );
    await expect(developerCompleteWp({ provider, wpKey, repo })).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    expect(inspectDeveloperCompletion(repo, "WP-20260914-002").hasHandoff).toBe(false);
    expect(state.transitionPosts.some((p) => (p.body as { id?: string }).id === "31")).toBe(false);
    const issue = await provider.getIssue(wpKey);
    expect(issue.statusCategory).not.toBe("done");
  });

  it("blocks completion when handoff cannot be persisted", async () => {
    const { provider, repo, wpKey } = await seedReady();
    writePassingProject(repo);
    mkdirSync(join(repo, "design", "WP-20260914-002", "dev"), { recursive: true });
    mkdirSync(join(repo, "design", "WP-20260914-002", "dev", "quality-handoff.json"));
    await expect(developerCompleteWp({ provider, wpKey, repo })).rejects.toMatchObject({
      code: "HANDOFF_FAILED",
    });
    const issue = await provider.getIssue(wpKey);
    expect(issue.statusCategory).not.toBe("done");
  });

  it("is idempotent on a second successful complete", async () => {
    const { provider, state, repo, wpKey } = await seedReady();
    writePassingProject(repo);
    const first = await developerCompleteWp({ provider, wpKey, repo });
    const posts = state.transitionPosts.length;
    const second = await developerCompleteWp({ provider, wpKey, repo });
    expect(second.workPackageId).toBe(first.workPackageId);
    expect(second.qualityHandoffPath).toBe(first.qualityHandoffPath);
    expect(second.idempotent).toBe(true);
    expect(state.transitionPosts.length).toBe(posts);
    expect(second.claimState).toBe("active");
  });

  it("requires recovery when Jira is already Done", async () => {
    const { provider, state, repo, wpKey } = await seedReady();
    writePassingProject(repo);
    for (const issue of state.issues.values()) {
      if (issue.key !== wpKey) continue;
      issue.status = "Готово";
      issue.statusCategory = "done";
    }
    await expect(developerCompleteWp({ provider, wpKey, repo })).rejects.toMatchObject({
      code: "PREMATURE_JIRA_DONE",
    });
    const preview = await previewDeveloperCompleteRecovery({ provider, wpKey, repo });
    expect(preview.needed).toBe(true);
    expect(preview.prematureDone).toBe(true);
    expect(preview.missingEvidence).toBe(true);
    expect(preview.proposed.some((p) => p.action === "RESTORE_DEVELOPMENT")).toBe(true);
    const recovered = await applyDeveloperCompleteRecovery({
      provider,
      wpKey,
      repo,
      previewFingerprint: preview.previewFingerprint,
    });
    expect(recovered.completed).toBe(true);
    expect(recovered.readyForQuality).toBe(true);
    const issue = await provider.getIssue(wpKey);
    expect(issue.statusCategory).toBe("indeterminate");
    expect(existsSync(recovered.evidencePath)).toBe(true);
    expect(existsSync(recovered.qualityHandoffPath)).toBe(true);
  });
});
