import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFixtureJiraProvider,
  createMockFetch,
  createMockJiraState,
  LOCALIZED_RU_TRANSITIONS,
} from "../src/rest-provider.js";
import type { JiraConfig } from "../src/config.js";
import {
  previewQualityApply,
  writeQualityEvidence,
} from "../src/quality-apply.js";
import { applyQualityReview } from "./permit-mutation.js";

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
    const provider = createFixtureJiraProvider({
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
      syncQualityStore: async () => ({ ok: true }),
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
      syncQualityStore: async () => ({ ok: true }),
    });
    expect(again.alreadyApplied).toBe(true);
    expect((await provider.getComments(wp.key)).length).toBe(commentsBefore + 1);
  });

  it("rejects stale fingerprint", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createFixtureJiraProvider({
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

  it("rejects Jira status drift before any write", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createFixtureJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-drift-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
      `${JSON.stringify({ id: "WP-20260914-002", jiraIssueKey: wp.key, qualityState: "pending" }, null, 2)}\n`,
    );
    writeQualityEvidence(repo, {
      reviewId: 4,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      snapshot: { digest: "", files: [] },
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const commentsBefore = (await provider.getComments(wp.key)).length;
    state.issues.get(wp.key)!.status = "Blocked";
    await expect(
      applyQualityReview({
        provider,
        repo,
        workPackageId: "WP-20260914-002",
        previewFingerprint: preview.previewFingerprint,
        syncQualityStore: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/QUALITY_PREVIEW_STALE/);
    expect((await provider.getComments(wp.key)).length).toBe(commentsBefore);
  });

  it("uses the approved transition id even when another Done transition exists", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    state.availableTransitions.push({
      id: "41",
      name: "Закрыть",
      to: {
        id: "10009",
        name: "Закрыто",
        statusCategory: { key: "done", name: "Закрыто" },
      },
    });
    const provider = createFixtureJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-alt-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
      `${JSON.stringify({ id: "WP-20260914-002", jiraIssueKey: wp.key, qualityState: "pending" }, null, 2)}\n`,
    );
    writeQualityEvidence(repo, {
      reviewId: 5,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      snapshot: { digest: "", files: [] },
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const approvedId = preview.plan.actions.find((a) => a.kind === "transition")?.transitionId;
    expect(approvedId).toMatch(/^\d+$/);
    const applied = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    expect(applied.ok).toBe(true);
    expect(state.transitionPosts.some((p) => JSON.stringify(p.body).includes(`"${approvedId}"`))).toBe(
      true,
    );
    expect(state.transitionPosts.some((p) => JSON.stringify(p.body).includes('"41"'))).toBe(false);
  });

  it("does not mark missing manifest committed", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createFixtureJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-noman-"));
    writeQualityEvidence(repo, {
      reviewId: 6,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      snapshot: { digest: "", files: [] },
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const applied = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("QUALITY_MANIFEST_MISSING");
    expect(applied.pending.some((id) => id.includes("manifest"))).toBe(true);
    expect(applied.localStateReconciled).toBe(false);
  });

  it("does not claim success when QualityStore sync fails", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createFixtureJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-sqlite-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
      `${JSON.stringify({ id: "WP-20260914-002", jiraIssueKey: wp.key, qualityState: "pending" }, null, 2)}\n`,
    );
    writeQualityEvidence(repo, {
      reviewId: 8,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      snapshot: { digest: "", files: [] },
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const applied = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
      syncQualityStore: async () => ({ ok: false, reason: "Quality Service is not_started" }),
    });
    expect(applied.ok).toBe(false);
    expect(applied.jiraTransitioned).toBe(true);
    expect(applied.localStateReconciled).toBe(true);
    expect(applied.qualityStoreReconciled).toBe(false);
    const retry = await applyQualityReview({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
      previewFingerprint: preview.previewFingerprint,
      syncQualityStore: async () => ({ ok: true }),
    });
    expect(retry.ok).toBe(true);
    expect(retry.qualityStoreReconciled).toBe(true);
  });

  it("discloses bookkeeping properties in preview", async () => {
    const state = createMockJiraState({ availableTransitions: LOCALIZED_RU_TRANSITIONS });
    const provider = createFixtureJiraProvider({
      config: cfg(),
      fetchImpl: createMockFetch(state, { flavor: "cloud", projectKey: "PRX" }),
    });
    const wp = await provider.createIssue({ summary: "WP", issueType: "Task" });
    const repo = mkdtempSync(join(tmpdir(), "praxis-q-disc-"));
    mkdirSync(join(repo, "work-packages", "WP-20260914-002"), { recursive: true });
    writeFileSync(
      join(repo, "work-packages", "WP-20260914-002", "manifest.json"),
      `${JSON.stringify({ id: "WP-20260914-002", jiraIssueKey: wp.key }, null, 2)}\n`,
    );
    writeQualityEvidence(repo, {
      reviewId: 9,
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: wp.key,
      verdict: "PASSED",
      snapshot: { digest: "", files: [] },
    });
    const preview = await previewQualityApply({
      provider,
      repo,
      workPackageId: "WP-20260914-002",
    });
    const keys = preview.plan.actions.map((a) => a.propertyKey).filter(Boolean);
    expect(keys).toContain("praxis.qualityAppliedReviewId");
    expect(keys).toContain("praxis.qualityCommentId");
    expect(preview.plan.actions.some((a) => a.kind === "sqlite")).toBe(true);
    const transition = preview.plan.actions.find((a) => a.kind === "transition");
    const stateIdx = preview.plan.actions.findIndex((a) => a.kind === "state");
    const transIdx = preview.plan.actions.findIndex((a) => a.kind === "transition");
    expect(transIdx).toBeGreaterThanOrEqual(0);
    expect(stateIdx).toBeGreaterThan(transIdx);
    expect(transition?.transitionId).toBeDefined();
    expect(preview.plan.currentStatus).toBeDefined();
  });
});
