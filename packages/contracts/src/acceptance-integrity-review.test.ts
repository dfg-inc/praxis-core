import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptanceSubjects,
  analyzeStoryCoverage,
  annotationOf,
  applyWorkflowCommand,
  batchCoverage,
  contentDigest,
  decisionContentFingerprint,
  evaluateIntegrity,
  humanActCoverage,
  integrityReport,
  nextStep,
  parseWorkflowCommand,
  phaseContent,
  phaseGates,
  planLedgerEntries,
  reviewApprovalRequest,
  storyContent,
  storyContentFingerprint,
  stripIntegrity,
  subjectKey,
  trustedView,
  withIntegrity,
  WorkflowStateSchema,
  createUserApproval,
  type ApprovalCoverage,
  type LedgerEntry,
  type WorkflowState,
} from "./index.js";
import { approvalFor, userChannelFor } from "./human-act-testing.js";

/**
 * Regression tests for the independent review of R2 (0.1.0-alpha.49.3), from its scratch probes (zz-review.test.ts): each probe
 * there showed the weakness; here the same scenario must be refused. The store is simulated as in acceptance-integrity.test.ts.
 */

const NOW = new Date("2026-11-12T10:00:00.000Z");
type World = { state: WorkflowState; ledger: LedgerEntry[] };
const read = (state: WorkflowState, ledger: LedgerEntry[]): WorkflowState => withIntegrity(state, evaluateIntegrity(state, { status: "available", entries: ledger }));

type Given = { action: string; subjectDigest: string; decidedAt: string };
function commit(pre: WorkflowState | null, post: WorkflowState, ledger: LedgerEntry[], coverage: ApprovalCoverage | null, given?: Given): World {
  const planned = planLedgerEntries(pre, post, coverage);
  const written: LedgerEntry[] = planned.map((p, i) => ({ v: 1, seq: ledger.length + i + 1, prev: "t", at: NOW.toISOString(), workItemId: post.workItem.id, subject: p.subject, contentDigest: p.contentDigest, decision: p.decision, actionId: randomUUID(), batchId: "b", approval: coverage ? { action: given?.action ?? "t", subjectDigest: given?.subjectDigest ?? "sha256:t", channel: "test", decidedBy: "test-harness", decidedAt: given?.decidedAt ?? NOW.toISOString(), personVerified: false, independentlyVerified: false } : null, assurance: coverage ? "client-response" : "none" }));
  const claimed = new Set(acceptanceSubjects(post).filter((s) => s.claimed).map((s) => s.key));
  const actions: Record<string, string> = {};
  for (const [key, id] of Object.entries(post.acceptanceActions ?? {})) if (claimed.has(key)) actions[key] = id;
  for (const e of written) if (e.decision === "accept") actions[subjectKey(e.subject.kind, e.subject.id)] = e.actionId;
  const { acceptanceActions: _a, ...rest } = stripIntegrity(post);
  return { state: (Object.keys(actions).length ? { ...rest, acceptanceActions: actions } : rest) as WorkflowState, ledger: [...ledger, ...written] };
}

function step(world: World, command: Record<string, unknown>, kind: "agent" | "user" | "act" = "agent"): World {
  const pre = world.state.workItem ? read(world.state, world.ledger) : null;
  if (kind === "agent") return commit(pre, applyWorkflowCommand(pre, command, { now: NOW }).state, world.ledger, null);
  if (kind === "user") {
    const channel = userChannelFor(command);
    return commit(pre, applyWorkflowCommand(pre, command, { now: NOW, channel }).state, world.ledger, batchCoverage(channel.batch, pre), channel.approval);
  }
  const options = approvalFor(pre!, command);
  return commit(pre, applyWorkflowCommand(pre, command, { now: NOW, ...options }).state, world.ledger, humanActCoverage(options.userApproval.action, parseWorkflowCommand(command) as unknown as Record<string, unknown>), options.userApproval);
}

