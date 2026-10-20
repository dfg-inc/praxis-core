import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  encodeAuthorization,
  exportWorkflowSnapshot,
  generateApprovalKeyPair,
  openLocalWorkflow,
  renderWorkflowSnapshotHtml,
  runAuthorizedMutation,
  signAuthorization,
  storyConfirmationDigest,
  storyContentFingerprint,
  type AuthorizationBody,
  assertSecureExecutor,
} from "./index.js";

const story = {
  id: "US-BETA-001" as const,
  requirementIds: ["REQ-BETA-001" as const],
  actor: "owner",
  narrative: "As a owner, I want the reviewed behavior, so that unseen stories stay unconfirmed.",
  objective: "Confirm only the reviewed story",
  userValue: "The owner sees the real behavior",
  happyPath: ["Read the story", "Approve that revision"],
  acceptanceCriteria: [
    {
      id: "US-BETA-001-AC-01",
      given: "a story the owner has not opened",
      when: "architecture decisions are approved",
      then: "confirmedBehavior stays false",
    },
  ],
  expectedResults: ["The story stays proposed"],
  confirmedBehavior: false,
};

function workflowWithStories() {
  let state = openLocalWorkflow({
    projectId: "beta",
    title: "Beta confirmation",
    request: "Reproduce the unseen story confirmation",
  });
  state = applyWorkflowCommand(state, {
    action: "add-requirement",
    id: "REQ-BETA-001",
    statement: "Stories stay unconfirmed until their own revision is approved.",
    acceptanceCriteria: ["The owner sees the story text."],
  }).state;
  for (let index = 1; index <= 4; index += 1) {
    state = applyWorkflowCommand(state, {
      action: "add-story",
      ...story,
      id: `US-BETA-00${index}`,
      acceptanceCriteria: [
        {
          ...story.acceptanceCriteria[0],
          id: `US-BETA-00${index}-AC-01`,
        },
      ],
    }).state;
  }
  for (let index = 1; index <= 11; index += 1) {
    state = applyWorkflowCommand(state, {
      action: "record-decision",
      id: `DEC-${String(index).padStart(3, "0")}`,
      statement: `Decision ${index}`,
      rationale: `rationale-${(index % 5) + 1}`,
      notes: index === 1 ? "decision note" : undefined,
    }).state;
  }
  return state;
}

describe("story confirmation", () => {
  it("does not confirm unseen stories when DEC-001 through DEC-011 are recorded", () => {
    const state = workflowWithStories();
    // Recording a decision never confirms it, and recording decisions never confirms a story.
    expect(state.decisions).toHaveLength(11);
    expect(state.decisions.filter((decision) => decision.confirmed)).toHaveLength(0);
    expect(state.stories).toHaveLength(4);
    expect(state.stories.every((item) => item.confirmedBehavior === false)).toBe(true);
    expect(state.stories.every((item) => item.status === "proposed")).toBe(true);
  });

  it("rejects a caller boolean on story creation", () => {
    const state = openLocalWorkflow({ projectId: "beta", title: "Reject flag", request: "no" });
    const withRequirement = applyWorkflowCommand(state, {
      action: "add-requirement",
      id: "REQ-BETA-001",
      statement: "No boolean shortcut.",
      acceptanceCriteria: ["The flag is rejected."],
    }).state;
    expect(() =>
      applyWorkflowCommand(withRequirement, { action: "add-story", ...story, confirmedBehavior: true }),
    ).toThrow(/cannot confirm/);
  });

  it("confirms only the signed story revision", () => {
    const keys = generateApprovalKeyPair();
    const previous = process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
    const previousPrivate = process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
    delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
    process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
    try {
      const state = workflowWithStories();
      const target = state.stories[0]!;
      const contentFingerprint = storyContentFingerprint(target);
      const body: AuthorizationBody = {
        contract: "praxis.approval.authorization",
        version: 1,
        planFingerprint: `sha256:${"ab".repeat(32)}`,
        provider: "local",
        instanceId: "local",
        operations: ["external_record_update"],
        workItemIds: [target.id],
        repositories: [],
        action: "confirm-story",
        approver: "owner@example.com",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        consumptionId: "story-confirm-1",
      };
      body.planFingerprint = storyConfirmationDigest({
        storyId: target.id,
        revision: target.revision,
        contentFingerprint,
      });
      const token = encodeAuthorization(signAuthorization(body, keys.privateKeyPem));
      const confirmed = applyWorkflowCommand(state, {
        action: "confirm-story",
        id: target.id,
        revision: target.revision,
        contentFingerprint,
        authorization: token,
      }).state;
      expect(confirmed.stories.filter((item) => item.confirmedBehavior)).toHaveLength(1);
      expect(confirmed.stories[0]?.confirmedBehavior).toBe(true);
      expect(confirmed.stories.slice(1).every((item) => item.confirmedBehavior === false)).toBe(true);
      const changed = {
        ...confirmed,
        stories: confirmed.stories.map((item, index) =>
          index === 0 ? { ...item, narrative: `${item.narrative} changed`, confirmedBehavior: true, status: "confirmed" as const } : item,
        ),
      };
      expect(() =>
        applyWorkflowCommand(changed, {
          action: "confirm-story",
          id: target.id,
          revision: target.revision,
          contentFingerprint,
          authorization: token,
        }),
      ).toThrow(/not the reviewed revision/);
    } finally {
      if (previous === undefined) delete process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
      else process.env.PRAXIS_APPROVAL_PUBLIC_KEY = previous;
      if (previousPrivate === undefined) delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
      else process.env.PRAXIS_APPROVAL_PRIVATE_KEY = previousPrivate;
    }
  });
});

