/**
 * Canonical Quality lifecycle for public status tools.
 * praxis.workPackageManifest is a membership/claim snapshot, not qualityState.
 */
import type { JiraProvider } from "./provider.js";
import {
  QUALITY_APPLIED_REVIEW_PROP,
  QUALITY_COMMENT_MARK,
  QUALITY_COMMENT_PROP,
  readQualityApplyResult,
  readQualityEvidence,
  type QualityApplyResult,
} from "./quality-apply.js";
import { readWpManifest } from "./work-package-local.js";
import { inspectDeveloperCompletion } from "./developer-complete.js";

export type QualityConsistencyRow = {
  field: string;
  source: string;
  actualValue: unknown;
  expectedValue: unknown;
  consistency: "match" | "mismatch" | "missing" | "ignored";
  diagnosticCode?: string;
};

export type QualityLifecycleSnapshot = {
  workPackageId: string;
  jiraWorkPackageKey?: string;
  jiraStatus?: string | null;
  jiraStatusCategory?: string | null;
  implementationState: string | null;
  readyForQuality: boolean;
  claimState: string | null;
  qualityState: string | null;
  reviewId: number | null;
  appliedReviewId: number | null;
  applyLifecycle?: string | null;
  applyOk?: boolean | null;
  applyPartial?: boolean | null;
  sources: {
    praxisState?: unknown;
    localManifest?: unknown;
    workPackageManifest?: unknown;
    applyResult?: unknown;
    evidence?: unknown;
  };
  consistency: QualityConsistencyRow[];
  overallConsistency: "consistent" | "divergent" | "partial";
};