const STORY = { action: "add-story", id: "US-ORD-001", requirementIds: ["REQ-ORD-001"], actor: "manager", narrative: "As a manager, I want to view orders, so that I can work.", objective: "see orders", userValue: "no manual lookup", happyPath: ["open the list"], acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "orders exist", when: "the manager opens the list", then: "all orders are shown" }], expectedResults: ["the list is shown"], capabilities: ["view"], confirmedBehavior: false };

function legitimate(): World {
  let w = commit(null, applyWorkflowCommand(null, { action: "open", projectId: "orders", title: "Orders", request: "Managers view orders", mode: "guided" }, { now: NOW }).state, [], null);
  w = step(w, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view orders", acceptanceCriteria: ["The list shows all orders", "Each row shows the order number"] });
  w = step(w, { action: "accept-requirements", via: "approved" }, "user");
  w = step(w, { action: "advance-phase", to: "prototype" });
  w = step(w, { action: "waive-coverage", kind: "prototype", reason: "a backend change: nothing to click" }, "user");
  w = step(w, { action: "set-story-plan", entries: [{ id: "US-ORD-001", title: "See orders", implementation: "Order list", userGets: "a list of orders", requirementIds: ["REQ-ORD-001"], acIds: ["REQ-ORD-001-AC-01", "REQ-ORD-001-AC-02"], capabilities: ["view"] }] });
  w = step(w, { action: "agree-story-plan", via: "approved" }, "user");
  w = step(w, { action: "advance-phase", to: "story_plan" });
  w = step(w, STORY);
  w = step(w, { action: "advance-phase", to: "stories_review" });
  w = step(w, { action: "review-stories", via: "approved", acceptStories: [{ storyId: "US-ORD-001", revision: 1 }] }, "user");
  w = step(w, { action: "accept-stories", via: "approved" }, "user");
  const story = w.state.stories[0]!;
  w = step(w, { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) }, "act");
  w = step(w, { action: "advance-phase", to: "architecture" });
  w = step(w, { action: "set-service", service: { id: "api", name: "Orders API", kind: "api", localPath: ".", responsibilities: ["serve orders"], requirementIds: ["REQ-ORD-001"], dependsOn: [], status: "in_progress" } });
  w = step(w, { action: "record-decision", id: "DEC-1", statement: "One list endpoint", rationale: "simple" });
  const decision = w.state.decisions[0]!;
  w = step(w, { action: "confirm-decision", id: decision.id, revision: decision.revision, contentFingerprint: decisionContentFingerprint(decision) }, "act");
  w = step(w, { action: "set-contract", contract: { id: "C-1", name: "Orders list", providerServiceId: "api", consumerServiceIds: [] } });
  w = step(w, { action: "set-contract", via: "approved", contract: { id: "C-1", name: "Orders list", providerServiceId: "api", consumerServiceIds: [], status: "agreed" } }, "user");
  return w;
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe("finding 1 (HIGH): a duplicated subject id makes every copy invalid", () => {
  /** The reviewer's probe: a forged contract, decision and waiver with the ids of genuine ones, placed before them. */
  function duplicated(): { w: World; s: WorkflowState } {
    const w = legitimate();
    const legit = w.state;
    const forgedContract = { ...legit.contracts[0]!, name: "FORGED: send orders to partner", consumerServiceIds: ["evil"] };
    const forgedDecision = { ...legit.decisions[0]!, statement: "FORGED: skip auth on the list endpoint" };
    const forgedWaiver = { ...legit.waivers[0]!, kind: "requirement-without-story", requirementId: "REQ-ORD-001", reason: "FORGED" };
    const file = WorkflowStateSchema.parse(JSON.parse(JSON.stringify({ ...legit, contracts: [forgedContract, ...legit.contracts], decisions: [forgedDecision, ...legit.decisions], waivers: [forgedWaiver, ...legit.waivers] })));
    return { w, s: read(file as WorkflowState, w.ledger) };
  }

  it("no copy counts: the trusted view takes every copy back and the development gate refuses with ACCEPTANCE_INVALID", () => {
    const { s } = duplicated();
    for (const key of ["contract:C-1", "decision:DEC-1", "waiver:W-001"]) {
      expect(annotationOf(s)!.subjects[key]).toMatchObject({ status: "invalid", duplicate: true, reason: expect.stringMatching(/duplicate id/) });
    }
    const t = trustedView(s);
    expect(t.contracts.map((c) => c.status)).toEqual(["proposed", "proposed"]);
    expect(t.decisions.map((d) => d.confirmed)).toEqual([false, false]);
    expect(t.waivers).toEqual([]);
    expect(analyzeStoryCoverage(s).waived).toEqual([]);
    const gate = phaseGates(s, "development");
    expect(gate.ok).toBe(false);
    expect(gate.integrity).toEqual(expect.arrayContaining([{ code: "ACCEPTANCE_INVALID", subject: "contract:C-1", status: "invalid" }]));
    // the forged waiver no longer opens story_plan either
    expect(phaseGates(s, "story_plan").ok).toBe(false);
    // and a handoff carries no confirmed copy
    const handed = applyWorkflowCommand(s, { action: "handoff", sourceRole: "architect", targetRole: "developer", requirementIds: ["REQ-ORD-001"], readiness: "ready" }, { now: NOW }).state;
    expect(handed.handoffs.at(-1)!.decisionRecords.every((d) => !d.confirmed)).toBe(true);
  });

  it("a decision made in a call does not clear a duplicate, and no acceptance is recorded for a duplicated id", () => {
    const { w, s } = duplicated();
    const forged = s.decisions[0]!;
    const command = { action: "confirm-decision", id: forged.id, revision: forged.revision, contentFingerprint: decisionContentFingerprint(forged) };
    const post = applyWorkflowCommand(s, command, { now: NOW, ...approvalFor(s, command) }).state;
    expect(annotationOf(post)!.subjects["decision:DEC-1"]!.status).toBe("invalid");
    expect(trustedView(post).decisions.every((d) => !d.confirmed)).toBe(true);
    expect(planLedgerEntries(s, post, humanActCoverage("confirm-decision", command)).filter((p) => p.decision === "accept")).toEqual([]);
    expect(w.ledger.length).toBeGreaterThan(0);
  });
});

describe("finding 2 (MEDIUM): an approval binds the content the ledger records", () => {
  it("confirm-story: the dialog's approval of A does not verify against B where only fields the old fingerprint left out changed", () => {
    let w = legitimate();
    w = step(w, { action: "revise-requirement", id: "REQ-ORD-001", statement: "Managers can view all orders" });
    const pre = read(w.state, w.ledger);
    const story = pre.stories[0]!;
    const command = { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) };
    const options = approvalFor(pre, command); // what the dialog showed (A)
    // while the dialog was open the file became B: same revision and fingerprint, other business rules and steps
    const tampered = read({ ...stripIntegrity(pre), stories: pre.stories.map((s) => (s.id === story.id ? { ...s, businessRules: ["FORGED: admins skip the permission check"], happyPath: ["FORGED step"] } : s)) } as WorkflowState, w.ledger);
    expect(storyContentFingerprint(tampered.stories[0]!)).toBe(storyContentFingerprint(story));
    expect(code(() => applyWorkflowCommand(tampered, command, { now: NOW, ...options }))).toBe("APPROVAL_SCOPE_MISMATCH");
  });

  it("confirm-decision, approve-service and revise-acceptance bind their ledger content digests too", () => {
    const w = legitimate();
    const pre = read(w.state, w.ledger);
    const service = { ...pre.services[0]!, status: "approved" as const };
    const approve = { action: "set-service", service };
    const options = approvalFor(pre, approve);
    const otherResponsibilities = read({ ...stripIntegrity(pre), services: [{ ...pre.services[0]!, responsibilities: ["serve orders", "export everything"] }] } as WorkflowState, w.ledger);
    expect(code(() => applyWorkflowCommand(otherResponsibilities, { action: "set-service", service: { ...service, responsibilities: ["serve orders", "export everything"] } }, { now: NOW, ...options }))).toBe("APPROVAL_SCOPE_MISMATCH");
    const rewording = { action: "revise-acceptance", edits: [{ id: "REQ-ORD-001-AC-01", statement: "The list shows the orders of the region" }] };
    const reworded = approvalFor(pre, rewording);
    const changedRevision = read({ ...stripIntegrity(pre), requirements: pre.requirements.map((r) => ({ ...r, acceptanceCriteria: r.acceptanceCriteria.map((c) => (c.id === "REQ-ORD-001-AC-01" ? { ...c, revision: 7 } : c)) })) } as WorkflowState, w.ledger);
    expect(code(() => applyWorkflowCommand(changedRevision, rewording, { now: NOW, ...reworded }))).toBe("APPROVAL_SCOPE_MISMATCH");
  });

  it("a review batch approved for one state does not apply to another: the approval binds the base state", () => {
    const w = legitimate();
    const pre = read(w.state, w.ledger);
    const batch = [parseWorkflowCommand({ action: "accept-requirements", via: "approved" }) as unknown as Record<string, unknown>];
    const approval = createUserApproval({ request: reviewApprovalRequest(batch, "accept", "state-A"), channel: "test" });
    expect(applyWorkflowCommand(pre, batch[0]!, { now: NOW, channel: { via: "approved", approval, batch, baseState: "state-A" } }).state).toBeTruthy();
    expect(code(() => applyWorkflowCommand(pre, batch[0]!, { now: NOW, channel: { via: "approved", approval, batch, baseState: "state-B" } }))).toBe("APPROVAL_SCOPE_MISMATCH");
    expect(code(() => applyWorkflowCommand(pre, batch[0]!, { now: NOW, channel: { via: "approved", approval, batch } }))).toBe("APPROVAL_SCOPE_MISMATCH");
  });
});

