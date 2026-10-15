/**
 * Quality Apply preview + Jira writes. Consumes persisted QA evidence. No test rerun.
 * Apply executes the saved preview: no silent QUALITY_APPROVED re-plan.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JiraProvider } from "./provider.js";
import { authorizeJira, hasMutationLease, jiraMutation } from "./mutation-auth.js";
import { ARTIFACT_PROP } from "./managed-scope.js";
import { headingParagraphs, textDocument } from "./rich-text.js";
import {
  assertNumericTransitionId,
  parseJiraTransitions,
  planSemanticIssueTransition,
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

export class QualityApplyError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "QualityApplyError";
    this.code = code;
    this.details = details;
  }
}

export type QualityApplyActionKind =
  | "property"
  | "comment"
  | "state"
  | "transition"
  | "bug"
  | "manifest"
  | "sqlite";

export type QualityApplyAction = {
  id: string;
  kind: QualityApplyActionKind;
  issueKey: string;
  operation: string;
  idempotent?: boolean;
  alreadySatisfied?: boolean;
  propertyKey?: string;
  intendedValue?: unknown;
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

export type QualityApplyLifecycle =
  | "planned"
  | "applying"
  | "jira-transitioned"
  | "reconciling"
  | "committed"
  | "partial";

export type QualityApplyResult = {
  ok: boolean;
  partial: boolean;
  alreadyApplied?: boolean;
  completed: string[];
  pending: string[];
  bugsCreated: string[];
  previewFingerprint: string;
  jiraWorkPackageKey: string;
  reviewId: number;
  appliedReviewId?: number;
  jiraTransitioned: boolean;
  localStateReconciled: boolean;
  qualityStoreReconciled: boolean;
  lifecycle: QualityApplyLifecycle;
  warnings: string[];
  errors: string[];
  code?: string;
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
    currentStatus: plan.currentStatus,
    currentStatusCategory: plan.currentStatusCategory,
    currentQualityState: plan.currentQualityState ?? null,
    actions: plan.actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      issueKey: a.issueKey,
      operation: a.operation,
      propertyKey: a.propertyKey,
      intendedValue: a.intendedValue ?? null,
      marker: a.marker,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      transitionId: a.transitionId,
      transitionName: a.transitionName,
      bugFingerprint: a.bugFingerprint,
      localPath: a.localPath,
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

function propertyAction(
  wpKey: string,
  propertyKey: string,
  intendedValue: unknown,
): QualityApplyAction {
  return {
    id: `property:${wpKey}:${propertyKey}`,
    kind: "property",
    issueKey: wpKey,
    operation: `setIssueProperty ${propertyKey}`,
    propertyKey,
    intendedValue,
    idempotent: true,
  };
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
    throw new QualityApplyError(
      "QUALITY_REVIEW_MISSING",
      `no QA evidence for ${opts.workPackageId}`,
    );
  }
  if (opts.reviewId != null && evidence.reviewId !== opts.reviewId) {
    throw new QualityApplyError(
      "QUALITY_REVIEW_STALE",
      `requested reviewId=${opts.reviewId} latest=${evidence.reviewId}`,
    );
  }
  const liveDigest = liveSnapshotDigest(opts.repo, evidence.snapshot?.files);
  const storedDigest = evidence.snapshot?.digest ?? "";
  const reviewCurrent = !storedDigest || liveDigest === storedDigest;
  if (!reviewCurrent) {
    throw new QualityApplyError(
      "QUALITY_REVIEW_STALE",
      "implementation snapshot changed; run a new Quality Review",
    );
  }
  const wpKey = evidence.jiraWorkPackageKey;
  const issue = await opts.provider.getIssue(wpKey);
  const praxisState = await opts.provider.readPraxisState<{ qualityState?: unknown }>(wpKey);
  const meta = await opts.provider.discoverMetadata();
  const actions: QualityApplyAction[] = [];
  const passed = evidence.verdict === "PASSED";
  const reportSummary = {
    reviewId: evidence.reviewId,
    verdict: evidence.verdict,
    workPackageId: evidence.workPackageId,
  };

  actions.push(propertyAction(wpKey, "praxis.qualityReport", reportSummary));
  actions.push(propertyAction(wpKey, QUALITY_APPLIED_REVIEW_PROP, evidence.reviewId));
  actions.push({
    id: `comment:${wpKey}:${evidence.reviewId}`,
    kind: "comment",
    issueKey: wpKey,
    operation: "addComment",
    marker: commentBody(evidence),
    intendedValue: commentBody(evidence),
    idempotent: true,
  });
  actions.push(
    propertyAction(wpKey, QUALITY_COMMENT_PROP, "created comment id for managed Quality report"),
  );

  if (passed) {
    const planned = await planSemanticIssueTransition(opts.provider, wpKey, "QUALITY_APPROVED");
    const hit = planned.available.find((t) => t.id === planned.id);
    const transitionId = planned.alreadySatisfied
      ? undefined
      : assertNumericTransitionId(planned.id, {
          issueKey: wpKey,
          semanticAction: "QUALITY_APPROVED",
        });
    actions.push({
      id: `transition:${wpKey}:QUALITY_APPROVED`,
      kind: "transition",
      issueKey: wpKey,
      operation: "QUALITY_APPROVED",
      fromStatus: issue.status,
      toStatus: hit?.toStatus ?? (planned.alreadySatisfied ? issue.status : undefined),
      transitionId,
      transitionName: planned.name,
      alreadySatisfied: planned.alreadySatisfied,
      intendedValue: {
        transitionId,
        fromStatus: issue.status,
        toStatus: hit?.toStatus,
        name: planned.name,
      },
      idempotent: true,
    });
    actions.push({
      id: `state:${wpKey}:approved`,
      kind: "state",
      issueKey: wpKey,
      operation: "writePraxisState qualityState=approved",
      intendedValue: { qualityState: "approved", reviewId: evidence.reviewId, lifecycle: "qa-passed" },
      idempotent: true,
    });
    actions.push({
      id: `manifest:${evidence.workPackageId}:approved`,
      kind: "manifest",
      issueKey: wpKey,
      operation: "local qualityState=approved",
      localPath: `work-packages/${evidence.workPackageId}/manifest.json`,
      intendedValue: { qualityState: "approved" },
      idempotent: true,
    });
  } else {
    actions.push({
      id: `manifest:${evidence.workPackageId}:${evidence.verdict.toLowerCase()}`,
      kind: "manifest",
      issueKey: wpKey,
      operation: `local qualityState=${evidence.verdict === "FAILED" ? "failed" : "blocked"}`,
      localPath: `work-packages/${evidence.workPackageId}/manifest.json`,
      intendedValue: {
        qualityState: evidence.verdict === "FAILED" ? "failed" : "blocked",
      },
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
        intendedValue: { summary: f.summary, bugTypeId: meta.bugTypeId },
        idempotent: true,
      });
    }
    actions.push(...bugs);
  }

  actions.push({
    id: `sqlite:${evidence.workPackageId}:${evidence.reviewId}:applied`,
    kind: "sqlite",
    issueKey: wpKey,
    operation: `POST /reviews/${evidence.reviewId}/applied`,
    intendedValue: { reviewId: evidence.reviewId, endpoint: `/reviews/${evidence.reviewId}/applied` },
    idempotent: true,
  });

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

export function readQualityApplyResult(repo: string, workPackageId: string): QualityApplyResult | undefined {
  const p = qualityApplyResultPath(repo, workPackageId);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as QualityApplyResult;
  } catch {
    return undefined;
  }
}

function opId(evidence: QualityReviewEvidence, action: QualityApplyAction): string {
  return `quality:${evidence.workPackageId}:${evidence.reviewId}:${action.id}`;
}

function isCommitted(repo: string, evidence: QualityReviewEvidence, action: QualityApplyAction): boolean {
  return findWriteOp(repo, opId(evidence, action))?.state === "committed";
}

function journalEntry(
  opts: { provider: JiraProvider },
  evidence: QualityReviewEvidence,
  action: QualityApplyAction,
): Parameters<typeof upsertWriteOp>[1] {
  return {
    operationId: opId(evidence, action),
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

async function preflightApprovedJira(opts: {
  provider: JiraProvider;
  plan: QualityApplyPlan;
  resume: boolean;
  transitionCommitted: boolean;
}): Promise<void> {
  const wpKey = opts.plan.jiraWorkPackageKey;
  const issue = await opts.provider.getIssue(wpKey);
  await opts.provider.readPraxisState(wpKey);
  const transition = opts.plan.actions.find((a) => a.kind === "transition");
  if (!transition || transition.alreadySatisfied) return;

  if (opts.transitionCommitted) return;

  if (issue.status !== opts.plan.currentStatus) {
    if (issue.statusCategory === "done") {
      throw new QualityApplyError(
        "QUALITY_RECONCILIATION_REQUIRED",
        `Jira ${wpKey} is already Done but this Apply did not record the transition`,
        {
          issueKey: wpKey,
          expectedStatus: opts.plan.currentStatus,
          actualStatus: issue.status,
        },
      );
    }
    throw new QualityApplyError(
      "QUALITY_PREVIEW_STALE",
      `Jira status changed (${opts.plan.currentStatus} → ${issue.status}); generate a new Quality Apply Preview`,
      {
        issueKey: wpKey,
        expectedStatus: opts.plan.currentStatus,
        actualStatus: issue.status,
      },
    );
  }

  if (!transition.transitionId) {
    throw new QualityApplyError(
      "QUALITY_PREVIEW_STALE",
      "approved preview is missing a numeric transition id",
      { issueKey: wpKey },
    );
  }
  const approvedId = assertNumericTransitionId(transition.transitionId, {
    issueKey: wpKey,
    semanticAction: "QUALITY_APPROVED",
  });
  const available = parseJiraTransitions({
    transitions: await opts.provider.getTransitions(wpKey),
  });
  const hit = available.find((t) => t.id === approvedId);
  if (!hit) {
    throw new QualityApplyError(
      "QUALITY_PREVIEW_STALE",
      `approved transition ${approvedId} is not available; generate a new Quality Apply Preview`,
      {
        issueKey: wpKey,
        approvedTransitionId: approvedId,
        available: available.map((t) => ({ id: t.id, name: t.name, toStatus: t.toStatus })),
      },
    );
  }
  if (transition.toStatus && hit.toStatus && hit.toStatus !== transition.toStatus) {
    throw new QualityApplyError(
      "QUALITY_PREVIEW_STALE",
      `approved transition target changed (${transition.toStatus} → ${hit.toStatus})`,
      {
        issueKey: wpKey,
        approvedTransitionId: approvedId,
        expectedToStatus: transition.toStatus,
        actualToStatus: hit.toStatus,
      },
    );
  }
}

export async function applyQualityReview(opts: {
  provider: JiraProvider;
  repo: string;
  workPackageId: string;
  previewFingerprint: string;
  syncQualityStore?: (input: {
    reviewId: number;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}): Promise<QualityApplyResult> {
  const evidence = readQualityEvidence(opts.repo, opts.workPackageId);
  if (!evidence) {
    throw new QualityApplyError(
      "QUALITY_REVIEW_MISSING",
      `no QA evidence for ${opts.workPackageId}`,
    );
  }
  const liveDigest = liveSnapshotDigest(opts.repo, evidence.snapshot?.files);
  if (evidence.snapshot?.digest && liveDigest !== evidence.snapshot.digest) {
    throw new QualityApplyError(
      "QUALITY_REVIEW_STALE",
      "implementation snapshot changed; run a new Quality Review",
    );
  }

  const previewFile = qualityApplyPreviewPath(opts.repo, opts.workPackageId);
  if (!existsSync(previewFile)) {
    throw new QualityApplyError(
      "QUALITY_FINGERPRINT_MISMATCH",
      "no saved apply preview; re-run apply preview",
    );
  }
  const saved = JSON.parse(readFileSync(previewFile, "utf8")) as {
    previewFingerprint: string;
    plan: QualityApplyPlan;
    reviewId: number;
  };
  if (saved.previewFingerprint !== opts.previewFingerprint) {
    throw new QualityApplyError(
      "QUALITY_FINGERPRINT_MISMATCH",
      "previewFingerprint is stale; re-run apply preview",
    );
  }
  if (qualityApplyFingerprint(saved.plan) !== saved.previewFingerprint) {
    throw new QualityApplyError(
      "QUALITY_FINGERPRINT_MISMATCH",
      "saved preview fingerprint does not match the approved plan",
    );
  }
  if (saved.reviewId !== evidence.reviewId || saved.plan.reviewId !== evidence.reviewId) {
    throw new QualityApplyError(
      "QUALITY_REVIEW_STALE",
      "saved preview does not match latest review",
    );
  }
  if (saved.plan.workPackageId !== opts.workPackageId) {
    throw new QualityApplyError("QUALITY_INPUTS_INCONSISTENT", "work package mismatch");
  }
  if (saved.plan.jiraWorkPackageKey !== evidence.jiraWorkPackageKey) {
    throw new QualityApplyError("QUALITY_INPUTS_INCONSISTENT", "Jira work package mismatch");
  }
  if (!hasMutationLease()) {
    return authorizeJira(jiraMutation(opts.repo, {
      action: "praxis_quality_apply",
      operation: "external_state_change",
      workItemId: opts.workPackageId,
      previewFingerprint: opts.previewFingerprint,
    }), () => applyQualityReview(opts));
  }

  const wpKey = evidence.jiraWorkPackageKey;
  const plan = saved.plan;
  const passed = evidence.verdict === "PASSED";
  const transitionAction = plan.actions.find((a) => a.kind === "transition");
  const transitionCommitted = transitionAction
    ? isCommitted(opts.repo, evidence, transitionAction)
    : false;
  const anyCommitted = plan.actions.some((a) => isCommitted(opts.repo, evidence, a));
  const resume = anyCommitted;

  await preflightApprovedJira({
    provider: opts.provider,
    plan,
    resume,
    transitionCommitted,
  });

  const prior = readQualityApplyResult(opts.repo, opts.workPackageId);
  if (
    prior?.ok &&
    prior.reviewId === evidence.reviewId &&
    prior.previewFingerprint === opts.previewFingerprint &&
    prior.jiraTransitioned &&
    prior.localStateReconciled &&
    prior.qualityStoreReconciled
  ) {
    return {
      ...prior,
      alreadyApplied: true,
      partial: false,
      pending: [],
    };
  }

  const completed: string[] = [];
  const pending = plan.actions.map((a) => a.id);
  const bugsCreated: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const mark = (id: string) => {
    if (!completed.includes(id)) completed.push(id);
    const i = pending.indexOf(id);
    if (i >= 0) pending.splice(i, 1);
  };
  let lifecycle: QualityApplyLifecycle = resume ? "reconciling" : "applying";
  let jiraTransitioned = transitionCommitted || Boolean(transitionAction?.alreadySatisfied) || !passed;
  let localStateReconciled = false;
  let qualityStoreReconciled = false;

  const persistPartial = (extra: Partial<QualityApplyResult> = {}) => {
    const result: QualityApplyResult = {
      ok: false,
      partial: completed.length > 0,
      completed,
      pending: [...pending],
      bugsCreated,
      previewFingerprint: saved.previewFingerprint,
      jiraWorkPackageKey: wpKey,
      reviewId: evidence.reviewId,
      appliedReviewId: evidence.reviewId,
      jiraTransitioned,
      localStateReconciled,
      qualityStoreReconciled,
      lifecycle: extra.lifecycle ?? "partial",
      warnings,
      errors,
      ...extra,
    };
    writeJson(qualityApplyResultPath(opts.repo, evidence.workPackageId), result);
    return result;
  };

  try {
    for (const action of plan.actions) {
      if (isCommitted(opts.repo, evidence, action)) {
        mark(action.id);
        if (action.kind === "transition") jiraTransitioned = true;
        if (action.kind === "manifest") localStateReconciled = true;
        if (action.kind === "sqlite") qualityStoreReconciled = true;
        continue;
      }
      upsertWriteOp(opts.repo, journalEntry(opts, evidence, action));
      advanceWriteOp(opts.repo, opId(evidence, action), { state: "creating" });

      if (action.kind === "property" && action.propertyKey === QUALITY_COMMENT_PROP) {
        const existing = await opts.provider.getIssueProperty<string>(wpKey, QUALITY_COMMENT_PROP);
        if (!existing) {
          const comments = await opts.provider.getComments(wpKey);
          const hit = comments.find((c) =>
            JSON.stringify(c.body ?? "").includes(QUALITY_COMMENT_MARK),
          );
          if (!hit?.id) {
            errors.push("managed comment id is not available yet");
            return persistPartial({ code: "QUALITY_APPLY_INCOMPLETE" });
          }
          await opts.provider.setIssueProperty(wpKey, QUALITY_COMMENT_PROP, hit.id);
        }
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }

      if (action.kind === "property" && action.propertyKey) {
        const value =
          action.propertyKey === "praxis.qualityReport"
            ? {
                reviewId: evidence.reviewId,
                verdict: evidence.verdict,
                workPackageId: evidence.workPackageId,
                acceptanceChecks: evidence.acceptanceChecks,
              }
            : action.propertyKey === QUALITY_APPLIED_REVIEW_PROP
              ? evidence.reviewId
              : action.intendedValue;
        await opts.provider.setIssueProperty(wpKey, action.propertyKey, value);
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }

      if (action.kind === "comment") {
        if (await commentExists(opts.provider, wpKey)) {
          advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
          mark(action.id);
          continue;
        }
        const created = await opts.provider.addComment(
          wpKey,
          opts.provider.renderDescription(textDocument(commentBody(evidence))),
        );
        await opts.provider.setIssueProperty(wpKey, QUALITY_COMMENT_PROP, created.id);
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }

      if (action.kind === "transition") {
        assertRole("qa", "qa-pass");
        if (action.alreadySatisfied) {
          jiraTransitioned = true;
          lifecycle = "jira-transitioned";
          advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
          mark(action.id);
          continue;
        }
        const approvedId = assertNumericTransitionId(action.transitionId, {
          issueKey: wpKey,
          semanticAction: "QUALITY_APPROVED",
        });
        await opts.provider.transitionIssue(wpKey, approvedId);
        jiraTransitioned = true;
        lifecycle = "jira-transitioned";
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }

      if (action.kind === "state") {
        assertRole("qa", "qa-pass");
        if (passed && !jiraTransitioned) {
          errors.push("refusing qualityState=approved before the approved transition succeeds");
          return persistPartial({ code: "QUALITY_APPLY_INCOMPLETE" });
        }
        const prev = (await opts.provider.readPraxisState<Record<string, unknown>>(wpKey)) ?? {};
        await opts.provider.writePraxisState(wpKey, {
          ...prev,
          lifecycle: passed ? "qa-passed" : "qa-blocked",
          qualityState: passed ? "approved" : evidence.verdict === "FAILED" ? "failed" : "blocked",
          reviewId: evidence.reviewId,
        });
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: wpKey });
        mark(action.id);
        continue;
      }

      if (action.kind === "manifest") {
        lifecycle = "reconciling";
        const local = resolveLocalWorkPackage(opts.repo, evidence.workPackageId);
        const manifestFile = local
          ? join(opts.repo, "work-packages", local.id, "manifest.json")
          : join(opts.repo, "work-packages", evidence.workPackageId, "manifest.json");
        if (!local || !existsSync(manifestFile)) {
          errors.push(`QUALITY_MANIFEST_MISSING: cannot update ${evidence.workPackageId}`);
          return persistPartial({ code: "QUALITY_MANIFEST_MISSING" });
        }
        const prev = readWpManifest(opts.repo, local.id) ?? {};
        writeWpManifest(opts.repo, {
          ...prev,
          id: local.id,
          jiraIssueKey: wpKey,
          qualityState: passed
            ? "approved"
            : evidence.verdict === "FAILED"
              ? "failed"
              : "blocked",
        });
        localStateReconciled = true;
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed" });
        mark(action.id);
        continue;
      }

      if (action.kind === "bug" && action.bugFingerprint) {
        assertRole("qa", "create-bug");
        const existingBug = await existingBugKey(opts.provider, action.bugFingerprint);
        if (existingBug) {
          bugsCreated.push(existingBug);
          advanceWriteOp(opts.repo, opId(evidence, action), {
            state: "committed",
            jiraIssueKey: existingBug,
          });
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
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed", jiraIssueKey: created.key });
        mark(action.id);
        continue;
      }

      if (action.kind === "sqlite") {
        lifecycle = "reconciling";
        if (!opts.syncQualityStore) {
          warnings.push("Quality SQLite sync was not provided");
          errors.push("qualityStoreReconciled pending");
          return persistPartial({ code: "QUALITY_STORE_SYNC_PENDING" });
        }
        const synced = await opts.syncQualityStore({
          reviewId: evidence.reviewId,
          payload: {
            previewFingerprint: saved.previewFingerprint,
            completed,
            bugsCreated,
          },
        });
        if (!synced.ok) {
          warnings.push(synced.reason);
          errors.push("Quality SQLite applied-state update failed");
          return persistPartial({ code: "QUALITY_STORE_SYNC_PENDING" });
        }
        qualityStoreReconciled = true;
        advanceWriteOp(opts.repo, opId(evidence, action), { state: "committed" });
        mark(action.id);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(message);
    const code =
      err instanceof QualityApplyError
        ? err.code
        : /QUALITY_|JIRA_TRANSITION/.test(message)
          ? (message.match(/^(QUALITY_[A-Z_]+|JIRA_TRANSITION_[A-Z_]+)/)?.[1] ?? "QUALITY_APPLY_INCOMPLETE")
          : "QUALITY_APPLY_INCOMPLETE";
    return persistPartial({ code, lifecycle: "partial" });
  }

  const issue = await opts.provider.getIssue(wpKey);
  const praxisState = await opts.provider.readPraxisState<{ qualityState?: string }>(wpKey);
  const appliedProp = await opts.provider.getIssueProperty<unknown>(wpKey, QUALITY_APPLIED_REVIEW_PROP);
  jiraTransitioned = !passed || issue.statusCategory === "done" || Boolean(transitionAction?.alreadySatisfied);
  const jiraApproved = !passed || praxisState?.qualityState === "approved";
  const appliedIdOk = Number(appliedProp) === evidence.reviewId || appliedProp === evidence.reviewId;
  const manifest = resolveLocalWorkPackage(opts.repo, evidence.workPackageId);
  const manifestState = manifest
    ? (readWpManifest(opts.repo, manifest.id) as { qualityState?: string } | undefined)?.qualityState
    : undefined;
  localStateReconciled = passed
    ? manifestState === "approved"
    : manifestState === "failed" || manifestState === "blocked";

  if (passed && !jiraTransitioned) {
    errors.push("PRX work package is not Done after Apply");
    return persistPartial({ code: "QUALITY_POSTCONDITION_FAILED" });
  }
  if (passed && !jiraApproved) {
    errors.push("Jira qualityState is not approved");
    return persistPartial({ code: "QUALITY_POSTCONDITION_FAILED" });
  }
  if (!appliedIdOk) {
    errors.push("Jira applied Review ID does not match");
    return persistPartial({ code: "QUALITY_POSTCONDITION_FAILED" });
  }
  if (!localStateReconciled) {
    errors.push("local qualityState was not reconciled");
    return persistPartial({ code: "QUALITY_POSTCONDITION_FAILED" });
  }
  if (!qualityStoreReconciled) {
    errors.push("Quality SQLite applied-state is pending");
    return persistPartial({ code: "QUALITY_STORE_SYNC_PENDING" });
  }
  if (pending.length > 0) {
    return persistPartial({ code: "QUALITY_APPLY_INCOMPLETE" });
  }
  if (passed && bugsCreated.length > 0) {
    errors.push("PASSED review must not create Bugs");
    return persistPartial({ code: "QUALITY_POSTCONDITION_FAILED" });
  }

  writeQualityEvidence(opts.repo, {
    ...evidence,
    approvalApplied: passed,
    jiraMutated: completed.length > 0,
  });

  const result: QualityApplyResult = {
    ok: true,
    partial: false,
    completed,
    pending: [],
    bugsCreated,
    previewFingerprint: saved.previewFingerprint,
    jiraWorkPackageKey: wpKey,
    reviewId: evidence.reviewId,
    appliedReviewId: evidence.reviewId,
    jiraTransitioned,
    localStateReconciled,
    qualityStoreReconciled,
    lifecycle: "committed",
    warnings,
    errors: [],
  };
  writeJson(qualityApplyResultPath(opts.repo, evidence.workPackageId), result);
  return result;
}
