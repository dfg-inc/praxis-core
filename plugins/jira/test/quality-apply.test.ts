import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "../src/rest-provider.js";
import type { JiraConfig } from "../src/config.js";
import {
  applyQualityReview,
  previewQualityApply,
  writeQualityEvidence,
} from "../src/quality-apply.js";

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

describe("quality apply", () => {
  it("PASSED preview is read-only and apply reconciles local qualityState", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    await provider.writePraxisState(wp.key, { qualityState: "pending" });
    const commentsBefore = (await provider.getComments(wp.key)).length;
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-apply-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
      `${JSON.stringify({ id: "WP-20260914-002", jiraIssueKey: wp.key, qualityState: "pending" }, null, 2)}\n`,
    );
    writeQualityEvidence(repo, {
      reviewId: 11,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      canonicalStoryKeys: ["PRX-3"],
      requirementIds: ["E2-FR1"],
      verdict: "PASSED",
      acceptanceChecks: [
        { id: "AC1", status: "PASSED" },
        { id: "AC2", status: "PASSED" },
        { id: "AC3", status: "PASSED" },
        { id: "AC4", status: "PASSED" },
      ],
      findings: [],
      snapshot: { digest: "", files: [] },
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    expect(preview.jiraMutated).toBe(false);
    expect(preview.plan.bugsProposed).toBe(0);
    expect(preview.previewFingerprint.startsWith("sha256:")).toBe(true);
    const transition = preview.plan.actions.find((a) => a.kind === "transition");
    expect(transition?.transitionId).toMatch(/^\d+$/);
    expect(transition?.transitionId).not.toBe("Готово");
    expect((await provider.getComments(wp.key)).length).toBe(commentsBefore);

    const applied = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
    });
    expect(applied.ok).toBe(true);
    expect(applied.bugsCreated).toEqual([]);
    const issue = await provider.getIssue(wp.key);
    expect(issue.statusCategory).toBe("done");
    const st = await provider.readPraxisState<{ qualityState?: string }>(wp.key);
    expect(st?.qualityState).toBe("approved");
    const manifest = JSON.parse(
      readFileSync(join(repo, "work-packages", "WP-20260914-002", "manifest.json"), "utf8"),
    ) as { qualityState?: string };
    expect(manifest.qualityState).toBe("approved");

    const again = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
    });
    expect(again.alreadyApplied).toBe(true);
    expect((await provider.getComments(wp.key)).length).toBe(commentsBefore + 1);
  });

  it("rejects stale fingerprint", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-stale-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
      `${JSON.stringify({ id: "WP-20260914-002", jiraIssueKey: wp.key }, null, 2)}\n`,
    );
    writeQualityEvidence(repo, {
      reviewId: 2,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      snapshot: { digest: "", files: [] },
    });
    await previewQualityApply({ provider, repo, workPackageId: "WP-20260914-002" });
    await expect(
      applyQualityReview({
        provider,
        repo,
        workPackageId: "WP-20260914-002",
        previewFingerprint: "sha256:deadbeef",
      }),
    ).rejects.toThrow(/QUALITY_FINGERPRINT_MISMATCH/);
  });
});
