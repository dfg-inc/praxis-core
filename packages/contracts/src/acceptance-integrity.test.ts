import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptanceStatus,
  acceptanceSubjects,
  annotationOf,
  applyWorkflowCommand,
  approvalSummary,
  batchCoverage,
  buildResumeBriefing,
  currentFingerprint,
  enforcedMode,
  evaluateFeature,
  evaluateIntegrity,
  featureReadiness,
  humanActCoverage,
  integritySummary,
  nextStep,
  parseWorkflowCommand,
  phaseGates,
  planLedgerEntries,
  renderReview,
  requireIndependentVerification,
  reviewProgress,
  storyContentFingerprint,
  stripIntegrity,
  submissionToCommands,
  subjectKey,
  withIntegrity,
  WorkflowError,
  type ApprovalCoverage,
  type LedgerEntry,
  type LedgerReading,
  type WorkflowState,
  decisionContentFingerprint,
  reviewStamp,
  workStateStamp,
  fingerprintFor,
} from "./index.js";
import { approvalFor, userChannelFor } from "./human-act-testing.js";

/**
 * Acceptance integrity (R2), as the core sees it: the Runtime's store is simulated here exactly as workflow-store.ts does it
 * (read: annotate against the ledger; write: plan the ledger entries, append them, keep their actionIds next to the claims).
 * The file side and the ledger side are both plain data, so a forgery is a direct edit of the state, as T-repo would make it.
 */

const NOW = new Date("2026-11-12T10:00:00.000Z");

type World = { state: WorkflowState; ledger: LedgerEntry[] };
type Kind = "agent" | "user" | "act";

const read = (state: WorkflowState, ledger: LedgerEntry[] | LedgerReading): WorkflowState =>
  withIntegrity(state, evaluateIntegrity(state, Array.isArray(ledger) ? { status: "available", entries: ledger } : ledger));

/** What the store appends and writes after a reducer ran (workflow-store.ts recordDecisions). */
function commit(pre: WorkflowState | null, post: WorkflowState, ledger: LedgerEntry[], coverage: ApprovalCoverage | null): World {
  const planned = planLedgerEntries(pre, post, coverage);
  const written: LedgerEntry[] = planned.map((p, i) => ({
    v: 1,
    seq: ledger.length + i + 1,
    prev: "test",
    at: NOW.toISOString(),
    workItemId: post.workItem.id,
    subject: p.subject,
    contentDigest: p.contentDigest,
    decision: p.decision,
    actionId: randomUUID(),
    batchId: "batch",
    approval: coverage ? { action: "test", subjectDigest: "sha256:test", channel: "test", decidedBy: "test-harness", decidedAt: NOW.toISOString(), personVerified: false, independentlyVerified: false } : null,
    assurance: coverage ? "client-response" : "none",
  }));
  const claimed = new Set(acceptanceSubjects(post).filter((s) => s.claimed).map((s) => s.key));
  const actions: Record<string, string> = {};
  for (const [key, id] of Object.entries(post.acceptanceActions ?? {})) if (claimed.has(key)) actions[key] = id;
  for (const e of written) if (e.decision === "accept") actions[subjectKey(e.subject.kind, e.subject.id)] = e.actionId;
  const { acceptanceActions: _a, ...rest } = stripIntegrity(post);
  return { state: (Object.keys(actions).length ? { ...rest, acceptanceActions: actions } : rest) as WorkflowState, ledger: [...ledger, ...written] };
}

/** One call: read (annotated), apply as the agent, the user (an approved review batch) or a human act, write. */
function step(world: World, command: Record<string, unknown>, kind: Kind = "agent"): World {
  const pre = world.state.workItem ? read(world.state, world.ledger) : null;
  if (kind === "agent") return commit(pre, applyWorkflowCommand(pre, command, { now: NOW }).state, world.ledger, null);
  if (kind === "user") {
    const channel = userChannelFor(command);
    return commit(pre, applyWorkflowCommand(pre, command, { now: NOW, channel }).state, world.ledger, batchCoverage(channel.batch, pre));
  }
  const options = approvalFor(pre!, command);
  return commit(pre, applyWorkflowCommand(pre, command, { now: NOW, ...options }).state, world.ledger, humanActCoverage(options.userApproval.action, parseWorkflowCommand(command) as unknown as Record<string, unknown>));
}

