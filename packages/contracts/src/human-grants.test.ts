import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  generateApprovalKeyPair,
  humanGrantContent,
  openLocalWorkflow,
  type WorkflowState,
} from "./index.js";
import { decisionGrant, grantToken, serviceGrant, storyGrant, useEphemeralBroker } from "./grant-test-helpers.js";

const REQ = "REQ-GRT-901" as const;
let broker: ReturnType<typeof useEphemeralBroker>;
beforeEach(() => {
  broker = useEphemeralBroker();
});
afterEach(() => broker.restore());

function base(): WorkflowState {
  let state = openLocalWorkflow({ projectId: "grt", title: "Grants", request: "Human grants" });
  state = applyWorkflowCommand(state, { action: "add-requirement", id: REQ, statement: "Grants bind content.", acceptanceCriteria: ["Bound."] }).state;
  state = applyWorkflowCommand(state, {
    action: "add-story",
    id: "US-GRT-001",
    requirementIds: [REQ],
    actor: "owner",
    narrative: "As a owner, I want grants bound, so that nothing else is approved.",
    objective: "Bound",
    userValue: "Safe",
    happyPath: ["review"],
    acceptanceCriteria: [{ id: "US-GRT-001-AC-01", given: "g", when: "w", then: "t" }],
    expectedResults: ["ok"],
    serviceIds: ["svc"],
    confirmedBehavior: false,
  }).state;
  state = applyWorkflowCommand(state, { action: "record-decision", id: "DEC-GRT-001", statement: "Bind content", rationale: "exact" }).state;
  state = applyWorkflowCommand(state, {
    action: "set-service",
    service: { id: "svc", name: "svc", kind: "module", responsibilities: ["x"], requirementIds: [REQ], dependsOn: [], status: "in_progress" },
  }).state;
  return state;
}

const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("confirm-story with a real-broker-shaped grant", () => {
  it("regression: a token that binds the story content (as a broker plan can) confirms that story revision", () => {
    // Original defect: only a token whose planFingerprint equalled a story digest verified, which no broker plan can produce.
    const state = base();
    const confirmed = applyWorkflowCommand(state, { action: "confirm-story", id: "US-GRT-001", ...storyGrant(state, "US-GRT-001", broker.keys.privateKeyPem) }).state;
    expect(confirmed.stories[0]).toMatchObject({ confirmedBehavior: true, status: "confirmed" });
  });

  it("refuses a grant for a different story, a changed story, an expired grant, another kind, or another key", () => {
    const state = base();
    const good = storyGrant(state, "US-GRT-001", broker.keys.privateKeyPem);
    const apply = (extra: Record<string, unknown>) => () =>
      applyWorkflowCommand(state, { action: "confirm-story", id: "US-GRT-001", ...good, ...extra } as never);
    const content = humanGrantContent("confirm-story", { storyId: "US-GRT-001", revision: 1, contentFingerprint: good.contentFingerprint });
    // wrong subject
    throwsCode(apply({ authorization: grantToken(broker.keys.privateKeyPem, { action: "confirm-story", targetId: "US-OTHER-001", content }) }), "APPROVAL_SCOPE_MISMATCH");
    // content for a different revision
    throwsCode(
      apply({ authorization: grantToken(broker.keys.privateKeyPem, { action: "confirm-story", targetId: "US-GRT-001", content: content.replace('"revision":1', '"revision":2') }) }),
      "APPROVAL_SCOPE_MISMATCH",
    );
    // expired
    throwsCode(apply({ authorization: grantToken(broker.keys.privateKeyPem, { action: "confirm-story", targetId: "US-GRT-001", content, ttlMs: -5000 }) }), "APPROVAL_EXPIRED");
    // a decision grant presented for a story
    throwsCode(apply({ authorization: grantToken(broker.keys.privateKeyPem, { action: "confirm-decision", targetId: "US-GRT-001", content }) }), "APPROVAL_SCOPE_MISMATCH");
    // right action, wrong kind of decision
    throwsCode(apply({ authorization: grantToken(broker.keys.privateKeyPem, { action: "confirm-story", targetId: "US-GRT-001", content, kind: "git_operation" }) }), "APPROVAL_SCOPE_SEPARATE");
    // signed by a key that is not the broker's
    const attacker = generateApprovalKeyPair();
    throwsCode(apply({ authorization: grantToken(attacker.privateKeyPem, { action: "confirm-story", targetId: "US-GRT-001", content }) }), "APPROVAL_REQUIRED");
  });

  it("a grant stops working once the story changes (the content no longer matches)", () => {
    const state = base();
    const grant = storyGrant(state, "US-GRT-001", broker.keys.privateKeyPem);
    const edited: WorkflowState = { ...state, stories: state.stories.map((story) => ({ ...story, narrative: `${story.narrative} (edited)` })) };
    expect(() => applyWorkflowCommand(edited, { action: "confirm-story", id: "US-GRT-001", ...grant })).toThrow(/not the reviewed revision/);
  });
});