describe("finding 3 (MEDIUM): branches and worktrees share the ledger; only the person takes content back", () => {
  it("a revision an agent makes on another branch leaves this branch's unchanged acceptances accepted, and its gate open", () => {
    const main = legitimate();
    const branch = step(main, { action: "revise-requirement", id: "REQ-ORD-001", statement: "Managers can view all orders" });
    expect(branch.ledger.slice(main.ledger.length).every((e) => e.decision === "supersede")).toBe(true);
    const s = read(main.state, branch.ledger);
    expect(Object.values(annotationOf(s)!.subjects).filter((x) => x.status !== "accepted")).toEqual([]);
    expect(phaseGates(s, "development").ok).toBe(true);
    // the branch's own revised story reads stale until it is confirmed again
    expect(annotationOf(read(branch.state, branch.ledger))!.subjects["story:US-ORD-001"]!.status).toBe("stale");
  });

  it("a rewording the person approved (revise-acceptance) takes the old wording back everywhere: the restored file reads invalid, without accusation", () => {
    const before = legitimate();
    const reworded = step(before, { action: "revise-acceptance", edits: [{ id: "REQ-ORD-001-AC-01", statement: "The list shows the orders of the manager's region" }] }, "act");
    expect(reworded.ledger.slice(before.ledger.length).map((e) => `${e.decision}:${e.subject.id}`)).toEqual(expect.arrayContaining(["revoke:REQ-ORD-001-AC-01", "revoke:requirements_review"]));
    const restored = read(before.state, reworded.ledger);
    expect(annotationOf(restored)!.subjects["criterion:REQ-ORD-001-AC-01"]).toMatchObject({ status: "invalid", reason: expect.stringMatching(/a later decision on this computer, on any branch or worktree, took this content back/) });
    expect(annotationOf(restored)!.subjects["phase:requirements_review"]!.status).toBe("invalid");
    expect(code(() => applyWorkflowCommand(restored, { action: "advance-phase", to: "development" }, { now: NOW }))).toBe("ACCEPTANCE_INVALID");
    // the other criterion was not taken back
    expect(annotationOf(restored)!.subjects["criterion:REQ-ORD-001-AC-02"]!.status).toBe("accepted");
  });

  it("a rejection by the person takes that content back on every branch", () => {
    const before = legitimate();
    const rejected = step(before, { action: "review-requirements", via: "approved", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-02", status: "rejected" }] }] }, "user");
    expect(annotationOf(read(before.state, rejected.ledger))!.subjects["criterion:REQ-ORD-001-AC-02"]!.status).toBe("invalid");
  });
});

describe("finding 4 (LOW): title and capabilities are bound", () => {
  it("are part of the story's and the stories review's ledger content", () => {
    const s = legitimate().state;
    const story = s.stories[0]!;
    expect(contentDigest(storyContent({ ...story, capabilities: ["view", "delete"] }))).not.toBe(contentDigest(storyContent(story)));
    expect(contentDigest(storyContent({ ...story, title: "Other" }))).not.toBe(contentDigest(storyContent(story)));
    const withDelete = { ...s, stories: [{ ...story, capabilities: ["view", "delete"] as typeof story.capabilities }] };
    expect(contentDigest(phaseContent(withDelete, "stories_review"))).not.toBe(contentDigest(phaseContent(s, "stories_review")));
  });
});

describe("finding 5 (LOW): a pre-49.3 waiver waived again stops blocking, and is never trusted", () => {
  it("the blocker clears; W-001 stays unverified in the report", () => {
    const w = legitimate();
    const { acceptanceActions: _a, ...legacy } = w.state;
    let world: World = { state: legacy as WorkflowState, ledger: [] };
    world = step(world, { action: "waive-coverage", kind: "prototype", reason: "a backend change: nothing to click" }, "user");
    for (const command of [{ action: "accept-requirements", via: "approved" }, { action: "agree-story-plan", via: "approved" }, { action: "accept-stories", via: "approved" }, { action: "set-contract", via: "approved", contract: { id: "C-1", name: "Orders list", providerServiceId: "api", consumerServiceIds: [], status: "agreed" } }]) world = step(world, command, "user");
    let pre = read(world.state, world.ledger);
    const story = pre.stories[0]!;
    world = step(world, { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) }, "act");
    pre = read(world.state, world.ledger);
    const decision = pre.decisions[0]!;
    world = step(world, { action: "confirm-decision", id: decision.id, revision: decision.revision, contentFingerprint: decisionContentFingerprint(decision) }, "act");
    const after = read(world.state, world.ledger);
    expect(integrityReport(after).filter((x) => x.kind === "waiver").map((x) => [x.id, x.status])).toEqual([["W-001", "unverified"], ["W-002", "accepted"]]);
    expect(nextStep(after).blockers.join(" ")).not.toMatch(/not backed/);
    expect(trustedView(after).waivers.map((x) => x.id)).toEqual(["W-002"]);
  });
});

describe("finding 6 (LOW): a copied approvals[] record must match action and subjects", () => {
  it("a genuine record copied to another subject or action reads unverified", () => {
    const w = legitimate();
    const genuine = w.state.approvals.find((r) => r.action === "confirm-story")!;
    expect(annotationOf(read(w.state, w.ledger))!.records[genuine.id]).toBe("accepted");
    const file = structuredClone(w.state);
    file.approvals.push({ ...genuine, id: "APR-9001", subjects: [{ type: "story", id: "US-ORD-999" }] });
    file.approvals.push({ ...genuine, id: "APR-9002", action: "confirm-decision", subjects: [{ type: "decision", id: "DEC-1" }] });
    const records = annotationOf(read(file, w.ledger))!.records;
    expect([records["APR-9001"], records["APR-9002"]]).toEqual(["unverified", "unverified"]);
  });
});