describe("workflow snapshot", () => {
  it("round-trips decisions, questions, rationales, notes, risks, and blockers", () => {
    let state = workflowWithStories();
    state = applyWorkflowCommand(state, {
      action: "record-context",
      openQuestions: ["Who owns retries?", "Which tenant is in scope?"],
      risks: ["partial export"],
      blockers: ["missing owner"],
      notes: "beta notes stay",
    }).state;
    const snapshot = exportWorkflowSnapshot(state);
    const restored = JSON.parse(JSON.stringify(snapshot));
    expect(restored.decisions).toHaveLength(9 + 2);
    expect(restored.openQuestions).toEqual(["Who owns retries?", "Which tenant is in scope?"]);
    expect(new Set(restored.decisions.map((decision: { rationale?: string }) => decision.rationale)).size).toBe(5);
    expect(restored.notes).toBe("beta notes stay");
    expect(restored.risks).toEqual(["partial export"]);
    expect(restored.blockers).toEqual(["missing owner"]);
    const html = renderWorkflowSnapshotHtml(state);
    expect(html).toContain("Who owns retries?");
    expect(html).toContain("beta notes stay");
    expect(html).toContain("rationale-5");
    const handed = applyWorkflowCommand(state, {
      action: "handoff",
      sourceRole: "architect",
      targetRole: "developer",
      requirementIds: ["REQ-BETA-001"],
      readiness: "partial",
    }).state.handoffs.at(-1)!;
    expect(handed.decisionRecords).toHaveLength(11);
    expect(handed.openQuestions).toEqual(state.openQuestions);
    expect(handed.risks).toEqual(["partial export"]);
    expect(handed.notes).toBe("beta notes stay");
  });
});