function opened(): World {
  const state = applyWorkflowCommand(null, { action: "open", projectId: "orders", title: "Orders", request: "Managers view orders", mode: "guided" }, { now: NOW }).state;
  return commit(null, state, [], null);
}

const STORY = {
  action: "add-story",
  id: "US-ORD-001",
  requirementIds: ["REQ-ORD-001"],
  actor: "manager",
  narrative: "As a manager, I want to view orders, so that I can work.",
  objective: "see orders",
  userValue: "no manual lookup",
  happyPath: ["open the list"],
  acceptanceCriteria: [{ id: "US-ORD-001-AC-01", given: "orders exist", when: "the manager opens the list", then: "all orders are shown" }],
  expectedResults: ["the list is shown"],
  capabilities: ["view"],
  confirmedBehavior: false,
};

/** The legitimate flow: every acceptance made through the dialog, every one recorded in the ledger. Ends in development. */
function legitimate(): World {
  let w = opened();
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
    return (error as WorkflowError).code;
  }
  return undefined;
};

const allStatuses = (state: WorkflowState) => Object.values(annotationOf(state)?.subjects ?? {}).map((s) => s.status);

describe("the legitimate flow: every acceptance is recorded and every gate opens", () => {
  it("reaches development with every claim accepted and backed by its own ledger record", () => {
    const w = legitimate();
    const s = read(w.state, w.ledger);
    expect(integritySummary(s)).toEqual({ integrity: { accepted: expect.any(Number), unverified: 0, invalid: 0, stale: 0 }, independentVerification: "unavailable" });
    // each criterion has its own record, and the requirements review binds them (one batch of two criteria)
    const accepts = w.ledger.filter((e) => e.decision === "accept");
    expect(accepts.filter((e) => e.subject.kind === "criterion").map((e) => e.subject.id).sort()).toEqual(["REQ-ORD-001-AC-01", "REQ-ORD-001-AC-02"]);
    expect(new Set(accepts.map((e) => e.actionId)).size).toBe(accepts.length);
    for (const key of ["phase:requirements_review", "phase:story_plan", "phase:stories_review", "story:US-ORD-001", "decision:DEC-1", "contract:C-1", "waiver:W-001"]) expect(s.acceptanceActions?.[key], key).toBeTruthy();
    const advanced = step(w, { action: "advance-phase", to: "development" });
    expect(advanced.state.phase).toBe("development");
  });

  it("an agent's records never produce an acceptance record", () => {
    const w = legitimate();
    const agentOnly = step(w, { action: "record-context", notes: "n" });
    expect(agentOnly.ledger.length).toBe(w.ledger.length);
  });

  it("a state built in memory (no annotation) is trusted: only the store reads files, and it always annotates", () => {
    const s = legitimate().state;
    expect(annotationOf(s)).toBeUndefined();
    expect(phaseGates(s, "development").ok).toBe(true);
    expect(integritySummary(s).integrity.unverified).toBe(0);
  });
});