export type QualityCommentReadback = {
  issueKey: string;
  storedCommentId?: string;
  storedCommentIdPresent: boolean;
  commentExists: boolean;
  markerMatches: boolean;
  reviewIdMatches: boolean;
  belongsToIssue: boolean;
  matchingManagedCount: number;
  duplicates: boolean;
  managedComments: Array<{ id?: string; reviewId?: number; markerOk: boolean }>;
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function qualityStateOf(v: unknown): string | null {
  const rec = asRecord(v);
  return typeof rec?.qualityState === "string" ? rec.qualityState : null;
}

function commentText(body: unknown): string {
  return JSON.stringify(body ?? "");
}

export function commentMatchesReview(body: unknown, reviewId: number): boolean {
  const text = commentText(body);
  return text.includes(QUALITY_COMMENT_MARK) && text.includes(`reviewId=${reviewId}`);
}

export function resolveCanonicalQualityState(input: {
  workPackageId: string;
  jiraWorkPackageKey?: string;
  jiraStatus?: string | null;
  jiraStatusCategory?: string | null;
  praxisState?: Record<string, unknown> | null;
  localManifest?: Record<string, unknown> | null;
  workPackageManifest?: Record<string, unknown> | null;
  claim?: Record<string, unknown> | null;
  applyResult?: QualityApplyResult | null;
  evidence?: { reviewId?: number; verdict?: string; approvalApplied?: boolean } | null;
  inspection?: ReturnType<typeof inspectDeveloperCompletion>;
}): QualityLifecycleSnapshot {
  const inspection = input.inspection;
  const localQs = qualityStateOf(input.localManifest);
  const jiraQs = qualityStateOf(input.praxisState);
  const staleManifestQs = qualityStateOf(input.workPackageManifest);
  const apply = input.applyResult;
  const applyCommitted = apply?.ok === true && apply.partial !== true && apply.lifecycle === "committed";
  const applyPartial = apply?.partial === true || (apply != null && apply.ok === false);
  const evidenceApproved = input.evidence?.approvalApplied === true;

  let qualityState: string | null = null;
  if (applyCommitted && (jiraQs === "approved" || localQs === "approved" || evidenceApproved)) {
    qualityState = "approved";
  } else if (jiraQs) {
    qualityState = jiraQs;
  } else if (localQs) {
    qualityState = localQs;
  } else if (applyCommitted) {
    qualityState = "approved";
  } else if (
    inspection?.readyForQuality === true ||
    inspection?.localStatus === "ready-for-qa" ||
    input.praxisState?.readyForQuality === true
  ) {
    qualityState = "pending";
  }

  const appliedFromJira = input.praxisState?.reviewId;
  const appliedProp =
    typeof appliedFromJira === "number"
      ? appliedFromJira
      : appliedFromJira != null && appliedFromJira !== ""
        ? Number(appliedFromJira)
        : null;
  const appliedReviewId =
    applyCommitted || jiraQs === "approved" || localQs === "approved" || evidenceApproved
      ? (apply?.appliedReviewId ??
        (Number.isFinite(appliedProp) ? appliedProp : null) ??
        (evidenceApproved ? input.evidence?.reviewId ?? null : null))
      : null;

  const implementationState: string | null =
    (typeof input.praxisState?.implementationState === "string"
      ? input.praxisState.implementationState
      : null) ??
    (typeof input.localManifest?.implementationState === "string"
      ? input.localManifest.implementationState
      : null) ??
    (typeof inspection?.implementationState === "string" ? inspection.implementationState : null);

  const readyForQuality =
    input.praxisState?.readyForQuality === true ||
    input.localManifest?.readyForQuality === true ||
    inspection?.readyForQuality === true;

  const claimState: string | null =
    (input.claim && typeof input.claim.state === "string" ? input.claim.state : null) ??
    (typeof asRecord(input.localManifest?.claim)?.state === "string"
      ? String(asRecord(input.localManifest?.claim)?.state)
      : null);

  const expectedApproved = qualityState === "approved" ? "approved" : qualityState;
  const consistency: QualityConsistencyRow[] = [];

  const push = (
    field: string,
    source: string,
    actual: unknown,
    expected: unknown,
    consistencyKind: QualityConsistencyRow["consistency"],
    diagnosticCode?: string,
  ) => {
    consistency.push({ field, source, actualValue: actual, expectedValue: expected, consistency: consistencyKind, diagnosticCode });
  };

  if (jiraQs != null) {
    push(
      "qualityState",
      "praxis.state",
      jiraQs,
      expectedApproved,
      jiraQs === qualityState ? "match" : "mismatch",
      jiraQs === qualityState ? undefined : "QUALITY_STATE_DIVERGENT",
    );
  } else {
    push("qualityState", "praxis.state", null, expectedApproved, qualityState ? "missing" : "match");
  }

  if (localQs != null) {
    push(
      "qualityState",
      "localManifest",
      localQs,
      expectedApproved,
      localQs === qualityState ? "match" : "mismatch",
      localQs === qualityState ? undefined : "QUALITY_STATE_DIVERGENT",
    );
  } else if (qualityState) {
    push("qualityState", "localManifest", null, expectedApproved, "missing", "QUALITY_STATE_LOCAL_MISSING");
  }

  // Only say a manifest was ignored when there is a manifest value to ignore. Reporting "ignored" for a Work
  // Package that has no manifest (a local Work Package, or none yet) told the operator about a stale record
  // that does not exist.
  const manifestQs =
    staleManifestQs ?? (typeof input.workPackageManifest?.status === "string" ? input.workPackageManifest.status : null);
  if (manifestQs !== null) {
    push("qualityState", "praxis.workPackageManifest", manifestQs, qualityState, "ignored", "STALE_WORK_PACKAGE_MANIFEST_NOT_CANONICAL");
  }

  if (applyPartial) {
    push(
      "apply",
      "quality-apply.json",
      { ok: apply?.ok, partial: apply?.partial, lifecycle: apply?.lifecycle },
      { ok: true, partial: false, lifecycle: "committed" },
      "mismatch",
      "QUALITY_APPLY_PARTIAL",
    );
  } else if (applyCommitted) {
    push("apply", "quality-apply.json", apply?.lifecycle, "committed", "match");
  }

  const mismatches = consistency.filter((c) => c.consistency === "mismatch" && c.source !== "praxis.workPackageManifest");
  const overallConsistency: QualityLifecycleSnapshot["overallConsistency"] = applyPartial
    ? "partial"
    : mismatches.length
      ? "divergent"
      : "consistent";

  return {
    workPackageId: input.workPackageId,
    jiraWorkPackageKey: input.jiraWorkPackageKey,
    jiraStatus: input.jiraStatus ?? null,
    jiraStatusCategory: input.jiraStatusCategory ?? null,
    implementationState,
    readyForQuality,
    claimState,
    qualityState,
    reviewId: input.evidence?.reviewId ?? apply?.reviewId ?? null,
    appliedReviewId,
    applyLifecycle: apply?.lifecycle ?? null,
    applyOk: apply?.ok ?? null,
    applyPartial: applyPartial,
    sources: {
      praxisState: input.praxisState ?? null,
      localManifest: input.localManifest
        ? {
            qualityState: input.localManifest.qualityState ?? null,
            implementationState: input.localManifest.implementationState ?? null,
            readyForQuality: input.localManifest.readyForQuality ?? null,
            status: input.localManifest.status ?? null,
          }
        : null,
      workPackageManifest: input.workPackageManifest
        ? {
            status: input.workPackageManifest.status ?? null,
            qualityState: qualityStateOf(input.workPackageManifest),
            hasClaim: Boolean(input.workPackageManifest.claim),
          }
        : null,
      applyResult: apply
        ? { ok: apply.ok, partial: apply.partial, lifecycle: apply.lifecycle, appliedReviewId: apply.appliedReviewId }
        : null,
      evidence: input.evidence
        ? {
            reviewId: input.evidence.reviewId,
            verdict: input.evidence.verdict,
            approvalApplied: input.evidence.approvalApplied === true,
          }
        : null,
    },
    consistency,
    overallConsistency,
  };
}

export async function collectQualityLifecycleSnapshot(opts: {
  provider?: JiraProvider;
  repo: string;
  workPackageId: string;
  jiraIssueKey?: string;
}): Promise<QualityLifecycleSnapshot> {
  const inspection = inspectDeveloperCompletion(opts.repo, opts.workPackageId);
  const localManifest = readWpManifest(opts.repo, opts.workPackageId) ?? null;
  const evidence = readQualityEvidence(opts.repo, opts.workPackageId);
  const applyResult = readQualityApplyResult(opts.repo, opts.workPackageId) ?? null;
  const wpKey = opts.jiraIssueKey ?? evidence?.jiraWorkPackageKey;
  if (!opts.provider || !wpKey || !/^[A-Z][A-Z0-9]+-\d+$/i.test(wpKey)) {
    return resolveCanonicalQualityState({
      workPackageId: opts.workPackageId,
      jiraWorkPackageKey: wpKey,
      localManifest,
      applyResult,
      evidence,
      inspection,
    });
  }
  const issue = await opts.provider.getIssue(wpKey);
  const praxisState = (await opts.provider.readPraxisState<Record<string, unknown>>(wpKey)) ?? null;
  const workPackageManifest =
    (await opts.provider.getIssueProperty<Record<string, unknown>>(wpKey, "praxis.workPackageManifest")) ?? null;
  const claim = (await opts.provider.getIssueProperty<Record<string, unknown>>(wpKey, "praxis.claim")) ?? null;
  const appliedProp = await opts.provider.getIssueProperty<unknown>(wpKey, QUALITY_APPLIED_REVIEW_PROP);
  const mergedState = {
    ...(praxisState ?? {}),
    reviewId: praxisState?.reviewId ?? appliedProp,
  };
  return resolveCanonicalQualityState({
    workPackageId: opts.workPackageId,
    jiraWorkPackageKey: wpKey,
    jiraStatus: issue.status,
    jiraStatusCategory: issue.statusCategory,
    praxisState: mergedState,
    localManifest,
    workPackageManifest,
    claim,
    applyResult,
    evidence,
    inspection,
  });
}

export async function inspectQualityComments(opts: {
  provider: JiraProvider;
  issueKey: string;
  reviewId: number;
}): Promise<QualityCommentReadback> {
  const stored = await opts.provider.getIssueProperty<unknown>(opts.issueKey, QUALITY_COMMENT_PROP);
  const storedCommentId = stored == null ? undefined : String(stored);
  const comments = await opts.provider.getComments(opts.issueKey);
  const managedComments = comments.filter((c) => commentMatchesReview(c.body, opts.reviewId));
  const matching = managedComments;
  const byId = storedCommentId ? comments.find((c) => String(c.id) === storedCommentId) : undefined;
  const markerMatches = byId ? commentText(byId.body).includes(QUALITY_COMMENT_MARK) : false;
  const reviewIdMatches = byId ? commentMatchesReview(byId.body, opts.reviewId) : false;
  return {
    issueKey: opts.issueKey,
    storedCommentId,
    storedCommentIdPresent: Boolean(storedCommentId),
    commentExists: Boolean(byId),
    markerMatches,
    reviewIdMatches,
    belongsToIssue: Boolean(byId),
    matchingManagedCount: matching.length,
    duplicates: matching.length > 1,
    managedComments: matching.map((c) => ({
      id: c.id,
      reviewId: opts.reviewId,
      markerOk: commentMatchesReview(c.body, opts.reviewId),
    })),
  };
}