describe("secure mutation mode", () => {
  const previousMode = process.env.PRAXIS_SECURITY_MODE;
  const previousAuth = process.env.PRAXIS_APPROVAL_AUTHORIZATION;
  const previousKey = process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
  const previousLedger = process.env.PRAXIS_APPROVAL_LEDGER;
  const previousPrivate = process.env.PRAXIS_APPROVAL_PRIVATE_KEY;

  // These tests run the broker and the verifier as one user in a temp dir, which a real deployment would
  // refuse. The override is explicit, reported by the deployment assessment, and test-only.
  beforeEach(() => {
    process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY = "1";
  });

  afterEach(() => {
    delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
    process.env.PRAXIS_SECURITY_MODE = previousMode;
    if (previousAuth === undefined) delete process.env.PRAXIS_APPROVAL_AUTHORIZATION;
    else process.env.PRAXIS_APPROVAL_AUTHORIZATION = previousAuth;
    if (previousKey === undefined) delete process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
    else process.env.PRAXIS_APPROVAL_PUBLIC_KEY = previousKey;
    if (previousLedger === undefined) delete process.env.PRAXIS_APPROVAL_LEDGER;
    else process.env.PRAXIS_APPROVAL_LEDGER = previousLedger;
    if (previousPrivate === undefined) delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
    else process.env.PRAXIS_APPROVAL_PRIVATE_KEY = previousPrivate;
  });

  it("regression: refuses a same-identity deployment instead of only reporting it", () => {
    // Original gap: assertSecureExecutor checked the signing key and Docker, but a trust anchor and ledger the
    // agent identity could rewrite were accepted, so the agent could sign its own approvals.
    delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
    process.env.PRAXIS_SECURITY_MODE = "secure";
    const keys = generateApprovalKeyPair();
    process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
    delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
    const repo = mkdtempSync(join(tmpdir(), "praxis-same-identity-"));
    process.env.PRAXIS_APPROVAL_LEDGER = join(tmpdir(), `praxis-ledger-${Date.now()}`);
    try {
      assertSecureExecutor(repo);
      throw new Error("expected refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("APPROVAL_ISOLATION_UNAVAILABLE");
      expect((error as Error).message).toMatch(/trust-anchor-unverifiable/);
      expect((error as Error).message).toMatch(/ledger-writable/);
    }
  });

  it("does not accept a JSON approval file in secure mode", () => {
    process.env.PRAXIS_SECURITY_MODE = "secure";
    delete process.env.PRAXIS_APPROVAL_AUTHORIZATION;
    const repo = mkdtempSync(join(tmpdir(), "praxis-secure-"));
    let wrote = false;
    expect(() =>
      runAuthorizedMutation(
        {
          repo,
          operation: "repository_edit",
          provider: "local",
          action: "praxis_developer_git_connect_apply",
          workItemId: "WP-1",
          repository: repo,
        },
        () => {
          wrote = true;
          return "no";
        },
      ),
    ).toThrow(/broker authorization|isolation|secure mode/i);
    expect(wrote).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  it("executes a signed authorization once and rejects a changed provider", () => {
    const keys = generateApprovalKeyPair();
    const repo = mkdtempSync(join(tmpdir(), "praxis-secure-ok-"));
    const ledger = mkdtempSync(join(tmpdir(), "praxis-ledger-"));
    process.env.PRAXIS_SECURITY_MODE = "secure";
    delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
    process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
    process.env.PRAXIS_APPROVAL_LEDGER = ledger;
    const body: AuthorizationBody = {
      contract: "praxis.approval.authorization",
      version: 1,
      planFingerprint: `sha256:${"cd".repeat(32)}`,
      provider: "local",
      instanceId: "local",
      operations: ["repository_edit"],
      workItemIds: ["WP-1"],
      repositories: [repo],
      action: "praxis_developer_git_connect_apply",
      approver: "owner@example.com",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumptionId: "once-1",
    };
    const token = encodeAuthorization(signAuthorization(body, keys.privateKeyPem));
    const request = {
      repo,
      authorization: token,
      planFingerprint: body.planFingerprint,
      instanceId: "local" as const,
      operation: "repository_edit" as const,
      provider: "local" as const,
      action: "praxis_developer_git_connect_apply",
      workItemId: "WP-1",
      repository: repo,
    };
    let calls = 0;
    const first = runAuthorizedMutation(request, () => {
      calls += 1;
      return { remote: "origin" };
    });
    const second = runAuthorizedMutation(request, () => {
      calls += 1;
      return { remote: "again" };
    });
    expect(first).toEqual({ remote: "origin" });
    expect(second).toEqual({ remote: "origin" });
    expect(calls).toBe(1);
    expect(() =>
      runAuthorizedMutation({ ...request, provider: "jira" }, () => {
        calls += 1;
        return { remote: "jira" };
      }),
    ).toThrow(/provider/i);
    expect(calls).toBe(1);
    process.env.PRAXIS_APPROVAL_PRIVATE_KEY = keys.privateKeyPem;
    expect(() => runAuthorizedMutation(request, () => "hidden")).toThrow(/signing key/i);
    rmSync(repo, { recursive: true, force: true });
    rmSync(ledger, { recursive: true, force: true });
  });
});