describe("a forged acceptance (T-repo writes the file, not the ledger) counts for nothing, and the gate says what and why", () => {
  // the claims of the legitimate flow, without the ledger that backs them: exactly what a repository-only attacker can produce
  const forged = () => read(legitimate().state, []);

  it("every forged claim reads unverified, and the development gate refuses with ACCEPTANCE_UNVERIFIED naming each subject", () => {
    const s = forged();
    expect(new Set(allStatuses(s))).toEqual(new Set(["unverified"]));
    const gate = phaseGates(s, "development");
    expect(gate.ok).toBe(false);
    expect(gate.integrity?.map((i) => i.subject)).toEqual(expect.arrayContaining(["phase:requirements_review", "phase:story_plan", "phase:stories_review", "story:US-ORD-001", "contract:C-1"]));
    expect(gate.missing.every((m) => m.startsWith("ACCEPTANCE_UNVERIFIED:"))).toBe(true);
    const err = (() => {
      try {
        applyWorkflowCommand(s, { action: "advance-phase", to: "development" }, { now: NOW });
      } catch (e) {
        return e as WorkflowError;
      }
      return null;
    })();
    expect(err?.code).toBe("ACCEPTANCE_UNVERIFIED");
    expect(err?.message).toMatch(/story US-ORD-001 confirmation is marked accepted in the work item file/);
  });

  it("criteria: the review is incomplete and the prototype gate refuses naming the criteria", () => {
    let w = opened();
    w = step(w, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view orders", acceptanceCriteria: ["The list shows all orders"] });
    const file = structuredClone(w.state);
    file.requirements[0]!.acceptanceCriteria[0]!.review = { status: "accepted", via: "approved", at: NOW.toISOString() };
    file.phaseAcceptance.requirements_review = { revision: 1, at: NOW.toISOString(), via: "approved", fingerprint: currentFingerprint(file, "requirements_review") };
    const s = read(file, w.ledger);
    expect(reviewProgress(s)).toMatchObject({ accepted: 0, pending: 1, unverifiedAcceptances: 1, complete: false });
    expect(acceptanceStatus(s, "requirements_review")).toBe("unverified");
    const gate = phaseGates(s, "prototype");
    expect(gate.integrity?.map((i) => i.subject).sort()).toEqual(["criterion:REQ-ORD-001-AC-01", "phase:requirements_review"]);
    expect(code(() => applyWorkflowCommand(s, { action: "advance-phase", to: "prototype" }, { now: NOW }))).toBe("ACCEPTANCE_UNVERIFIED");
  });

  it("an agreed story plan: detailed stories are refused with ACCEPTANCE_UNVERIFIED", () => {
    const w = legitimate();
    const s = read(w.state, w.ledger.filter((e) => e.subject.kind !== "phase" || e.subject.id !== "story_plan"));
    expect(code(() => applyWorkflowCommand(s, { ...STORY, id: "US-ORD-002" }, { now: NOW }))).toBe("ACCEPTANCE_UNVERIFIED");
  });

  it("a confirmed story: not confirmed for gates, verdicts or inspection", () => {
    const w = legitimate();
    const s = read(w.state, w.ledger.filter((e) => e.subject.kind !== "story"));
    expect(phaseGates(s, "development").integrity?.map((i) => i.subject)).toEqual(["story:US-ORD-001"]);
    expect(evaluateFeature(s).gaps.join(" ")).toMatch(/story-unconfirmed:US-ORD-001|US-ORD-001/);
    expect(approvalSummary(s).unverifiedProvenance).toEqual(["story US-ORD-001 confirmation: unverified"]);
  });

  it("a confirmed decision: unconfirmed in the briefing, the summary and the next handoff", () => {
    const w = legitimate();
    const s = read(w.state, w.ledger.filter((e) => e.subject.kind !== "decision"));
    expect(buildResumeBriefing(s).decisions).toEqual([expect.objectContaining({ id: "DEC-1", confirmed: false })]);
    expect(approvalSummary(s).unverifiedProvenance).toEqual(["decision DEC-1 confirmation: unverified"]);
    const handed = applyWorkflowCommand(s, { action: "handoff", sourceRole: "architect", targetRole: "developer", requirementIds: ["REQ-ORD-001"], readiness: "ready" }, { now: NOW }).state;
    expect(handed.handoffs.at(-1)!.decisionRecords).toEqual([expect.objectContaining({ id: "DEC-1", confirmed: false })]);
  });

  it("an approved service: not ready, and the feature verdict says the services are not approved", () => {
    const w = legitimate();
    const file = structuredClone(w.state);
    file.services[0]!.status = "approved";
    const s = read(file, w.ledger);
    expect(featureReadiness(s).ready).toBe(false);
    expect(evaluateFeature(s).readinessGaps).toContain("services are not approved");
    expect(stripIntegrity(s).services[0]!.status).toBe("approved"); // the file's own claim stays visible and is never erased
  });

  it("an agreed contract: the development gate refuses naming the contract", () => {
    const w = legitimate();
    const s = read(w.state, w.ledger.filter((e) => e.subject.kind !== "contract"));
    const gate = phaseGates(s, "development");
    expect(gate.integrity).toEqual([{ code: "ACCEPTANCE_UNVERIFIED", subject: "contract:C-1", status: "unverified" }]);
  });

  it("a waiver: it closes no gap; the story-plan gate names it", () => {
    const w = legitimate();
    const s = read(w.state, w.ledger.filter((e) => e.subject.kind !== "waiver"));
    const gate = phaseGates(s, "story_plan");
    expect(gate.integrity?.map((i) => i.subject)).toEqual(["waiver:W-001"]);
  });

  it("classic mode: the gates stay enforced", () => {
    const w = legitimate();
    const file = { ...structuredClone(w.state), mode: "classic" as const, phase: "request" as const };
    const s = read(file, w.ledger.filter((e) => e.subject.kind !== "story"));
    expect(enforcedMode(s)).toBe("guided");
    expect(code(() => applyWorkflowCommand(s, { action: "advance-phase", to: "delivery" }, { now: NOW }))).toBe("PHASE_GATE");
  });

  it("an approvals[] record in the file is not counted unless a ledger record carries the same approval", () => {
    const w = legitimate();
    const file = structuredClone(w.state);
    file.approvals = [...file.approvals, { id: "APR-9999", at: NOW.toISOString(), action: "confirm-story", subjects: [{ type: "story", id: "US-ORD-001" }], summary: "forged", subjectDigest: "sha256:forged", channel: "client-elicitation", assurance: "client-ui", trust: "client-response", workItemRevision: 1 }];
    const summary = approvalSummary(read(file, w.ledger));
    expect(summary.recordsWithoutLedger).toBeGreaterThanOrEqual(1);
    expect(summary.clientResponse).toBe(0);
  });
});

describe("the ledger contradicts the file: invalid", () => {
  it("replay: an actionId copied to another subject", () => {
    let w = opened();
    w = step(w, { action: "add-requirement", id: "REQ-ORD-001", statement: "Managers can view orders", acceptanceCriteria: ["The list shows all orders", "Each row shows the number"] });
    w = step(w, { action: "review-requirements", via: "approved", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }] }] }, "user");
    const file = structuredClone(w.state);
    file.requirements[0]!.acceptanceCriteria[1]!.review = { status: "accepted" };
    file.acceptanceActions = { ...file.acceptanceActions, "criterion:REQ-ORD-001-AC-02": file.acceptanceActions!["criterion:REQ-ORD-001-AC-01"]! };
    const s = read(file, w.ledger);
    expect(annotationOf(s)!.subjects["criterion:REQ-ORD-001-AC-01"]!.status).toBe("accepted");
    expect(annotationOf(s)!.subjects["criterion:REQ-ORD-001-AC-02"]).toMatchObject({ status: "invalid", reason: expect.stringMatching(/belongs to criterion:REQ-ORD-001-AC-01/) });
    expect(phaseGates(s, "prototype").integrity).toEqual(expect.arrayContaining([{ code: "ACCEPTANCE_INVALID", subject: "criterion:REQ-ORD-001-AC-02", status: "invalid" }]));
  });

  it("content edited after acceptance (the text changed, the claim and its id kept)", () => {
    const w = legitimate();
    const file = structuredClone(w.state);
    file.requirements[0]!.acceptanceCriteria[0]!.statement = "The list shows only paid orders";
    const s = read(file, w.ledger);
    expect(annotationOf(s)!.subjects["criterion:REQ-ORD-001-AC-01"]).toMatchObject({ status: "invalid", reason: expect.stringMatching(/content changed after it was accepted/) });
  });

  it("a recomputed fingerprint does not revive a phase acceptance over changed content", () => {
    const w = legitimate();
    const file = structuredClone(w.state);
    file.requirements[0]!.statement = "Managers can view and delete orders";
    file.phaseAcceptance.requirements_review = { ...file.phaseAcceptance.requirements_review!, fingerprint: currentFingerprint(file, "requirements_review") };
    const s = read(file, w.ledger);
    expect(annotationOf(s)!.subjects["phase:requirements_review"]!.status).toBe("invalid");
    expect(acceptanceStatus(s, "requirements_review")).toBe("invalid");
  });

  it("a duplicated record id, a corrupt ledger", () => {
    const w = legitimate();
    const twice = [...w.ledger, ...w.ledger.filter((e) => e.subject.kind === "story")];
    expect(annotationOf(read(w.state, twice))!.subjects["story:US-ORD-001"]!.status).toBe("invalid");
    expect(new Set(allStatuses(read(w.state, { status: "corrupt", reason: "line 3: the hash chain is broken" })))).toEqual(new Set(["invalid"]));
    expect(new Set(allStatuses(read(w.state, { status: "unavailable", reason: "EACCES" })))).toEqual(new Set(["unverified"]));
  });
});

