import { describe, expect, it } from "vitest";
import {
  ActionPlanSchema,
  authorityProblems,
  buildActionPlan,
  decisionKindFor,
} from "./index.js";

const base = {
  planId: "plan-1",
  role: "developer" as const,
  summary: "s",
  provider: "local" as const,
  instanceId: "local",
  workItemIds: ["WI-1"],
  actions: [{ action: "a", description: "d", targets: ["t"] }],
  createdAt: "2026-10-20T10:00:00.000Z",
  expiresAt: "2026-10-20T11:00:00.000Z",
};

describe("one authority per plan", () => {
  it("regression: a commit and a push can no longer share a plan", () => {
    // Original gap: operations was a free list, so one approval could cover both.
    expect(() => buildActionPlan({ ...base, decisionKind: "git_operation", operations: ["git_commit", "git_push"] })).toThrow(
      /separate approvals/,
    );
    expect(() => buildActionPlan({ ...base, decisionKind: "git_operation", operations: ["git_push", "merge_request"] })).toThrow(
      /separate approvals/,
    );
  });

  it("each of commit, push, merge request, merge, deploy and release is allowed on its own", () => {
    for (const operation of ["git_commit", "git_push", "merge_request", "merge", "deploy", "release"] as const) {
      expect(buildActionPlan({ ...base, decisionKind: "git_operation", operations: [operation] }).operations).toEqual([operation]);
    }
  });

  it("an operation outside the decision kind is rejected, so a story approval cannot carry a push", () => {
    expect(authorityProblems({ decisionKind: "story_behavior", operations: ["git_push"] })).toEqual([
      "operation git_push is not covered by a story_behavior approval",
    ]);
    expect(authorityProblems({ decisionKind: "issue_tracker_mutation", operations: ["git_commit"] })).toHaveLength(1);
    expect(authorityProblems({ decisionKind: "architecture_decision", operations: ["repository_edit"] })).toEqual([]);
  });

  it("a plan has exactly one action, so the approval covers everything the human was shown", () => {
    const two = { ...base, decisionKind: "development_action" as const, operations: ["repository_edit" as const], actions: [...base.actions, { action: "b", description: "second", targets: ["u"] }] };
    expect(() => buildActionPlan(two)).toThrow(/exactly one action/);
  });

  it("a hand-written plan file that breaks the rules is rejected by the plan schema", () => {
    const good = buildActionPlan({ ...base, decisionKind: "development_action", operations: ["repository_edit"] });
    expect(ActionPlanSchema.safeParse(good).success).toBe(true);
    const crafted = { ...good, decisionKind: "story_behavior", operations: ["git_push", "git_commit"] };
    expect(ActionPlanSchema.safeParse(crafted).success).toBe(false);
  });
});

describe("the decision kind follows what is being done", () => {
  it("derives the kind from what is being done, not from what a caller claims", () => {
    expect(decisionKindFor("git_commit", "praxis_developer_git_commit")).toBe("git_operation");
    expect(decisionKindFor("git_push", "praxis_developer_git_publish")).toBe("git_operation");
    expect(decisionKindFor("external_state_change", "praxis_quality_apply")).toBe("quality_verdict");
    expect(decisionKindFor("external_state_change", "praxis_developer_claim")).toBe("development_action");
    expect(decisionKindFor("external_record_update", "praxis_ba_apply")).toBe("issue_tracker_mutation");
    expect(decisionKindFor("repository_edit", "x", "story_behavior")).toBe("story_behavior");
  });
});

describe("a plan's fingerprint is its content, not a label", () => {
  const plan = buildActionPlan({ ...base, decisionKind: "development_action", operations: ["repository_edit"] });

  it("regression: a stored plan's fingerprint can be recomputed from the stored plan", () => {
    // Original defect: the hash was taken before schema defaults were applied, so readers could not verify it.
    const stored = JSON.parse(JSON.stringify(plan));
    expect(ActionPlanSchema.safeParse(stored).success).toBe(true);
  });

  it("changing any field, or swapping in another plan's fingerprint, is rejected", () => {
    const other = buildActionPlan({ ...base, planId: "plan-2", decisionKind: "development_action", operations: ["repository_edit"] });
    const edits: Array<(p: Record<string, unknown>) => void> = [
      (p) => (p.summary = "something else"),
      (p) => ((p.actions as Array<{ targets: string[] }>)[0]!.targets = ["/etc/passwd"]),
      (p) => (p.instanceId = "elsewhere"),
      (p) => (p.expiresAt = "2030-01-01T00:00:00.000Z"),
      (p) => (p.fingerprint = other.fingerprint),
    ];
    for (const edit of edits) {
      const forged = JSON.parse(JSON.stringify(plan));
      edit(forged);
      const result = ActionPlanSchema.safeParse(forged);
      expect(result.success).toBe(false);
      expect(JSON.stringify((result as { error: unknown }).error)).toMatch(/fingerprint does not match/);
    }
  });
});