describe("decisions", () => {
  it("regression: recording a decision never confirms it, even if the caller says so", () => {
    // Original gap: an agent could record confirmed:true, putting its own architecture decision on the record as approved.
    const state = base();
    throwsCode(() => applyWorkflowCommand(state, { action: "record-decision", id: "DEC-X", statement: "x", confirmed: true }), "DECISION_CONFIRMATION_REQUIRED");
    expect(state.decisions.find((d) => d.id === "DEC-GRT-001")?.confirmed).toBe(false);
  });

  it("confirm-decision with a grant for that exact revision confirms it; edited or other decisions do not", () => {
    const state = base();
    const grant = decisionGrant(state, "DEC-GRT-001", broker.keys.privateKeyPem);
    const confirmed = applyWorkflowCommand(state, { action: "confirm-decision", id: "DEC-GRT-001", ...grant }).state;
    expect(confirmed.decisions.find((d) => d.id === "DEC-GRT-001")?.confirmed).toBe(true);
    const edited = applyWorkflowCommand(state, { action: "record-decision", id: "DEC-GRT-001", statement: "Something else entirely", rationale: "exact" }).state;
    expect(() => applyWorkflowCommand(edited, { action: "confirm-decision", id: "DEC-GRT-001", ...grant })).toThrow(/revision|reviewed/);
    const second = applyWorkflowCommand(state, { action: "record-decision", id: "DEC-GRT-002", statement: "Another" }).state;
    // Decision 2's own revision and fingerprint, but decision 1's signed approval.
    const own = decisionGrant(second, "DEC-GRT-002", broker.keys.privateKeyPem);
    const other = decisionGrant(second, "DEC-GRT-001", broker.keys.privateKeyPem);
    throwsCode(
      () => applyWorkflowCommand(second, { action: "confirm-decision", id: "DEC-GRT-002", revision: own.revision, contentFingerprint: own.contentFingerprint, authorization: other.authorization }),
      "APPROVAL_SCOPE_MISMATCH",
    );
  });

  it("re-recording a decision resets it to unconfirmed", () => {
    const state = base();
    const confirmed = applyWorkflowCommand(state, { action: "confirm-decision", id: "DEC-GRT-001", ...decisionGrant(state, "DEC-GRT-001", broker.keys.privateKeyPem) }).state;
    const again = applyWorkflowCommand(confirmed, { action: "record-decision", id: "DEC-GRT-001", statement: "Changed", rationale: "exact" }).state;
    expect(again.decisions.find((d) => d.id === "DEC-GRT-001")?.confirmed).toBe(false);
  });
});