describe("revoke and supersede: the latest decision wins", () => {
  it("a criterion the user reopens is revoked; the file rolled back to the accepted state reads invalid", () => {
    const before = legitimate();
    const reopened = step(before, { action: "review-requirements", via: "approved", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "pending" }] }] }, "user");
    expect(reopened.ledger.at(-1)).toMatchObject({ decision: "revoke", subject: { kind: "criterion", id: "REQ-ORD-001-AC-01" } });
    // git checkout of the earlier file: it still claims the acceptance, with the record id of the revoked acceptance
    const rolledBack = read(before.state, reopened.ledger);
    expect(annotationOf(rolledBack)!.subjects["criterion:REQ-ORD-001-AC-01"]).toMatchObject({ status: "invalid", reason: expect.stringMatching(/latest decision recorded for it is a revoke/) });
    // accepted again: a new record, and that one counts
    const again = step(reopened, { action: "review-requirements", via: "approved", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }] }] }, "user");
    expect(annotationOf(read(again.state, again.ledger))!.subjects["criterion:REQ-ORD-001-AC-01"]!.status).toBe("accepted");
  });

  it("a rejection is recorded as reject; a file still claiming the acceptance reads invalid", () => {
    const before = legitimate();
    const rejected = step(before, { action: "review-requirements", via: "approved", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-02", status: "rejected", comment: "not needed" }] }] }, "user");
    expect(rejected.ledger.at(-1)).toMatchObject({ decision: "reject", subject: { id: "REQ-ORD-001-AC-02" } });
    expect(annotationOf(read(before.state, rejected.ledger))!.subjects["criterion:REQ-ORD-001-AC-02"]!.status).toBe("invalid");
  });

  it("a revision supersedes: the story stays claimed for an earlier revision and reads stale, until it is confirmed again", () => {
    const before = legitimate();
    const revised = step(before, { action: "revise-requirement", id: "REQ-ORD-001", statement: "Managers can view all orders" });
    expect(revised.ledger.filter((e) => e.decision === "supersede").map((e) => e.subject.kind)).toContain("story");
    const s = read(revised.state, revised.ledger);
    expect(annotationOf(s)!.subjects["story:US-ORD-001"]!.status).toBe("stale");
    expect(phaseGates(s, "development").missing.join(" ")).toMatch(/US-ORD-001 still needs it/);
    const story = s.stories[0]!;
    const confirmed = step(revised, { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) }, "act");
    expect(annotationOf(read(confirmed.state, confirmed.ledger))!.subjects["story:US-ORD-001"]!.status).toBe("accepted");
  });

  it("returning to an earlier phase revokes the later phase acceptances", () => {
    let w = legitimate();
    w = step(w, { action: "return-to-phase", to: "story_plan", reason: "rethink" });
    expect(w.ledger.filter((e) => e.decision === "revoke").map((e) => e.subject.id)).toContain("stories_review");
  });
});

