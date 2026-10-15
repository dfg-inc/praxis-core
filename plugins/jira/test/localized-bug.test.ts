import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCALIZED_RU_ISSUE_TYPES,
  createFixtureJiraProvider,
  createMockFetch,
  createMockJiraState,
} from "../src/rest-provider.js";
import { previewQualityApply, writeQualityEvidence } from "../src/workflows.js";
import { applyQualityReview, architectPlanEpic, baAnalyzeEpic } from "./permit-mutation.js";
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

describe("localized bug type", () => {
  it("creates blocking bugs with numeric Баг type id", async () => {
    const state = createMockJiraState({
      issueTypes: [
        { id: "10000", name: "Эпик", hierarchyLevel: 1, subtask: false },
        { id: "10001", name: "История", hierarchyLevel: 0, subtask: false },
        { id: "10002", name: "Задача", hierarchyLevel: 0, subtask: false },
        { id: "10012", name: "Баг", hierarchyLevel: 0, subtask: false },
      ],
    });
    const provider = createFixtureJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const meta = await provider.discoverMetadata();
    expect(meta.issueTypes.find((t) => t.id === "10012")).toMatchObject({
      displayName: "Баг",
      semanticType: "bug",
    });
    expect(meta.bugTypeId).toBe("10012");
    expect(meta.bugTypeId).not.toBe("Bug");
    expect(meta.bugTypeId).not.toBe("Баг");

    const epic = await provider.createIssue({ summary: "E", issueType: "Epic" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-bug-"));
    writeFileSync(
      join(repo, ".project"),
      "stack: [node]\nquality:\n  build: \"node -e process.exit(0)\"\n  test: \"node -e process.exit(0)\"\n",
    );
    await baAnalyzeEpic({
      provider,
      epicKey: epic.key,
      repo,
      stories: [
        {
          logicalId: "E2-FR1",
          summary: "s",
          userStory: "As a user I want x So that y",
          acceptanceCriteria: "Given When Then",
          requirementIds: ["E2-FR1"],
        },
      ],
    });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "design", "WP-20260914-002"), { recursive: true });
    writeFileSync(join(repo, "design", "WP-20260914-002", "index.md"), "# WP\n");
    const { workPackages } = await architectPlanEpic({
      provider,
      epicKey: epic.key,
      repo,
    });
    const wpKey = workPackages[0]!.jiraIssueKey;
    writeQualityEvidence(repo, {
      reviewId: 7,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wpKey,
      verdict: "FAILED",
      findings: [{ fingerprint: "gap-1", blocking: true, summary: "AC unverified", acceptanceCheckId: "AC1" }],
      snapshot: { digest: "", files: [] },
      acceptanceChecks: [{ id: "AC1", status: "FAILED" }],
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const report = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    expect(report.ok).toBe(true);
    expect(report.bugsCreated.length).toBeGreaterThan(0);
    const bugs = [...state.issues.values()].filter((i) => i.semanticType === "bug" || i.issueType === "Баг");
    expect(bugs.length).toBeGreaterThan(0);
    expect(bugs[0]!.issueTypeId).toBe("10012");
    expect(bugs[0]!.issueType).toBe("Баг");
    expect(LOCALIZED_RU_ISSUE_TYPES.some((t) => t.name === "Баг")).toBe(true);
  });
});