describe("approving a service", () => {
  const approved = (state: WorkflowState) => ({ ...state.services[0]!, status: "approved" as const });

  it("regression: an agent cannot mark a service approved or completed", () => {
    // Original gap: set-service accepted any status, so an agent could approve its own implementation.
    const state = base();
    throwsCode(() => applyWorkflowCommand(state, { action: "set-service", service: approved(state) }), "SERVICE_APPROVAL_REQUIRED");
    throwsCode(() => applyWorkflowCommand(state, { action: "set-service", service: { ...approved(state), status: "completed" } }), "SERVICE_APPROVAL_REQUIRED");
  });

  it("a grant for exactly this service as recorded approves it", () => {
    const state = base();
    const service = approved(state);
    const next = applyWorkflowCommand(state, { action: "set-service", service, authorization: serviceGrant(state, service, broker.keys.privateKeyPem) }).state;
    expect(next.services[0]?.status).toBe("approved");
  });

  it("the grant does not cover a changed service, another service, or the implementation changing underneath it", () => {
    let state = base();
    const service = approved(state);
    const grant = serviceGrant(state, service, broker.keys.privateKeyPem);
    throwsCode(
      () => applyWorkflowCommand(state, { action: "set-service", service: { ...service, responsibilities: ["x", "and a surprise"] }, authorization: grant }),
      "APPROVAL_SCOPE_MISMATCH",
    );
    state = applyWorkflowCommand(state, {
      action: "record-implementation",
      id: "IMPL-1",
      serviceId: "svc",
      requirementIds: [REQ],
      path: "src/a.ts",
      summary: "added after the grant was issued",
    }).state;
    throwsCode(() => applyWorkflowCommand(state, { action: "set-service", service, authorization: grant }), "APPROVAL_SCOPE_MISMATCH");
  });

  it("a story grant cannot approve a service, and a service grant cannot confirm a story", () => {
    const state = base();
    const service = approved(state);
    const storyToken = storyGrant(state, "US-GRT-001", broker.keys.privateKeyPem).authorization;
    throwsCode(() => applyWorkflowCommand(state, { action: "set-service", service, authorization: storyToken }), "APPROVAL_SCOPE_MISMATCH");
    const serviceToken = serviceGrant(state, service, broker.keys.privateKeyPem);
    const story = storyGrant(state, "US-GRT-001", broker.keys.privateKeyPem);
    throwsCode(() => applyWorkflowCommand(state, { action: "confirm-story", id: "US-GRT-001", revision: story.revision, contentFingerprint: story.contentFingerprint, authorization: serviceToken }), "APPROVAL_SCOPE_MISMATCH");
  });

  it("demoting a service, or re-setting an approved one unchanged, needs no grant", () => {
    const state = base();
    const service = approved(state);
    const done = applyWorkflowCommand(state, { action: "set-service", service, authorization: serviceGrant(state, service, broker.keys.privateKeyPem) }).state;
    expect(applyWorkflowCommand(done, { action: "set-service", service }).state.services[0]?.status).toBe("approved");
    expect(applyWorkflowCommand(done, { action: "set-service", service: { ...service, status: "in_progress" } }).state.services[0]?.status).toBe("in_progress");
  });
});

describe("grants are not trusted on a host that cannot isolate them", () => {
  it("regression: in secure mode, a grant is refused when the trust chain is within the agent's reach", () => {
    // Desktop style: the verifying key arrives through the environment and nothing shows the broker is separate.
    const state = base();
    const grant = storyGrant(state, "US-GRT-001", broker.keys.privateKeyPem);
    const previous = { mode: process.env.PRAXIS_SECURITY_MODE, override: process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY };
    process.env.PRAXIS_SECURITY_MODE = "secure";
    delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY;
    try {
      throwsCode(() => applyWorkflowCommand(state, { action: "confirm-story", id: "US-GRT-001", ...grant }), "APPROVAL_ISOLATION_UNAVAILABLE");
      process.env.PRAXIS_SECURITY_MODE = "compatibility";
      expect(applyWorkflowCommand(state, { action: "confirm-story", id: "US-GRT-001", ...grant }).state.stories[0]?.confirmedBehavior).toBe(true);
    } finally {
      if (previous.mode === undefined) delete process.env.PRAXIS_SECURITY_MODE;
      else process.env.PRAXIS_SECURITY_MODE = previous.mode;
      if (previous.override !== undefined) process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY = previous.override;
    }
  });
});
