import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildActionPlan, type ActionPlan } from "./action-plan.js";
import { decisionKindFor } from "./authority.js";
import {
  approvedContentDigest,
  assertSecureExecutor,
  readLedgerEntry,
  verifyAuthorization,
} from "./broker.js";
import { inboxStatus, operatorPageUrl, proposeInboxPlan, readInboxPlan, readInboxToken } from "./broker-inbox.js";
import { runAuthorizedMutation, type MutationRequest } from "./approval-store.js";
import { WorkflowError } from "./workflow.js";
import type { ApprovalOperation } from "./approval.js";

/**
 * Authorization of one protected Git operation, request by request.
 *
 * Trust boundaries (named so nobody has to guess):
 *   agent      asks. It may call the apply tool and may write plans to the broker's pending/ inbox. It cannot create
 *              a token and is never handed one: tokens are not in tool responses, arguments or the environment.
 *   broker     decides. It shows the owner the exact plan, and only after the owner's authenticated act it signs a
 *              token bound to that plan with a key the Runtime does not hold. Only the broker writes authorizations/.
 *   Runtime    executes (in this deployment it is also the executor). It verifies signature, expiry, scope and the
 *              replay ledger, checks the live repository still matches what was approved, and then runs the operation
 *              once. A privileged executor under another OS identity is the production path and is not provided here.
 *
 * One request, one plan, one token: the plan id is derived from (operation, action, repository, work item, preview
 * fingerprint), the plan's single action binds targets, instance and the revision (HEAD / commit) inside its content,
 * and the token binds that content's digest. A commit approval is a different operation from a push approval, and a
 * request that differs in any bound field is a different plan that needs its own approval.
 */

export const GIT_REQUEST_CONTRACT = "praxis.git.request.v1";

export type GitOperationKind = Extract<ApprovalOperation, "git_commit" | "git_push" | "merge_request" | "repository_edit">;

/** What the live repository says the operation would do. Supplied by the caller from its own preview. */
export type GitDescribed = {
  /** "local" for operations that stay in the repository; the remote identity (host/owner/repo) for push and merge request. */
  instanceId: string;
  /** Exact resources touched: branch, refspec, file@sha256 ... */
  targets: string[];
  /** HEAD or commit sha the operation starts from. */
  revision: string;
  previewFingerprint: string;
  summary: string;
  description: string;
  risks?: string[];
  branch?: string;
  remote?: string;
};

