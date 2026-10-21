import { createHash } from "node:crypto";
import { z } from "zod";
import { DecisionKindSchema, authorityProblems, decisionKindFor, DECISION_KIND_OPERATIONS, SINGLE_AUTHORITY_OPERATIONS, type DecisionKind } from "./authority.js";
export { DecisionKindSchema, authorityProblems, decisionKindFor, DECISION_KIND_OPERATIONS, SINGLE_AUTHORITY_OPERATIONS, type DecisionKind };
import { ApprovalOperationSchema, canonicalize } from "./approval.js";
import { WorkTrackingProviderSchema, WorkflowRoleSchema } from "./workflow.js";

/**
 * Shared action-plan contract for BA / Architect / Developer / Quality.
 * This is the preview: what the user is shown before they approve or reject. The approval binds the plan's
 * fingerprint (see user-approval.ts).
 */

export const ACTION_PLAN_CONTRACT = "praxis.action.plan";
export const ACTION_PLAN_VERSION = 1;

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
 * reader, including the client dialog that shows it to the user.
 */
export const ActionPlanSchema = ActionPlanBaseSchema.extend({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).superRefine((plan, ctx) => {
  for (const problem of authorityProblems(plan)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["operations"] });
  // The signed token binds one action, its targets and its content. A second action would be shown to the
  // human as part of the plan yet not be covered by the approval, so a plan has exactly one.
  if (plan.actions.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a plan authorizes exactly one action; split it into separate plans", path: ["actions"] });
  }
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
