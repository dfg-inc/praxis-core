/**
 * Quality Review orchestration: ensure Quality Service, POST /reviews/work-package, persist local evidence.
 * Does not mutate Jira.
 */
import { resolve } from "node:path";
import { writeQualityEvidence, readQualityEvidence, liveSnapshotDigest } from "@praxis/jira/workflow";
import { QualityStartupError } from "./quality-ensure.js";

export class QualityReviewTransportError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>, status?: number) {
    super(message);
    this.name = "QualityReviewTransportError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export type QualityReviewHttpResult = {
  reviewId: number;
  workPackageId: string;
  jiraWorkPackageKey: string;
  canonicalStoryKeys: string[];
  requirementIds: string[];
  verdict: string;
  acceptanceChecks: unknown[];
  verification: unknown;
  findings: unknown[];
  snapshot: { digest?: string; files?: Array<{ path: string }> };
  identityConflicts?: string[];
  developerEvidence?: Record<string, unknown>;
  jiraMutated: false;
  approvalApplied: false;
  evidencePaths: string[];
  qualityServiceUrl: string;
  qualityServiceUsed: true;
  sqliteBackend?: string;
  blockedReason?: string;
};

function qualityApiBase(url: string): string {
  return url.replace(/\/$/, "").replace(/\/health$/i, "");
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = { error: "invalid_json", message: `non-JSON response from ${url}` };
  }
  return { status: res.status, json };
}

export async function runQualityWorkPackageReview(opts: {
  repo: string;
  workPackageId: string;
  runtimeVersion?: string;
}): Promise<QualityReviewHttpResult> {
  const { ensureQuality } = await import("./quality-ensure.js");
  let url: string;
  let sqliteBackend: string | undefined;
  try {
    const override = process.env.PRAXIS_QUALITY_URL;
    if (override) {
      url = qualityApiBase(override);
    } else {
      const ensured = await ensureQuality({ repo: opts.repo });
      url = qualityApiBase(ensured.url);
      sqliteBackend = ensured.sqliteBackend;
    }
  } catch (err) {
    if (err instanceof QualityStartupError) {
      throw err;
    }
    throw err;
  }

  const { status, json } = await postJson(`${url}/reviews/work-package`, {
    projectId: opts.workPackageId,
    workPackageId: opts.workPackageId,
    path: resolve(opts.repo),
    runtimeVersion: opts.runtimeVersion,
  });
  if (status >= 400) {
    throw new QualityReviewTransportError(
      String(json.error ?? "EXTERNAL_SERVICE_ERROR"),
      String(json.message ?? "Quality Review failed"),
      { ...json, verdict: "BLOCKED", qualityServiceUrl: url },
      status,
    );
  }

  const reviewId = Number(json.reviewId);
  const workPackageId = String(json.workPackageId ?? opts.workPackageId);
  const evidence = {
    reviewId,
    workPackageId,
    jiraWorkPackageKey: String(json.jiraWorkPackageKey ?? ""),
    canonicalStoryKeys: Array.isArray(json.canonicalStoryKeys)
      ? (json.canonicalStoryKeys as string[])
      : [],
    requirementIds: Array.isArray(json.requirementIds) ? (json.requirementIds as string[]) : [],
    verdict: String(json.verdict ?? "BLOCKED"),
    acceptanceChecks: Array.isArray(json.acceptanceChecks) ? json.acceptanceChecks : [],
    verification: json.verification ?? null,
    findings: Array.isArray(json.findings) ? json.findings : [],
    snapshot: (json.snapshot as QualityReviewHttpResult["snapshot"]) ?? { digest: "", files: [] },
    identityConflicts: Array.isArray(json.identityConflicts)
      ? (json.identityConflicts as string[])
      : [],
    developerEvidence:
      json.developerEvidence && typeof json.developerEvidence === "object"
        ? (json.developerEvidence as Record<string, unknown>)
        : undefined,
    jiraMutated: false as const,
    approvalApplied: false as const,
    blockedReason: typeof json.blockedReason === "string" ? json.blockedReason : undefined,
    qualityServiceUrl: url,
    runtimeVersion: opts.runtimeVersion ?? null,
  };
  const evidencePath = writeQualityEvidence(opts.repo, evidence);
  return {
    ...evidence,
    evidencePaths: [evidencePath],
    qualityServiceUrl: url,
    qualityServiceUsed: true,
    sqliteBackend,
  };
}

export async function markQualityReviewApplied(opts: {
  repo: string;
  reviewId: number;
  payload: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { probeQuality } = await import("./quality-ensure.js");
  const override = process.env.PRAXIS_QUALITY_URL;
  if (!override) {
    const probe = await probeQuality({ repo: opts.repo });
    if (probe.status !== "healthy") {
      return {
        ok: false,
        reason: `Quality Service is ${probe.status}; Jira/local Apply may already be complete`,
      };
    }
    const { status, json } = await postJson(
      `${qualityApiBase(probe.url)}/reviews/${opts.reviewId}/applied`,
      opts.payload,
    );
    if (status >= 400) {
      return { ok: false, reason: String(json.message ?? `HTTP ${status}`) };
    }
    return { ok: true };
  }
  const { status, json } = await postJson(
    `${qualityApiBase(override)}/reviews/${opts.reviewId}/applied`,
    opts.payload,
  );
  if (status >= 400) {
    return { ok: false, reason: String(json.message ?? `HTTP ${status}`) };
  }
  return { ok: true };
}

export function qualityReviewStatus(repo: string, workPackageId: string): {
  latestReviewId?: number;
  verdict?: string;
  evidencePath?: string;
  snapshotDigest?: string;
  reviewCurrent?: boolean;
  approvalApplied?: boolean;
} {
  const evidence = readQualityEvidence(repo, workPackageId);
  if (!evidence) return {};
  const live = liveSnapshotDigest(repo, evidence.snapshot?.files);
  return {
    latestReviewId: evidence.reviewId,
    verdict: evidence.verdict,
    evidencePath: `design/${workPackageId}/qa/quality-review.json`,
    snapshotDigest: evidence.snapshot?.digest,
    reviewCurrent: !evidence.snapshot?.digest || live === evidence.snapshot.digest,
    approvalApplied: evidence.approvalApplied === true,
  };
}