describe("the write path", () => {
  it("never records an acceptance without an approval of this call, nor one the approval does not cover", () => {
    const w = legitimate();
    const pre = read(w.state, []);
    // the forged claims are in pre and post alike: an agent write and an unrelated approval leave them unverified
    const post = applyWorkflowCommand(pre, { action: "record-context", notes: "x" }, { now: NOW }).state;
    expect(planLedgerEntries(pre, post, null).filter((p) => p.decision === "accept")).toEqual([]);
    expect(planLedgerEntries(pre, post, { covers: () => true }).filter((p) => p.decision === "accept")).toEqual([]);
    // a claim written straight into the state is not "made in this call": it still has its integrity entry
    const forgedPost = structuredClone(post);
    forgedPost.decisions[0]!.confirmed = true;
    expect(planLedgerEntries(pre, withIntegrity(forgedPost, annotationOf(pre)!), { covers: () => true }).filter((p) => p.decision === "accept")).toEqual([]);
  });

  it("refuses a write from a state the store did not check against the ledger", () => {
    const w = legitimate();
    expect(code(() => planLedgerEntries(w.state, w.state, null))).toBe("DECISION_LEDGER_UNAVAILABLE");
  });

  it("a batch covers what its commands name; a human act covers its own target only", () => {
    const w = legitimate();
    const pre = read(w.state, w.ledger);
    const accept = batchCoverage([{ action: "accept-requirements", via: "approved" }], pre);
    expect(accept.covers("criterion:REQ-ORD-001-AC-01")).toBe(true);
    expect(accept.covers("story:US-ORD-001")).toBe(false);
    expect(humanActCoverage("confirm-story", { action: "confirm-story", id: "US-ORD-001" }).covers("story:US-ORD-001")).toBe(true);
    expect(humanActCoverage("confirm-story", { action: "confirm-story", id: "US-ORD-001" }).covers("decision:DEC-1")).toBe(false);
    expect(humanActCoverage("confirm-decision", { action: "confirm-story", id: "US-ORD-001" }).covers("story:US-ORD-001")).toBe(false);
  });
});

