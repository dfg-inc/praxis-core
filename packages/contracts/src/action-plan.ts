import { createHash } from "node:crypto";
import { z } from "zod";
import { ApprovalOperationSchema, canonicalize } from "./approval.js";
import { WorkTrackingProviderSchema, WorkflowRoleSchema } from "./workflow.js";

/**
 * Shared action-plan contract for BA / Architect / Developer / Quality.
 * Presenting this plan in Claude is UX only. Authorization requires a broker
 * signature over the same fingerprint.
 */

export const ACTION_PLAN_CONTRACT = "praxis.action.plan";
export const ACTION_PLAN_VERSION = 1;

export const DecisionKindSchema = z.enum([
  "architecture_decision",
  "story_behavior",
  "requirement_acceptance",
  "development_action",
  "quality_verdict",
  "git_operation",
  "issue_tracker_mutation",
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/** Operations that publish or commit work. A plan may contain at most one of them. */
export const SINGLE_AUTHORITY_OPERATIONS = ["git_commit", "git_push", "merge_request", "merge", "deploy", "release"] as const;

const TRACKER_OPERATIONS = ["external_record_create", "external_record_update", "external_state_change"] as const;
const RECORD_OPERATIONS = ["external_record_update", "repository_edit"] as const;

/** Which operations each kind of decision may authorize. Approving one kind never authorizes another. */
export const DECISION_KIND_OPERATIONS: Record<DecisionKind, readonly string[]> = {
  requirement_acceptance: RECORD_OPERATIONS,
  architecture_decision: RECORD_OPERATIONS,
  story_behavior: RECORD_OPERATIONS,
  development_action: ["repository_edit", "validation_with_side_effects", "external_state_change"],
  quality_verdict: ["external_state_change", "external_record_update", "repository_edit"],
  git_operation: SINGLE_AUTHORITY_OPERATIONS,
  issue_tracker_mutation: TRACKER_OPERATIONS,
};

/**
 * A plan is one authority: its operations must fit its decision kind, and commit, push, merge request,
 * merge, deploy and release are each their own approval (a commit approval is not a push approval).
 */
export function authorityProblems(plan: { decisionKind: DecisionKind; operations: readonly string[] }): string[] {
  const problems: string[] = [];
  const allowed = DECISION_KIND_OPERATIONS[plan.decisionKind];
  for (const operation of plan.operations) {
    if (!allowed.includes(operation)) {
      problems.push(`operation ${operation} is not covered by a ${plan.decisionKind} approval`);
    }
  }
  const single = plan.operations.filter((operation) => (SINGLE_AUTHORITY_OPERATIONS as readonly string[]).includes(operation));
  if (single.length > 1) {
    problems.push(`${single.join(" and ")} are separate approvals and cannot share one plan`);
  }
  return problems;
}

/**
 * The decision kind an operation belongs to, derived from what is being done rather than from what a
 * caller claims. `repository_edit` is ambiguous on its own, so callers that know better pass the kind.
 */
export function decisionKindFor(operation: string, action: string, explicit?: DecisionKind): DecisionKind {
  if (explicit) return explicit;
  if ((SINGLE_AUTHORITY_OPERATIONS as readonly string[]).includes(operation)) return "git_operation";
  if (action === "praxis_quality_apply") return "quality_verdict";
  if (operation === "external_record_create" || operation === "external_record_update") return "issue_tracker_mutation";
  if (operation === "external_state_change") {
    return /developer_(claim|release|complete)/.test(action) ? "development_action" : "issue_tracker_mutation";
  }
  return "development_action";
}

const ActionPlanBaseSchema = z.object({
  contract: z.literal(ACTION_PLAN_CONTRACT),
  version: z.literal(ACTION_PLAN_VERSION),
  planId: z.string().min(1),
  role: WorkflowRoleSchema.exclude(["user"]),
  decisionKind: DecisionKindSchema,
  summary: z.string().min(1),
  provider: WorkTrackingProviderSchema,
  instanceId: z.string().min(1),
  operations: z.array(ApprovalOperationSchema).min(1),
  workItemIds: z.array(z.string()).default([]),
  storyIds: z.array(z.string()).default([]),
  decisionIds: z.array(z.string()).default([]),
  repositories: z.array(z.string()).default([]),
  branch: z.string().optional(),
  remote: z.string().optional(),
  actions: z.array(
    z.object({
      action: z.string().min(1),
      description: z.string().min(1),
      targets: z.array(z.string()).default([]),
      /** Exact approved change for fixture writes. Bound into the plan fingerprint. */
      content: z.string().optional(),
    }),
  ).min(1),
  risks: z.array(z.string()).default([]),
  sideEffects: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

/**
 * A plan is its content. The fingerprint is not a label the writer chooses: it is recomputed from the plan
 * as parsed (defaults applied), so a plan whose fingerprint does not match what it says is rejected by every
 * reader, including the broker that shows it to a human.
 */
export const ActionPlanSchema = ActionPlanBaseSchema.extend({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).superRefine((plan, ctx) => {
  for (const problem of authorityProblems(plan)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["operations"] });
  const { fingerprint, ...body } = plan;
  if (fingerprint !== actionPlanFingerprint(body)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plan fingerprint does not match the plan's content", path: ["fingerprint"] });
  }
});
export type ActionPlan = z.infer<typeof ActionPlanSchema>;

export function actionPlanFingerprint(body: Omit<ActionPlan, "fingerprint">): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
  return `sha256:${digest}`;
}

export function buildActionPlan(
  input: Omit<ActionPlan, "contract" | "version" | "fingerprint">,
): ActionPlan {
  // Hash the plan as it will be stored (defaults applied) so the fingerprint can be recomputed by any reader.
  const body = ActionPlanBaseSchema.parse({
    contract: "praxis.action.plan" as const,
    version: 1 as const,
    ...input,
  });
  return ActionPlanSchema.parse({ ...body, fingerprint: actionPlanFingerprint(body) });
}

export function renderActionPlanForHuman(plan: ActionPlan): string {
  const lines = [
    `Plan ${plan.planId}`,
    `Role: ${plan.role}`,
    `Decision kind: ${plan.decisionKind}`,
    `Provider: ${plan.provider} / ${plan.instanceId}`,
    `Fingerprint: ${plan.fingerprint}`,
    `Summary: ${plan.summary}`,
    `Operations: ${plan.operations.join(", ")}`,
    `Work items: ${plan.workItemIds.join(", ") || "(none)"}`,
    `Stories: ${plan.storyIds.join(", ") || "(none)"}`,
    `Decisions: ${plan.decisionIds.join(", ") || "(none)"}`,
    `Repositories: ${plan.repositories.join(", ") || "(none)"}`,
    plan.branch ? `Branch: ${plan.branch}` : "",
    plan.remote ? `Remote: ${plan.remote}` : "",
    "Actions:",
    ...plan.actions.flatMap((action) => [
      `  - ${action.action}: ${action.description}`,
      action.targets.length ? `    targets: ${action.targets.join(", ")}` : "",
      action.content !== undefined
        ? `    contentDigest: sha256:${createHash("sha256").update(action.content, "utf8").digest("hex")}`
        : "",
    ]),
    "Risks:",
    ...plan.risks.map((risk) => `  - ${risk}`),
    "Side effects:",
    ...plan.sideEffects.map((effect) => `  - ${effect}`),
    `Expires: ${plan.expiresAt}`,
  ];
  return lines.filter(Boolean).join("\n");
}
