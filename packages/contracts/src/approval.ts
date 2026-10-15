import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WorkflowError, WorkTrackingProviderSchema, WorkflowRoleSchema } from "./workflow.js";

/**
 * Bounded plan approval.
 *
 * confirmation=YES is not an authorization. APPROVED is not reachable through
 * transitionApproval() or an MCP argument. HMAC helpers remain for tests of
 * rejected grants; mutation paths must not load a signing key and must not
 * treat a MAC as proof that a person clicked. Claude Code does not pass a
 * cryptographic permission receipt into tool arguments.
 *
 * The execution gate reads a persisted plan and fails closed. A same-user
 * process can still write that file if the host hook is not loaded. This
 * module does not claim to stop arbitrary host file edits, and it does not
 * claim a host user id.
 */

export const APPROVAL_CONTRACT = "praxis.approval.plan";
export const APPROVAL_CONTRACT_VERSION = "1.0.0";
export const DEFAULT_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;

export const ApprovalStateSchema = z.enum([
  "DISCOVERY",
  "CLARIFICATION",
  "PLAN_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "COMPLETED",
  "CHANGES_REQUESTED",
  "REJECTED",
  "EXPIRED",
  "REVOKED",
  "BLOCKED",
  "FAILED",
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalOperationSchema = z.enum([
  "external_record_create",
  "external_record_update",
  "external_state_change",
  "repository_edit",
  "validation_with_side_effects",
  "git_commit",
  "git_push",
  "merge_request",
  "merge",
  "deploy",
  "release",
]);
export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;

/** These are not covered by an implementation-plan approval. */
export const PUBLICATION_OPERATIONS = [
  "git_push",
  "merge_request",
  "merge",
  "deploy",
  "release",
] as const satisfies readonly ApprovalOperation[];

const EDGES: Record<ApprovalState, readonly ApprovalState[]> = {
  DISCOVERY: ["CLARIFICATION", "PLAN_READY", "BLOCKED"],
  CLARIFICATION: ["PLAN_READY", "BLOCKED"],
  PLAN_READY: ["AWAITING_APPROVAL", "CLARIFICATION"],
  AWAITING_APPROVAL: ["REJECTED", "CHANGES_REQUESTED", "EXPIRED", "BLOCKED"],
  APPROVED: ["EXECUTING", "EXPIRED", "CHANGES_REQUESTED", "REVOKED"],
  EXECUTING: ["VERIFYING", "FAILED", "BLOCKED", "REVOKED"],
  VERIFYING: ["COMPLETED", "FAILED", "CHANGES_REQUESTED"],
  COMPLETED: [],
  CHANGES_REQUESTED: ["PLAN_READY", "AWAITING_APPROVAL"],
  REJECTED: ["PLAN_READY"],
  EXPIRED: ["AWAITING_APPROVAL"],
  REVOKED: [],
  BLOCKED: ["CLARIFICATION", "PLAN_READY"],
  FAILED: ["PLAN_READY"],
};

export const ApprovalPlanSchema = z.object({
  contract: z.literal(APPROVAL_CONTRACT),
  contractVersion: z.literal(APPROVAL_CONTRACT_VERSION),
  planId: z.string().min(1),
  version: z.number().int().positive(),
  role: WorkflowRoleSchema.exclude(["user"]),
  provider: WorkTrackingProviderSchema,
  instanceId: z.string().min(1).optional(),
  workItemIds: z.array(z.string().min(1)).min(1),
  repositories: z.array(z.string().min(1)),
  operations: z.array(ApprovalOperationSchema).min(1),
  inScope: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  /** Preview hash this approval is bound to, when the operation has one. */
  previewFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  state: ApprovalStateSchema,
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approvedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type ApprovalPlan = z.infer<typeof ApprovalPlanSchema>;

export const BrokerGrantSchema = z.object({
  planId: z.string().min(1),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approvedAt: z.string().datetime(),
  dialog: z.literal("host-dialog"),
  mac: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BrokerGrant = z.infer<typeof BrokerGrantSchema>;

type PlanBody = Omit<ApprovalPlan, "state" | "fingerprint" | "approvedAt" | "expiresAt">;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function planFingerprint(body: PlanBody): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
  return `sha256:${digest}`;
}

export function storedPlanFingerprint(plan: ApprovalPlan): string {
  return planFingerprint(bodyOf(plan));
}

function bodyOf(plan: ApprovalPlan): PlanBody {
  const { state: _state, fingerprint: _fingerprint, approvedAt: _approvedAt, expiresAt: _expiresAt, ...body } = plan;
  return body;
}

export function proposePlan(input: Omit<PlanBody, "contract" | "contractVersion" | "version"> & { version?: number }): ApprovalPlan {
  const body: PlanBody = {
    contract: APPROVAL_CONTRACT,
    contractVersion: APPROVAL_CONTRACT_VERSION,
    version: input.version ?? 1,
    planId: input.planId,
    role: input.role,
    provider: input.provider,
    instanceId: input.instanceId,
    workItemIds: input.workItemIds,
    repositories: input.repositories,
    operations: input.operations,
    inScope: input.inScope,
    outOfScope: input.outOfScope,
    assumptions: input.assumptions,
    risks: input.risks,
    previewFingerprint: input.previewFingerprint,
  };
  return ApprovalPlanSchema.parse({
    ...body,
    state: "AWAITING_APPROVAL",
    fingerprint: planFingerprint(body),
  });
}

export function transitionApproval(plan: ApprovalPlan, next: ApprovalState): ApprovalPlan {
  if (next === "APPROVED") {
    throw new WorkflowError(
      "APPROVAL_SELF_GRANT_FORBIDDEN",
      "A caller cannot move a plan to APPROVED. Approval requires a host dialog grant.",
    );
  }
  if (!EDGES[plan.state].includes(next)) {
    throw new WorkflowError(
      "APPROVAL_TRANSITION_FORBIDDEN",
      `cannot move ${plan.state} to ${next}`,
    );
  }
  return { ...plan, state: next };
}

/**
 * MCP-shaped self-approval. Always refuses, including when confirmation is YES.
 * Exists so a tool handler cannot grow a YES shortcut later without failing tests.
 */
export function rejectSelfApproval(input: { confirmation?: string; plan: ApprovalPlan }): never {
  throw new WorkflowError(
    "APPROVAL_SELF_GRANT_FORBIDDEN",
    `refusing to approve ${input.plan.planId} from an MCP argument (${input.confirmation ?? "absent"})`,
  );
}

function grantPayload(plan: ApprovalPlan, approvedAt: string): string {
  return [
    plan.planId,
    String(plan.version),
    plan.fingerprint,
    plan.provider,
    plan.instanceId ?? "",
    plan.workItemIds.join(","),
    plan.repositories.join(","),
    plan.operations.join(","),
    approvedAt,
  ].join("\n");
}

function macFor(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function signBrokerGrant(plan: ApprovalPlan, key: Buffer, approvedAt: string): BrokerGrant {
  if (!Number.isFinite(Date.parse(approvedAt))) {
    throw new WorkflowError("APPROVAL_GRANT_INVALID", "approvedAt is not a timestamp");
  }
  return BrokerGrantSchema.parse({
    planId: plan.planId,
    fingerprint: plan.fingerprint,
    approvedAt,
    dialog: "host-dialog",
    mac: macFor(grantPayload(plan, approvedAt), key),
  });
}

function macMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function applyBrokerGrant(
  plan: ApprovalPlan,
  grant: BrokerGrant,
  key: Buffer,
  now = new Date(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
): ApprovalPlan {
  if (plan.state !== "AWAITING_APPROVAL") {
    throw new WorkflowError("APPROVAL_TRANSITION_FORBIDDEN", `grant refused from ${plan.state}`);
  }
  if (grant.planId !== plan.planId || grant.fingerprint !== plan.fingerprint) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "grant does not match this plan");
  }
  if (plan.fingerprint !== planFingerprint(bodyOf(plan))) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "plan body no longer matches its fingerprint");
  }
  const expected = macFor(grantPayload(plan, grant.approvedAt), key);
  if (!macMatches(grant.mac, expected)) {
    throw new WorkflowError("APPROVAL_GRANT_INVALID", "host dialog grant failed verification");
  }
  const approvedAt = new Date(grant.approvedAt);
  if (Number.isNaN(approvedAt.getTime()) || approvedAt.getTime() > now.getTime() + 60_000) {
    throw new WorkflowError("APPROVAL_GRANT_INVALID", "approval timestamp is not usable");
  }
  const expiresAt = new Date(approvedAt.getTime() + ttlMs);
  if (now.getTime() > expiresAt.getTime()) {
    throw new WorkflowError("APPROVAL_EXPIRED", `grant expired at ${expiresAt.toISOString()}`);
  }
  return {
    ...plan,
    state: "APPROVED",
    approvedAt: approvedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function revisePlan(
  plan: ApprovalPlan,
  patch: Partial<Pick<ApprovalPlan, "operations" | "inScope" | "outOfScope" | "workItemIds" | "repositories" | "assumptions" | "risks">>,
): ApprovalPlan {
  const nextBody: PlanBody = {
    ...bodyOf(plan),
    ...patch,
    version: plan.version + 1,
  };
  return ApprovalPlanSchema.parse({
    ...nextBody,
    state: "AWAITING_APPROVAL",
    fingerprint: planFingerprint(nextBody),
  });
}

export function authorizeOperation(
  plan: ApprovalPlan,
  operation: ApprovalOperation,
  target: {
    workItemId?: string;
    repository?: string;
    provider?: ApprovalPlan["provider"];
    instanceId?: string;
    version?: number;
    previewFingerprint?: string;
  } = {},
  now = new Date(),
): void {
  if (plan.state === "REVOKED") {
    throw new WorkflowError("APPROVAL_REVOKED", `plan ${plan.planId} was revoked`);
  }
  if (plan.state === "REJECTED") {
    throw new WorkflowError("APPROVAL_REJECTED", `plan ${plan.planId} was rejected`);
  }
  if (plan.state === "EXPIRED") {
    throw new WorkflowError("APPROVAL_EXPIRED", `plan ${plan.planId} expired`);
  }
  if (plan.state !== "APPROVED" && plan.state !== "EXECUTING") {
    throw new WorkflowError("APPROVAL_REQUIRED", `plan ${plan.planId} is ${plan.state}`);
  }
  if (plan.fingerprint !== planFingerprint(bodyOf(plan))) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "plan was modified after approval");
  }
  if (target.version !== undefined && target.version !== plan.version) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", `plan ${plan.planId} is version ${plan.version}`);
  }
  if (plan.expiresAt && now.getTime() > Date.parse(plan.expiresAt)) {
    throw new WorkflowError("APPROVAL_EXPIRED", `plan ${plan.planId} expired`);
  }
  if (target.provider && target.provider !== plan.provider) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `provider ${target.provider} is outside plan ${plan.planId}`);
  }
  if (target.instanceId !== undefined && target.instanceId !== plan.instanceId) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `instance ${target.instanceId} is outside plan ${plan.planId}`);
  }
  if (!plan.operations.includes(operation)) {
    const publication = (PUBLICATION_OPERATIONS as readonly string[]).includes(operation);
    throw new WorkflowError(
      publication ? "APPROVAL_SCOPE_SEPARATE" : "APPROVAL_SCOPE_MISMATCH",
      publication
        ? `${operation} needs its own approval; an implementation plan does not cover it`
        : `${operation} is outside plan ${plan.planId}`,
    );
  }
  if (target.workItemId && !plan.workItemIds.includes(target.workItemId)) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `work item ${target.workItemId} is outside the plan`);
  }
  if (target.repository && !plan.repositories.includes(target.repository)) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `repository ${target.repository} is outside the plan`);
  }
  if (
    (target.previewFingerprint !== undefined || plan.previewFingerprint !== undefined) &&
    target.previewFingerprint !== plan.previewFingerprint
  ) {
    throw new WorkflowError("APPROVAL_FINGERPRINT_MISMATCH", "preview fingerprint is not the approved revision");
  }
}

