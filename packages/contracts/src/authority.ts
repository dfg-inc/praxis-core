import { z } from "zod";

/**
 * Pure rules about what kind of decision an approval is. No imports from the workflow, so
 * both can use it without forming a cycle.
 */
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

