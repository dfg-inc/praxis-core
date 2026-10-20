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

export const ActionPlanSchema = z.object({
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
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type ActionPlan = z.infer<typeof ActionPlanSchema>;

export function actionPlanFingerprint(body: Omit<ActionPlan, "fingerprint">): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
  return `sha256:${digest}`;
}

export function buildActionPlan(
  input: Omit<ActionPlan, "contract" | "version" | "fingerprint">,
): ActionPlan {
  const draft = {
    contract: "praxis.action.plan" as const,
    version: 1 as const,
    ...input,
  };
  return ActionPlanSchema.parse({
    ...draft,
    fingerprint: actionPlanFingerprint(draft),
  });
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