export type ApprovalDialogAnswer = "approve" | "reject" | "unavailable";

export interface ApprovalDialog {
  confirm(summary: string): Promise<ApprovalDialogAnswer>;
}

/**
 * Host-mediated transition. The dialog implementation must be a real user
 * prompt (native dialog). A model-supplied string is not a dialog.
 * "unavailable" fails closed and leaves the plan unapproved.
 */
export async function requestHumanApproval(
  plan: ApprovalPlan,
  key: Buffer,
  dialog: ApprovalDialog,
  now = new Date(),
): Promise<ApprovalPlan> {
  if (plan.state !== "AWAITING_APPROVAL") {
    throw new WorkflowError("APPROVAL_TRANSITION_FORBIDDEN", `cannot request approval from ${plan.state}`);
  }
  const summary = [
    `plan ${plan.planId} v${plan.version}`,
    plan.fingerprint,
    `provider ${plan.provider}`,
    `items ${plan.workItemIds.join(",")}`,
    `ops ${plan.operations.join(",")}`,
    `repos ${plan.repositories.join(",") || "(none)"}`,
  ].join("\n");
  const answer = await dialog.confirm(summary);
  if (answer === "unavailable") {
    throw new WorkflowError("APPROVAL_DIALOG_UNAVAILABLE", "host dialog did not run; plan stays unapproved");
  }
  if (answer !== "approve") {
    return transitionApproval(plan, "REJECTED");
  }
  const grant = signBrokerGrant(plan, key, now.toISOString());
  return applyBrokerGrant(plan, grant, key, now);
}

/** Text the host permission dialog must show. It is not itself an authorization. */
export function approvalSummary(plan: ApprovalPlan): string {
  return [
    "Praxis approval",
    `plan: ${plan.planId}`,
    `version: ${plan.version}`,
    `fingerprint: ${plan.fingerprint}`,
    `provider: ${plan.provider}`,
    `instance: ${plan.instanceId ?? "(local)"}`,
    `work items: ${plan.workItemIds.join(", ")}`,
    `repositories: ${plan.repositories.join(", ") || "(none)"}`,
    `operations: ${plan.operations.join(", ")}`,
    `in scope: ${plan.inScope.join("; ")}`,
    `out of scope: ${plan.outOfScope.join("; ") || "(none)"}`,
    `risks: ${plan.risks.join("; ") || "(none)"}`,
    `preview: ${plan.previewFingerprint ?? "(none)"}`,
  ].join("\n");
}