export type GitRequestKey = {
  operation: GitOperationKind;
  action: string;
  repository: string;
  workItemId: string;
  previewFingerprint: string;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The exact request, as signed content. Every bound field is in it; nothing time-dependent is. */
export function gitRequestContent(key: GitRequestKey, live: GitDescribed): string {
  return canonical({
    contract: GIT_REQUEST_CONTRACT,
    operation: key.operation,
    action: key.action,
    repository: resolve(key.repository),
    workItemId: key.workItemId,
    provider: "local",
    instanceId: live.instanceId,
    targets: live.targets,
    revision: live.revision,
    previewFingerprint: key.previewFingerprint,
  });
}

/** Derived, so the same request always maps to the same plan and a changed request to a different one. */
export function gitPlanId(key: GitRequestKey): string {
  const op = key.operation.replace("_", "-");
  return `git-${op}-${sha(canonical({ ...key, repository: resolve(key.repository) })).slice(0, 24)}`;
}

export function buildGitPlan(key: GitRequestKey, live: GitDescribed, now = new Date(), ttlMs = 3_600_000): ActionPlan {
  return buildActionPlan({
    planId: gitPlanId(key),
    role: "developer",
    decisionKind: decisionKindFor(key.operation, key.action),
    summary: live.summary,
    provider: "local",
    instanceId: live.instanceId,
    operations: [key.operation],
    workItemIds: [key.workItemId],
    storyIds: [],
    decisionIds: [],
    repositories: [resolve(key.repository)],
    ...(live.branch ? { branch: live.branch } : {}),
    ...(live.remote ? { remote: live.remote } : {}),
    actions: [{ action: key.action, description: live.description, targets: live.targets, content: gitRequestContent(key, live) }],
    risks: live.risks ?? [],
    sideEffects: [`${live.summary} in ${resolve(key.repository)}.`],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export class GitApprovalRequired extends WorkflowError {
  readonly details: Record<string, unknown>;
  constructor(code: "APPROVAL_REQUIRED" | "APPROVAL_REJECTED" | "APPROVAL_ISOLATION_UNAVAILABLE", message: string, details: Record<string, unknown>) {
    super(code, message);
    this.details = details;
  }
}

export type GitAuthorizeInput<T> = {
  /** The workspace the Runtime guards (used to refuse a ledger or key inside it). */
  repo: string;
  key: GitRequestKey;
  /** The live preview. Called before anything is proposed or consumed; it must throw when the preview is stale. */
  describe: () => Promise<GitDescribed> | GitDescribed;
  write: () => Promise<T> | T;
  now?: Date;
};

/**
 * Runs `write` only under a broker authorization for exactly this request.
 * Outcomes: the write's result; a stored result when the same approved request already completed (replay); or an
 * error before any side effect: APPROVAL_REQUIRED (plan proposed, owner must decide), APPROVAL_REJECTED,
 * APPROVAL_EXPIRED, APPROVAL_SCOPE_MISMATCH, APPROVAL_ISOLATION_UNAVAILABLE.
 */
export async function authorizeGitOperation<T>(input: GitAuthorizeInput<T>): Promise<T> {
  const { key } = input;
  const now = input.now ?? new Date();
  const planId = gitPlanId(key);
  const token = readInboxToken(planId);

  if (!token) {
    const status = inboxStatus(planId);
    if (status === "broker-not-configured") {
      throw new GitApprovalRequired(
        "APPROVAL_ISOLATION_UNAVAILABLE",
        `${key.action} needs the owner's approval and no approval broker is configured (PRAXIS_BROKER_SHARED_DIR). Nothing was changed.`,
        { planId, status },
      );
    }
    if (status === "rejected") {
      throw new GitApprovalRequired("APPROVAL_REJECTED", `the owner rejected ${key.action} (plan ${planId}). Nothing was changed; a changed request is a new plan.`, { planId, status });
    }
    const live = await input.describe();
    const plan = buildGitPlan(key, live, now);
    proposeInboxPlan(plan, now);
    throw new GitApprovalRequired(
      "APPROVAL_REQUIRED",
      `${live.summary} is waiting for the owner. Plan ${planId} is in the approval inbox; the owner reviews it and decides at ${operatorPageUrl(planId)}. Then apply this same request again. Nothing was changed.`,
      { planId, status: "awaiting-operator", operatorUrl: operatorPageUrl(planId), fingerprint: plan.fingerprint },
    );
  }

  // A token exists. Trust nothing yet: the executor's own trust anchor, then the signature, then the binding.
  const { ledger, publicKeyPem } = assertSecureExecutor(input.repo);
  const stored = readInboxPlan(planId);
  if (!stored) throw new WorkflowError("APPROVAL_REQUIRED", `a token exists for ${planId} but its plan is not in the inbox; refusing`);
  const plan = stored.plan;
  const body = verifyAuthorization(token, publicKeyPem, now);

  const action = plan.actions[0]!;
  const content = action.content ?? "";
  const bound =
    plan.planId === planId &&
    plan.provider === "local" &&
    plan.operations.length === 1 &&
    plan.operations[0] === key.operation &&
    action.action === key.action &&
    plan.workItemIds.length === 1 &&
    plan.workItemIds[0] === key.workItemId &&
    plan.repositories.length === 1 &&
    plan.repositories[0] === resolve(key.repository) &&
    plan.decisionKind === decisionKindFor(key.operation, key.action);
  if (!bound) throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "the approved plan is not for this operation, work item or repository");
  let approvedRequest: Record<string, unknown>;
  try {
    approvedRequest = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "the approved plan has no readable request");
  }
  if (approvedRequest.contract !== GIT_REQUEST_CONTRACT || approvedRequest.previewFingerprint !== key.previewFingerprint) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "the approved request is not this preview");
  }
  if (
    body.planId !== planId ||
    body.planFingerprint !== plan.fingerprint ||
    body.contentDigest !== approvedContentDigest(content) ||
    JSON.stringify(body.targets ?? []) !== JSON.stringify(action.targets) ||
    body.instanceId !== plan.instanceId
  ) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "the token is not for the plan the owner was shown");
  }

  const request: MutationRequest = {
    repo: input.repo,
    planId,
    planFingerprint: plan.fingerprint,
    operation: key.operation,
    provider: "local",
    instanceId: plan.instanceId,
    workItemId: key.workItemId,
    repository: resolve(key.repository),
    previewFingerprint: key.previewFingerprint,
    action: key.action,
    authorization: token,
    now,
  };

  // Already executed with this approval: return what was recorded. No live check, no second execution.
  if (readLedgerEntry(ledger, body.consumptionId)?.status === "completed") {
    return runAuthorizedMutation(request, () => {
      throw new WorkflowError("APPROVAL_RECONCILIATION_REQUIRED", "a completed approval must replay, not run");
    });
  }

  // Not executed yet: the repository must still be exactly what the owner approved. A mismatch is refused here,
  // before the approval is consumed, so the owner's decision is not burned by a stale state.
  const live = await input.describe();
  if (live.previewFingerprint !== key.previewFingerprint || gitRequestContent(key, live) !== content) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", "the repository is no longer in the state the owner approved; ask for a new approval");
  }
  return runAuthorizedMutation(request, input.write);
}
