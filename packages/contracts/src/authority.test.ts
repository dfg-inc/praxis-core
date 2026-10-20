import { describe, expect, it } from "vitest";
import {
  ActionPlanSchema,
  authorityProblems,
  authorizationMatches,
  buildActionPlan,
  decisionKindFor,
  assertExecutionPayload,
  approvedContentDigest,
  signAuthorization,
  verifyAuthorization,
  generateApprovalKeyPair,
  encodeAuthorization,
  type AuthorizationBody,
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

  it("a hand-written plan file that breaks the rules is rejected by the schema the broker parses with", () => {
    const good = buildActionPlan({ ...base, decisionKind: "development_action", operations: ["repository_edit"] });
    expect(ActionPlanSchema.safeParse(good).success).toBe(true);
    const crafted = { ...good, decisionKind: "story_behavior", operations: ["git_push", "git_commit"] };
    expect(ActionPlanSchema.safeParse(crafted).success).toBe(false);
  });
});

describe("the signed token binds the kind of decision", () => {
  const keys = generateApprovalKeyPair();
  const body = (decisionKind?: string): AuthorizationBody => ({
    contract: "praxis.approval.authorization",
    version: 1,
    planFingerprint: `sha256:${"ab".repeat(32)}`,
    provider: "jira",
    instanceId: "https://x.atlassian.net",
    operations: ["external_record_update"],
    workItemIds: ["PRX-1"],
    repositories: [],
    action: "praxis_ba_apply",
    approver: "owner",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumptionId: "c1",
    ...(decisionKind ? { decisionKind } : {}),
  });
  const target = {
    planFingerprint: `sha256:${"ab".repeat(32)}`,
    provider: "jira",
    instanceId: "https://x.atlassian.net",
    operation: "external_record_update",
    action: "praxis_ba_apply",
  };

  it("derives the kind from what is being done", () => {
    expect(decisionKindFor("git_push", "x")).toBe("git_operation");
    expect(decisionKindFor("external_record_update", "praxis_ba_apply")).toBe("issue_tracker_mutation");
    expect(decisionKindFor("external_state_change", "praxis_quality_apply")).toBe("quality_verdict");
    expect(decisionKindFor("external_state_change", "praxis_developer_claim")).toBe("development_action");
    expect(decisionKindFor("repository_edit", "praxis_workflow_apply")).toBe("development_action");
    expect(decisionKindFor("repository_edit", "praxis_workflow_apply", "story_behavior")).toBe("story_behavior");
  });

  it("a token for one kind of decision is refused for another", () => {
    expect(() => authorizationMatches(body("issue_tracker_mutation"), { ...target, decisionKind: "issue_tracker_mutation" })).not.toThrow();
    expect(() => authorizationMatches(body("issue_tracker_mutation"), { ...target, decisionKind: "quality_verdict" })).toThrow(
      /one kind of approval never authorizes another/,
    );
    expect(() => authorizationMatches(body("story_behavior"), { ...target, decisionKind: "issue_tracker_mutation" })).toThrow(/story_behavior/);
  });

  it("a token that names a kind cannot be used by a caller that does not state one", () => {
    expect(() => authorizationMatches(body("quality_verdict"), target)).toThrow(/unstated kind/);
  });

  it("the kind is signed: editing it invalidates the signature", () => {
    const token = encodeAuthorization(signAuthorization(body("issue_tracker_mutation"), keys.privateKeyPem));
    expect(verifyAuthorization(token, keys.publicKeyPem).decisionKind).toBe("issue_tracker_mutation");
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    parsed.body.decisionKind = "git_operation";
    const forged = Buffer.from(JSON.stringify(parsed)).toString("base64url");
    expect(() => verifyAuthorization(forged, keys.publicKeyPem)).toThrow();
  });
});

describe("the executor enforces the approved kind of decision", () => {
  const content = "approved content\n";
  const body = (decisionKind: string): AuthorizationBody => ({
    contract: "praxis.approval.authorization",
    version: 1,
    planFingerprint: `sha256:${"cd".repeat(32)}`,
    provider: "local",
    instanceId: "local",
    operations: ["repository_edit"],
    workItemIds: ["WI-1"],
    repositories: ["/repo"],
    action: "praxis_workflow_apply",
    approver: "owner",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumptionId: "c2",
    planId: "plan-1",
    targets: ["a.txt"],
    content,
    contentDigest: approvedContentDigest(content),
    decisionKind,
  });
  const payload = (extra: Record<string, unknown> = {}) => ({
    planId: "plan-1",
    planFingerprint: `sha256:${"cd".repeat(32)}`,
    provider: "local",
    instanceId: "local",
    operation: "repository_edit",
    action: "praxis_workflow_apply",
    workItemId: "WI-1",
    repository: "/repo",
    targets: ["a.txt"],
    contentDigest: approvedContentDigest(content),
    ...extra,
  });

  it("accepts the stated or derived kind and refuses a different one", () => {
    expect(() => assertExecutionPayload(payload(), body("development_action"), "praxis_workflow_apply")).not.toThrow();
    expect(() => assertExecutionPayload(payload({ decisionKind: "story_behavior" }), body("story_behavior"), "praxis_workflow_apply")).not.toThrow();
    expect(() => assertExecutionPayload(payload(), body("story_behavior"), "praxis_workflow_apply")).toThrow(/story_behavior/);
    expect(() =>
      assertExecutionPayload(payload({ decisionKind: "architecture_decision" }), body("development_action"), "praxis_workflow_apply"),
    ).toThrow(/development_action/);
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