describe("a 0.1.0-alpha.49.2 work item: its acceptances read unverified, and the normal review restores them", () => {
  /** What 49.2 wrote: the same claims, no acceptanceActions, and no ledger. */
  const legacy = (): World => {
    const { acceptanceActions: _a, ...file } = legitimate().state;
    return { state: file as WorkflowState, ledger: [] };
  };

  it("shows every acceptance unverified; the review page shows the criteria undecided and says why", () => {
    const w = legacy();
    const s = read(w.state, w.ledger);
    expect(integritySummary(s).integrity.unverified).toBeGreaterThan(5);
    expect(nextStep(s).blockers.join(" ")).toMatch(/not backed by a Praxis decision record/);
    const html = renderReview(s, "requirements");
    expect(html).toMatch(/data-initial-status="pending"/);
    expect(html).not.toMatch(/data-initial-status="accepted"/);
    expect(html).toMatch(/not backed by a Praxis decision record on this computer/);
  });

  it("accept-all shows every criterion in full in the dialog, records one ledger entry per criterion with one batch id, and the gates open", () => {
    let w = legacy();
    const s = read(w.state, w.ledger);
    const submission = { contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: s.workItem.id, baseFingerprint: fingerprintFor(s, "requirements"), baseStamp: reviewStamp(s, "requirements"), baseState: workStateStamp(s), requirements: { requirements: [], acceptAll: true } };
    const plan = submissionToCommands(s, submission);
    expect(plan.conflicts).toEqual([]);
    expect(plan.details.join("\n")).toContain("REQ-ORD-001-AC-01 (REQ-ORD-001, revision 1): 'The list shows all orders'");
    expect(plan.details.join("\n")).toContain("REQ-ORD-001-AC-02 (REQ-ORD-001, revision 1): 'Each row shows the order number'");
    const before = w.ledger.length;
    for (const command of plan.commands) w = step(w, command, "user");
    const recorded = w.ledger.slice(before).filter((e) => e.decision === "accept");
    expect(recorded.map((e) => e.subject.id).sort()).toEqual(["REQ-ORD-001-AC-01", "REQ-ORD-001-AC-02", "requirements_review"]);
    expect(new Set(recorded.map((e) => e.batchId)).size).toBe(1);
    const after = read(w.state, w.ledger);
    expect(reviewProgress(after).complete).toBe(true);
    expect(acceptanceStatus(after, "requirements_review")).toBe("accepted");
    expect(phaseGates(after, "prototype").ok).toBe(true);
  });

  it("every other kind is restored through its own normal decision", () => {
    let w = legacy();
    w = step(w, { action: "accept-requirements", via: "approved" }, "user");
    w = step(w, { action: "waive-coverage", kind: "prototype", reason: "a backend change: nothing to click" }, "user");
    w = step(w, { action: "agree-story-plan", via: "approved" }, "user");
    w = step(w, { action: "accept-stories", via: "approved" }, "user");
    const story = w.state.stories[0]!;
    w = step(w, { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) }, "act");
    const decision = w.state.decisions[0]!;
    w = step(w, { action: "confirm-decision", id: decision.id, revision: decision.revision, contentFingerprint: decisionContentFingerprint(decision) }, "act");
    w = step(w, { action: "set-contract", via: "approved", contract: { id: "C-1", name: "Orders list", providerServiceId: "api", consumerServiceIds: [], status: "agreed" } }, "user");
    const s = read(w.state, w.ledger);
    // the old waiver stays in the file (unverified, never erased); the new one counts
    expect(Object.values(annotationOf(s)!.subjects).filter((x) => x.status !== "accepted").map((x) => x.key)).toEqual(["waiver:W-001"]);
    expect(phaseGates(s, "development").ok).toBe(true);
    expect(step(w, { action: "advance-phase", to: "development" }).state.phase).toBe("development");
  });

  it("a service approved in 49.2 is approved again through its own dialog, with the same content", () => {
    let w = legitimate();
    w = step(w, { action: "set-service", service: { ...w.state.services[0]!, status: "approved" } }, "act");
    const forgotten = { state: w.state, ledger: w.ledger.filter((e) => e.subject.kind !== "service") };
    const pre = read(forgotten.state, forgotten.ledger);
    expect(featureReadiness(pre).ready).toBe(false);
    const again = step(forgotten, { action: "set-service", service: { ...pre.services[0]! } }, "act");
    expect(featureReadiness(read(again.state, again.ledger)).ready).toBe(true);
  });
});

describe("no acceptance is independently verified in this release", () => {
  it("nothing evaluates to independently-verified, and asking for it fails closed", () => {
    const w = legitimate();
    for (const ledger of [w.ledger, [] as LedgerEntry[]]) expect(allStatuses(read(w.state, ledger))).not.toContain("independently-verified");
    expect(integritySummary(read(w.state, w.ledger)).independentVerification).toBe("unavailable");
    expect(code(() => requireIndependentVerification("delivery"))).toBe("INDEPENDENT_AUTHORITY_UNAVAILABLE");
  });
});
