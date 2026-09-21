/**
 * Quality Apply preview + Jira writes. Consumes persisted QA evidence. No test rerun.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraProvider } from "./provider.js";
import { ARTIFACT_PROP } from "./managed-scope.js";
import { headingParagraphs, textDocument } from "./rich-text.js";
import {
  planSemanticIssueTransition,
  applySemanticIssueTransition,
} from "./transitions.js";
import { assertRole } from "./role-policy.js";
import { writeWpManifest, readWpManifest, resolveLocalWorkPackage } from "./work-package-local.js";
import {
  advanceWriteOp,
  findWriteOp,
  upsertWriteOp,
} from "./write-journal.js";

export const QUALITY_COMMENT_MARK = "Praxis: Quality report";
export const QUALITY_COMMENT_PROP = "praxis.qualityCommentId";
export const QUALITY_APPLIED_REVIEW_PROP = "praxis.qualityAppliedReviewId";

export type QualityApplyAction = {
  id: string;
  kind: "property" | "comment" | "state" | "transition" | "bug" | "manifest";
  issueKey: string;
  operation: string;
  idempotent?: boolean;
  alreadySatisfied?: boolean;
  propertyKey?: string;
  marker?: string;
  fromStatus?: string;
  toStatus?: string;
  transitionId?: string;
  transitionName?: string;
  bugFingerprint?: string;
  bugSummary?: string;
  localPath?: string;
};

export type QualityApplyPlan = {
  workPackageId: string;
  jiraWorkPackageKey: string;
  reviewId: number;
  verdict: string;
  snapshotDigest: string;
  acceptanceDigest: string;
  evidenceDigest: string;
  currentStatus?: string;
  currentStatusCategory?: string;
  currentQualityState?: unknown;
  actions: QualityApplyAction[];
  bugsProposed: number;
};

export type QualityReviewEvidence = {
  reviewId: number;
  workPackageId: string;
  jiraWorkPackageKey: string;
  canonicalStoryKeys?: string[];
  requirementIds?: string[];
  verdict: string;
  acceptanceChecks?: unknown[];
  verification?: unknown;
  findings?: Array<{
    fingerprint?: string;
    blocking?: boolean;
    summary?: string;
    requirementIds?: string[];
    acceptanceCheckId?: string;
  }>;
  snapshot?: { digest?: string; files?: Array<{ path: string; sha256?: string; missing?: boolean }> };
  approvalApplied?: boolean;
  jiraMutated?: boolean;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function qualityApplyFingerprint(plan: QualityApplyPlan): string {
  return `sha256:${digest({
    workPackageId: plan.workPackageId,
    jiraWorkPackageKey: plan.jiraWorkPackageKey,
    reviewId: plan.reviewId,
    verdict: plan.verdict,
    snapshotDigest: plan.snapshotDigest,
    acceptanceDigest: plan.acceptanceDigest,
    evidenceDigest: plan.evidenceDigest,
    actions: plan.actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      issueKey: a.issueKey,
      operation: a.operation,
      propertyKey: a.propertyKey,
      marker: a.marker,
      bugFingerprint: a.bugFingerprint,
    })),
  })}`;
}

export function qualityEvidencePath(repo: string, workPackageId: string): string {
  return join(repo, "design", workPackageId, "qa", "quality-review.json");
}

export function qualityEvidenceSidecarPath(repo: string, workPackageId: string): string {
  return join(repo, ".praxis-jira", "quality", `${workPackageId}.review.json`);
}

export function qualityApplyPreviewPath(repo: string, workPackageId: string): string {
  return join(repo, "design", workPackageId, "qa", "quality-apply-preview.json");
}

export function qualityApplyResultPath(repo: string, workPackageId: string): string {
  return join(repo, "design", workPackageId, "qa", "quality-apply.json");
}

export function readQualityEvidence(
  repo: string,
  workPackageId: string,
): QualityReviewEvidence | undefined {
  const p = qualityEvidencePath(repo, workPackageId);
  const alt = qualityEvidenceSidecarPath(repo, workPackageId);
  const file = existsSync(p) ? p : existsSync(alt) ? alt : undefined;
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as QualityReviewEvidence;
  } catch {
    return undefined;
  }
}

export function writeQualityEvidence(repo: string, evidence: QualityReviewEvidence): string {
  const p = qualityEvidencePath(repo, evidence.workPackageId);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `${JSON.stringify(evidence, null, 2)}\n`);
  const side = qualityEvidenceSidecarPath(repo, evidence.workPackageId);
  mkdirSync(join(side, ".."), { recursive: true });
  writeFileSync(side, `${JSON.stringify(evidence, null, 2)}\n`);
  return p;
}

export function liveSnapshotDigest(
  repo: string,
  files: Array<{ path: string }> | undefined,
): string {
  const uniq = [...new Set((files ?? []).map((f) => f.path).filter(Boolean))].sort();
  const entries = uniq.map((rel) => {
    const abs = join(repo, rel);
    if (!existsSync(abs)) return { path: rel, missing: true as const };
    return { path: rel, sha256: sha256Text(readFileSync(abs, "utf8")) };
  });
  return sha256Text(JSON.stringify(entries));
}

function commentBody(evidence: QualityReviewEvidence): string {
  return `${QUALITY_COMMENT_MARK} ${evidence.verdict} reviewId=${evidence.reviewId}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function previewQualityApply(opts: {
  provider: JiraProvider;
  repo: string;
  workPackageId: string;
  reviewId?: number;
}): Promise<{
  plan: QualityApplyPlan;
  previewFingerprint: string;
  evidence: QualityReviewEvidence;
  reviewCurrent: boolean;
  jiraMutated: false;
}> {
  const evidence = readQualityEvidence(opts.repo, opts.workPackageId);
  if (!evidence) {
    throw new Error(`QUALITY_REVIEW_MISSING: no QA evidence for ${opts.workPackageId}`);
  }
  if (opts.reviewId != null && evidence.reviewId !== opts.reviewId) {
    throw new Error(
      `QUALITY_REVIEW_STALE: requested reviewId=${opts.reviewId} latest=${evidence.reviewId}`,
    );
  }
  const liveDigest = liveSnapshotDigest(opts.repo, evidence.snapshot?.files);
  const storedDigest = evidence.snapshot?.digest ?? "";
  const reviewCurrent = !storedDigest || liveDigest === storedDigest;
  if (!reviewCurrent) {
    throw new Error(
      "QUALITY_REVIEW_STALE: implementation snapshot changed; run a new Quality Review",
    );
  }
  const wpKey = evidence.jiraWorkPackageKey;
  const issue = await opts.provider.getIssue(wpKey);
  const praxisState = await opts.provider.readPraxisState<{ qualityState?: unknown }>(wpKey);
  const meta = await opts.provider.discoverMetadata();
  const actions: QualityApplyAction[] = [];
  const passed = evidence.verdict === "PASSED";

  actions.push({
    id: `property:${wpKey}:praxis.qualityReport`,
    kind: "property",
    issueKey: wpKey,
    operation: "setIssueProperty praxis.qualityReport",
    propertyKey: "praxis.qualityReport",
    idempotent: true,
  });
  actions.push({
    id: `comment:${wpKey}:${evidence.reviewId}`,
    kind: "comment",
    issueKey: wpKey,
    operation: "addComment",
    marker: commentBody(evidence),
    idempotent: true,
  });

  if (passed) {
    actions.push({
      id: `state:${wpKey}:approved`,
      kind: "state",
      issueKey: wpKey,
      operation: "writePraxisState qualityState=approved",
      idempotent: true,
    });
    const planned = await planSemanticIssueTransition(opts.provider, wpKey, "QUALITY_APPROVED");
    const hit = planned.available.find((t) => t.id === planned.id);
    actions.push({
      id: `transition:${wpKey}:QUALITY_APPROVED`,
      kind: "transition",
      issueKey: wpKey,
      operation: "QUALITY_APPROVED",
      fromStatus: issue.status,
      toStatus: hit?.toStatus ?? (planned.alreadySatisfied ? issue.status : undefined),
      transitionId: planned.id,
      transitionName: planned.name,
      alreadySatisfied: planned.alreadySatisfied,
      idempotent: true,
    });
    actions.push({
      id: `manifest:${evidence.workPackageId}:approved`,
      kind: "manifest",
      issueKey: wpKey,
      operation: "local qualityState=approved",
      localPath: `work-packages/${evidence.workPackageId}/manifest.json`,
      idempotent: true,
    });
  } else {
    actions.push({
      id: `manifest:${evidence.workPackageId}:${evidence.verdict.toLowerCase()}`,
      kind: "manifest",
      issueKey: wpKey,
      operation: `local qualityState=${evidence.verdict === "FAILED" ? "failed" : "blocked"}`,
      localPath: `work-packages/${evidence.workPackageId}/manifest.json`,
      idempotent: true,
    });
  }

  const bugs: QualityApplyAction[] = [];
  if (evidence.verdict === "FAILED") {
    for (const f of evidence.findings ?? []) {
      if (!f.blocking || !f.fingerprint) continue;
      bugs.push({
        id: `bug:${f.fingerprint}`,
        kind: "bug",
        issueKey: wpKey,
        operation: `createIssue bugTypeId=${meta.bugTypeId}`,
        bugFingerprint: f.fingerprint,
        bugSummary: f.summary ?? "Quality finding",
        idempotent: true,
      });
    }
    actions.push(...bugs);
  }

  const plan: QualityApplyPlan = {
    workPackageId: evidence.workPackageId,
    jiraWorkPackageKey: wpKey,
    reviewId: evidence.reviewId,
    verdict: evidence.verdict,
    snapshotDigest: storedDigest || liveDigest,
    acceptanceDigest: digest(evidence.acceptanceChecks ?? []),
    evidenceDigest: digest({
      reviewId: evidence.reviewId,
      verdict: evidence.verdict,
      acceptanceChecks: evidence.acceptanceChecks,
      findings: evidence.findings,
    }),
    currentStatus: issue.status,
    currentStatusCategory: issue.statusCategory,
    currentQualityState: praxisState?.qualityState,
    actions,
    bugsProposed: bugs.length,
  };
  const previewFingerprint = qualityApplyFingerprint(plan);
  writeJson(qualityApplyPreviewPath(opts.repo, evidence.workPackageId), {
    previewFingerprint,
    plan,
    reviewId: evidence.reviewId,
    savedAt: new Date().toISOString(),
  });
  return { plan, previewFingerprint, evidence, reviewCurrent: true, jiraMutated: false };
}

async function commentExists(provider: JiraProvider, key: string): Promise<boolean> {
  const existingId = await provider.getIssueProperty<string>(key, QUALITY_COMMENT_PROP);
  if (existingId) return true;
  const comments = await provider.getComments(key);
  return comments.some((c) => JSON.stringify(c.body ?? "").includes(QUALITY_COMMENT_MARK));
}

async function existingBugKey(
  provider: JiraProvider,
  fingerprint: string,
): Promise<string | undefined> {
  const artifactId = `bug:${fingerprint}`;
  const meta = await provider.discoverMetadata();
  const existingBugs = await provider.searchIssues(
    `issuetype = ${meta.bugTypeId} AND project = ${provider.config.projectKey}`,
  );
  for (const b of existingBugs) {
    const aid = await provider.getIssueProperty<string>(b.key, ARTIFACT_PROP);
    if (aid === artifactId) return b.key;
  }
  return undefined;
}

function readApplied(repo: string, workPackageId: string): {
  ok?: boolean;
  reviewId?: number;
  previewFingerprint?: string;
  completed?: string[];
  pending?: string[];
} | undefined {
  const p = qualityApplyResultPath(repo, workPackageId);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as {
      ok?: boolean;
      reviewId?: number;
      previewFingerprint?: string;
      completed?: string[];
      pending?: string[];
    };
  } catch {
    return undefined;
  }
}

function journalEntry(
  opts: { provider: JiraProvider },
  evidence: QualityReviewEvidence,
  action: QualityApplyAction,
): Parameters<typeof upsertWriteOp>[1] {
  return {
    operationId: `quality:${evidence.workPackageId}:${evidence.reviewId}:${action.id}`,
    role: "qa",
    operationType: `quality-apply:${action.kind}`,
    artifactId: action.id,
    jiraIssueKey: evidence.jiraWorkPackageKey,
    state: "planned",
    provider: opts.provider.flavor,
    projectKey: opts.provider.config.projectKey,
    startedAt: new Date().toISOString(),
  };
}

export async function applyQualityReview(opts: {
  provider: JiraProvider;
  repo: string;
  workPackageId: string;
  previewFingerprint: string;
}): Promise<{
  ok: boolean;
  partial: boolean;
  alreadyApplied?: boolean;
  completed: string[];
  pending: string[];
  bugsCreated: string[];
  previewFingerprint: string;
  jiraWorkPackageKey: string;
  reviewId: number;
}> {
  const evidence = readQualityEvidence(opts.repo, opts.workPackageId);
  if (!evidence) {
    throw new Error(`QUALITY_REVIEW_MISSING: no QA evidence for ${opts.workPackageId}`);
  }
  const liveDigest = liveSnapshotDigest(opts.repo, evidence.snapshot?.files);
  if (evidence.snapshot?.digest && liveDigest !== evidence.snapshot.digest) {
    throw new Error(
      "QUALITY_REVIEW_STALE: implementation snapshot changed; run a new Quality Review",
    );
  }

  const prior = readApplied(opts.repo, opts.workPackageId);
  if (
    prior?.ok &&
    prior.reviewId === evidence.reviewId &&
    prior.previewFingerprint === opts.previewFingerprint
  ) {
    return {
      ok: true,
      partial: false,
      alreadyApplied: true,
      completed: prior.completed ?? [],
      pending: [],
      bugsCreated: [],
      previewFingerprint: opts.previewFingerprint,
      jiraWorkPackageKey: evidence.jiraWorkPackageKey,
      reviewId: evidence.reviewId,
    };
  }

  const previewFile = qualityApplyPreviewPath(opts.repo, opts.workPackageId);
  if (!existsSync(previewFile)) {
    throw new Error("QUALITY_FINGERPRINT_MISMATCH: no saved apply preview; re-run apply preview");
  }
  const saved = JSON.parse(readFileSync(previewFile, "utf8")) as {
    previewFingerprint: string;
    plan: QualityApplyPlan;
    reviewId: number;
  };
  if (saved.previewFingerprint !== opts.previewFingerprint) {
    throw new Error("QUALITY_FINGERPRINT_MISMATCH: previewFingerprint is stale; re-run apply preview");
  }
  if (saved.reviewId !== evidence.reviewId || saved.plan.reviewId !== evidence.reviewId) {
    throw new Error("QUALITY_REVIEW_STALE: saved preview does not match latest review");
  }
  if (saved.plan.workPackageId !== opts.workPackageId) {
    throw new Error("QUALITY_INPUTS_INCONSISTENT: work package mismatch");
  }
  if (saved.plan.jiraWorkPackageKey !== evidence.jiraWorkPackageKey) {
    throw new Error("QUALITY_INPUTS_INCONSISTENT: Jira work package mismatch");
  }

  const wpKey = evidence.jiraWorkPackageKey;
  const completed: string[] = [];
  const pending = saved.plan.actions.map((a) => a.id);
  const bugsCreated: string[] = [];
  const mark = (id: string) => {
    completed.push(id);
    const i = pending.indexOf(id);
    if (i >= 0) pending.splice(i, 1);
  };

  try {
    for (const action of saved.plan.actions) {
      const opId = `quality:${evidence.workPackageId}:${evidence.reviewId}:${action.id}`;
      const existing = findWriteOp(opts.repo, opId);
      if (existing?.state === "committed") {
        mark(action.id);
        continue;
      }
      upsertWriteOp(opts.repo, journalEntry(opts, evidence, action));

      if (action.kind === "property") {
        await opts.provider.setIssueProperty(wpKey, "praxis.qualityReport", evidence);
        await opts.provider.setIssueProperty(wpKey, QUALITY_APPLIED_REVIEW_PROP, evidence.reviewId);
        advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }
      if (action.kind === "comment") {
        if (await commentExists(opts.provider, wpKey)) {
          advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
          mark(action.id);
          continue;
        }
        const created = await opts.provider.addComment(
          wpKey,
          opts.provider.renderDescription(textDocument(commentBody(evidence))),
        );
        await opts.provider.setIssueProperty(wpKey, QUALITY_COMMENT_PROP, created.id);
        advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }
      if (action.kind === "state") {
        assertRole("qa", "qa-pass");
        const prev = (await opts.provider.readPraxisState<Record<string, unknown>>(wpKey)) ?? {};
        await opts.provider.writePraxisState(wpKey, {
          ...prev,
          lifecycle: "qa-passed",
          qualityState: "approved",
          reviewId: evidence.reviewId,
        });
        advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }
      if (action.kind === "transition") {
        assertRole("qa", "qa-pass");
        if (action.alreadySatisfied) {
          advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
          mark(action.id);
          continue;
        }
        const issue = await opts.provider.getIssue(wpKey);
        if (issue.statusCategory === "done") {
          advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
          mark(action.id);
          continue;
        }
        await applySemanticIssueTransition(opts.provider, wpKey, "QUALITY_APPROVED");
        advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }
      if (action.kind === "manifest") {
        const local = resolveLocalWorkPackage(opts.repo, evidence.workPackageId);
        if (local) {
          const prev = readWpManifest(opts.repo, local.id) ?? {};
          writeWpManifest(opts.repo, {
            ...prev,
            id: local.id,
            jiraIssueKey: wpKey,
            qualityState:
              evidence.verdict === "PASSED"
                ? "approved"
                : evidence.verdict === "FAILED"
                  ? "failed"
                  : "blocked",
          });
        }
        advanceWriteOp(opts.repo, opId, { state: "committed" });
        mark(action.id);
        continue;
      }
      if (action.kind === "bug" && action.bugFingerprint) {
        assertRole("qa", "create-bug");
        const existingBug = await existingBugKey(opts.provider, action.bugFingerprint);
        if (existingBug) {
          bugsCreated.push(existingBug);
          advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: existingBug });
          mark(action.id);
          continue;
        }
        const meta = await opts.provider.discoverMetadata();
        const created = await opts.provider.createIssue({
          summary: action.bugSummary ?? "Quality finding",
          issueType: opts.provider.config.bugType,
          issueTypeId: meta.bugTypeId,
          labels: ["praxis-managed", "praxis-blocking"],
          description: opts.provider.renderDescription(
            headingParagraphs([
              { heading: "Work Package", body: wpKey },
              { heading: "Review", body: String(evidence.reviewId) },
              { heading: "Finding", body: action.bugSummary ?? "" },
            ]),
          ),
        });
        await opts.provider.setIssueProperty(created.key, ARTIFACT_PROP, `bug:${action.bugFingerprint}`);
        await opts.provider.setIssueProperty(created.key, "praxis.managed", true);
        await opts.provider.setIssueProperty(created.key, "praxis.role", "qa");
        await opts.provider.setIssueProperty(created.key, "praxis.blocking", true);
        await opts.provider.createIssueLink(wpKey, created.key, "Relates");
        const story = evidence.canonicalStoryKeys?.[0];
        if (story) await opts.provider.createIssueLink(story, created.key, "Relates");
        bugsCreated.push(created.key);
        advanceWriteOp(opts.repo, opId, { state: "committed", jiraIssueKey: created.key });
        mark(action.id);
      }
    }
  } catch {
    const result = {
      ok: false,
      partial: completed.length > 0,
      completed,
      pending,
      bugsCreated,
      previewFingerprint: saved.previewFingerprint,
      jiraWorkPackageKey: wpKey,
      reviewId: evidence.reviewId,
      appliedAt: new Date().toISOString(),
    };
    writeJson(qualityApplyResultPath(opts.repo, evidence.workPackageId), result);
    return result;
  }

  const ok = pending.length === 0;
  writeJson(qualityApplyResultPath(opts.repo, evidence.workPackageId), {
    ok,
    partial: pending.length > 0 && completed.length > 0,
    reviewId: evidence.reviewId,
    previewFingerprint: saved.previewFingerprint,
    completed,
    pending,
    bugsCreated,
    appliedAt: new Date().toISOString(),
  });
  writeQualityEvidence(opts.repo, {
    ...evidence,
    approvalApplied: ok && evidence.verdict === "PASSED",
    jiraMutated: completed.length > 0,
  });

  return {
    ok,
    partial: pending.length > 0 && completed.length > 0,
    completed,
    pending,
    bugsCreated,
    previewFingerprint: saved.previewFingerprint,
    jiraWorkPackageKey: wpKey,
    reviewId: evidence.reviewId,
  };
}
