import { describe, expect, it } from "vitest";
import { actionPlanFingerprint, buildActionPlan } from "./action-plan.js";
import {
  approvedContentDigest,
  assertExecutionPayload,
  authorizationMatches,
  executionRequestFingerprint,
} from "./broker.js";

function samplePlan(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return buildActionPlan({
    planId: "bind-1",
    role: "developer",
    decisionKind: "development_action",
    summary: "Create accepted.txt",
    provider: "local",
    instanceId: "local",
    operations: ["repository_edit"],
    workItemIds: ["WP-OK"],
    storyIds: [],
    decisionIds: [],
    repositories: ["/tmp/project"],
    actions: [
      {
        action: "praxis_workflow_apply",
        description: "create accepted.txt",
        targets: ["/tmp/project/accepted.txt"],
        content: "accepted-by-operator\n",
      },
    ],
    risks: [],
    sideEffects: ["writes accepted.txt"],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  });
}

describe("plan identity binding", () => {
  it("changes fingerprint when planId changes and content stays identical", () => {
    const a = samplePlan({ planId: "plan-a" });
    const b = samplePlan({
      planId: "plan-b",
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(actionPlanFingerprint({ ...a, fingerprint: undefined as never, planId: "plan-b" })).not.toBe(
      a.fingerprint,
    );
  });

  it("changes fingerprint when expiry changes and content stays identical", () => {
    const a = samplePlan();
    const b = samplePlan({
      planId: a.planId,
      createdAt: a.createdAt,
      expiresAt: new Date(Date.parse(a.expiresAt) + 1_000).toISOString(),
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("execution payload binding", () => {
  const body = {
    contract: "praxis.approval.authorization" as const,
    version: 1 as const,
    planId: "bind-1",
    planFingerprint: `sha256:${"ab".repeat(32)}`,
    provider: "local",
    instanceId: "local",
    operations: ["repository_edit"],
    workItemIds: ["WP-OK"],
    repositories: ["/tmp/project"],
    action: "praxis_workflow_apply",
    targets: ["/tmp/project/accepted.txt"],
    content: "accepted-by-operator\n",
    contentDigest: approvedContentDigest("accepted-by-operator\n"),
    approver: "owner",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumptionId: "c-bind-1",
  };

  const payload = {
    planId: body.planId,
    planFingerprint: body.planFingerprint,
    provider: body.provider,
    instanceId: body.instanceId,
    operation: "repository_edit",
    action: body.action,
    workItemId: "WP-OK",
    repository: "/tmp/project",
    targets: body.targets,
    contentDigest: body.contentDigest,
  };

  it("accepts the exact authorized payload", () => {
    const request = assertExecutionPayload(payload, body, "praxis_workflow_apply");
    expect(request.targets).toEqual(body.targets);
    expect(executionRequestFingerprint(request)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects extra payload fields", () => {
    expect(() =>
      assertExecutionPayload({ ...payload, shell: "rm -rf /" }, body, "praxis_workflow_apply"),
    ).toThrow(/unauthorized payload fields/);
  });

  it("rejects a missing mandatory field", () => {
    const { targets: _ignored, ...rest } = payload;
    expect(() => assertExecutionPayload(rest, body, "praxis_workflow_apply")).toThrow(/missing mandatory/);
  });

  it("rejects a changed target", () => {
    expect(() =>
      assertExecutionPayload(
        { ...payload, targets: ["/tmp/project/other.txt"] },
        body,
        "praxis_workflow_apply",
      ),
    ).toThrow(/targets/);
  });

  it("rejects a changed repository", () => {
    expect(() =>
      authorizationMatches(body, {
        ...payload,
        repository: "/tmp/other",
      }),
    ).toThrow(/repository/);
  });
});
