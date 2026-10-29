import { describe, expect, it } from "vitest";
import { submissionToCommands } from "./review-submission.js";
import { acceptanceStatus, applyWorkflowCommand, phaseGates, requirementsFingerprint, ReviewMarkSchema, WorkflowStateSchema, type WorkflowState } from "./index.js";

const T1 = new Date("2026-10-26T10:00:00.000Z");
const T2 = new Date("2026-10-26T11:00:00.000Z");
const T3 = new Date("2026-10-26T12:00:00.000Z");
const run = (state: WorkflowState | null, command: Record<string, unknown>, now: Date, channel?: { via: "html-review" }) => applyWorkflowCommand(state, command, { now, ...(channel ? { channel } : {}) }).state;
const AC2 = "REQ-ORD-002-AC-02";

function seeded(): WorkflowState {
  let s = run(null, { action: "open", projectId: "orders", title: "Orders", request: "r", mode: "guided" }, T1);
  s = run(s, { action: "add-requirement", id: "REQ-ORD-002", statement: "Export", acceptanceCriteria: ["Exports rows", "Export is limited to 10000 rows"] }, T1);
  return s;
}
const review = (s: WorkflowState) => s.requirements[0].acceptanceCriteria.find((c) => c.id === AC2)!.review;
const decide = (s: WorkflowState, ac: Record<string, unknown>, now: Date) =>
  run(s, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, ...ac }] }] }, now, { via: "html-review" });
const lastNote = (s: WorkflowState) => s.history[s.history.length - 1].note ?? "";

describe("a user's review remark is stored, dated per kind of change, and logged", () => {
  it("reject + comment stores the status, the reason, who and when", () => {
    const s = decide(seeded(), { status: "rejected", comment: "Не нравится решение" }, T2);
    expect(review(s)).toMatchObject({ status: "rejected", comment: "Не нравится решение", at: T2.toISOString(), via: "html-review", commentAt: T2.toISOString(), commentVia: "html-review" });
    expect(lastNote(s)).toContain(`${AC2} rejected`);
    expect(lastNote(s)).toContain(`${AC2} comment changed`);
    expect(lastNote(s)).not.toContain("marks only");
  });

  it("changing only the comment later does not look like a new status decision", () => {
    let s = decide(seeded(), { status: "rejected", comment: "first" }, T2);
    s = decide(s, { comment: "second thought" }, T3);
    expect(review(s)).toMatchObject({ status: "rejected", comment: "second thought", at: T2.toISOString(), commentAt: T3.toISOString() });
    expect(lastNote(s)).toContain("comment changed");
    expect(lastNote(s)).not.toContain("rejected");
  });

  it("the same status and remark sent again is a no-op: same state, same revision, no history line", () => {
    const first = decide(seeded(), { status: "rejected", comment: "x" }, T2);
    const again = decide(first, { status: "rejected", comment: "x" }, T3);
    expect(again).toBe(first);
    expect(review(again).at).toBe(T2.toISOString());
    expect(review(again).commentAt).toBe(T2.toISOString());
    expect(again.workItem.revision).toBe(first.workItem.revision);
    expect(again.history).toHaveLength(first.history.length);
  });


  it("a status change moves the decision time and keeps the comment", () => {
    let s = decide(seeded(), { status: "rejected", comment: "reason" }, T2);
    s = decide(s, { status: "accepted" }, T3);
    expect(review(s)).toMatchObject({ status: "accepted", comment: "reason", at: T3.toISOString(), commentAt: T2.toISOString() });
  });

  it("a comment on a pending or accepted criterion is kept; an empty comment clears it", () => {
    let s = decide(seeded(), { comment: "a question" }, T2);
    expect(review(s)).toMatchObject({ status: "pending", comment: "a question", commentAt: T2.toISOString() });
    expect(review(s).at).toBeUndefined(); // no decision was made
    s = decide(s, { status: "accepted" }, T3);
    expect(review(s)).toMatchObject({ status: "accepted", comment: "a question" });
    s = decide(s, { comment: "" }, T3);
    expect(review(s).comment).toBeUndefined();
    expect(lastNote(s)).toContain("comment cleared");
  });

  it("the agent can record a comment without a user decision; it is dated as a chat remark, not a decision", () => {
    const s = run(seeded(), { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, comment: "BA note" }] }] }, T2);
    expect(review(s)).toMatchObject({ status: "pending", comment: "BA note", commentVia: "chat" });
    expect(review(s).at).toBeUndefined();
  });

  it("the agent cannot replace or clear a remark the user wrote", () => {
    const s = decide(seeded(), { status: "rejected", comment: "user remark" }, T2);
    for (const comment of ["", "agent overwrite"]) {
      expect(() => run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, comment }] }] }, T3)).toThrow(/only the user changes or clears it/);
    }
    // proposing new text is still the agent's, and the remark survives as `previous`
    const edited = run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, statement: "Export is capped" }] }] }, T3);
    expect(edited.requirements[0].acceptanceCriteria[1].review.previous?.comment).toBe("user remark");
  });

  it("accept-all keeps a comment typed on a pending criterion", () => {
    let s = decide(seeded(), { comment: "keep me" }, T2);
    s = run(s, { action: "accept-requirements", via: "html-review" }, T3, { via: "html-review" });
    expect(review(s)).toMatchObject({ status: "accepted", comment: "keep me" });
  });

  it("a requirement comment and a scope note are logged too", () => {
    const s = run(seeded(), { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-002", comment: "overall", scopeNote: "later" }] }, T2, { via: "html-review" });
    expect(lastNote(s)).toContain("REQ-ORD-002 comment changed");
    expect(lastNote(s)).toContain("scope note changed");
    expect(s.requirements[0].comment).toBe("overall");
  });
});

describe("fingerprint: review marks and comments are not content", () => {
  it("rejecting, commenting and accepting leave the requirements fingerprint (and an acceptance bound to it) as it was", () => {
    let s = run(seeded(), { action: "accept-requirements", via: "html-review" }, T1, { via: "html-review" });
    const before = requirementsFingerprint(s);
    s = decide(s, { status: "rejected", comment: "no" }, T2);
    expect(requirementsFingerprint(s)).toBe(before);
    expect(acceptanceStatus(s, "requirements_review")).toBe("accepted");
    // ...but the gate to the next stage is shut while a criterion is rejected
    expect(JSON.stringify(phaseGates(s, "prototype"))).toContain("every criterion accepted");
  });
  it("a text edit does change it", () => {
    let s = seeded();
    const before = requirementsFingerprint(s);
    s = run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, statement: "Export is limited to 5000 rows" }] }] }, T2);
    expect(requirementsFingerprint(s)).not.toBe(before);
  });
});

describe("a targeted edit keeps the reason the user gave", () => {
  it("editing a rejected criterion resets it to pending and keeps the earlier decision and comment as `previous`", () => {
    let s = decide(seeded(), { status: "rejected", comment: "Не нравится решение" }, T2);
    s = run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, statement: "Export is limited to 5000 rows" }] }] }, T3);
    const r = review(s);
    expect(r.status).toBe("pending");
    expect(r.comment).toBeUndefined();
    expect(r.previous).toMatchObject({ status: "rejected", comment: "Не нравится решение", revision: 1 });
    // a second edit before any new decision keeps the original reason
    s = run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC2, statement: "Export is limited to 6000 rows" }] }] }, T3);
    expect(review(s).previous).toMatchObject({ status: "rejected", comment: "Не нравится решение" });
  });
});

describe("alpha.48 compatibility", () => {
  it("a mark stored by alpha.48 (status, comment, at, via only) still parses and is returned unchanged", () => {
    const old = { status: "rejected", comment: "old", at: T1.toISOString(), via: "html-review" };
    expect(ReviewMarkSchema.parse(old)).toEqual(old);
    const s = decide(seeded(), { status: "rejected", comment: "old" }, T1);
    const roundTrip = WorkflowStateSchema.parse(JSON.parse(JSON.stringify(s)));
    expect(roundTrip.requirements[0].acceptanceCriteria[1].review.comment).toBe("old");
  });
});

describe("two tabs of the same review: a stale save never overwrites fresher data", () => {
  const AC1 = "REQ-ORD-002-AC-01";
  const page = (state: WorkflowState, criteria: Array<Record<string, unknown>>) => ({
    contract: "praxis.review.submission",
    version: 1,
    reviewId: "r1",
    view: "requirements",
    workItemId: state.workItem.id,
    baseFingerprint: "old",
    requirements: { requirements: [{ id: "REQ-ORD-002", revision: state.requirements[0].revision, criteria, addCriteria: [], removeCriteria: [] }], acceptAll: false },
  });
  const plan = (state: WorkflowState, criteria: Array<Record<string, unknown>>) => submissionToCommands(state, page(state, criteria));
  const save = (state: WorkflowState, criteria: Array<Record<string, unknown>>) => {
    let s = state;
    for (const command of plan(state, criteria).commands) s = applyWorkflowCommand(s, command, { now: T3, channel: { via: "html-review" } }).state;
    return s;
  };

  it("tab B's comment is refused when tab A changed the remark after B was opened", () => {
    const opened = seeded(); // both tabs open here: the remark is empty
    const afterA = save(opened, [{ id: AC1, revision: 1, comment: "tab A's remark", fromComment: "" }]);
    expect(afterA.requirements[0].acceptanceCriteria[0].review.comment).toBe("tab A's remark");
    const bPlan = plan(afterA, [{ id: AC1, revision: 1, comment: "tab B's remark", fromComment: "" }]);
    expect(bPlan.commands).toHaveLength(0);
    expect(bPlan.conflicts[0].reason).toMatch(/remark changed since you opened this page.*reload/i);
    expect(save(afterA, [{ id: AC1, revision: 1, comment: "tab B's remark", fromComment: "" }]).requirements[0].acceptanceCriteria[0].review.comment).toBe("tab A's remark");
  });

  it("tab B's decision is refused when tab A decided differently; a repeat of the same decision is not a conflict", () => {
    const opened = seeded();
    const afterA = save(opened, [{ id: AC1, revision: 1, from: "pending", status: "rejected" }]);
    const b = plan(afterA, [{ id: AC1, revision: 1, from: "pending", status: "accepted" }]);
    expect(b.commands).toHaveLength(0);
    expect(b.conflicts[0].reason).toMatch(/already marked rejected since you opened this page.*reload/i);
    expect(save(afterA, [{ id: AC1, revision: 1, from: "pending", status: "accepted" }]).requirements[0].acceptanceCriteria[0].review.status).toBe("rejected");
  });

  it("an edit of the wording is refused when the criterion was reworded after the page was opened", () => {
    const opened = seeded();
    const afterA = applyWorkflowCommand(opened, { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-002", acceptance: [{ id: AC1, statement: "A's wording" }] }] }, { now: T2, channel: { via: "html-review" } }).state;
    const b = plan(afterA, [{ id: AC1, revision: 1, statement: "B's wording" }]);
    expect(b.commands).toHaveLength(0);
    expect(b.conflicts.length).toBeGreaterThan(0);
  });

  it("a save that touches other criteria still applies them and reports only the conflicting one", () => {
    const opened = seeded();
    const afterA = save(opened, [{ id: AC1, revision: 1, comment: "A", fromComment: "" }]);
    const b = save(afterA, [{ id: AC1, revision: 1, comment: "B", fromComment: "" }, { id: AC2, revision: 1, from: "pending", status: "accepted" }]);
    expect(b.requirements[0].acceptanceCriteria.map((c) => [c.review.status, c.review.comment])).toEqual([["pending", "A"], ["accepted", undefined]]);
  });
});

describe("stale saves of requirement-level remarks and whitespace in stored text", () => {
  it("a requirement remark from a page opened before the requirement changed is refused", () => {
    const opened = seeded();
    const changed = applyWorkflowCommand(opened, { action: "revise-requirement", id: "REQ-ORD-002", statement: "Export, reworded" }, { now: T2 }).state;
    const submission = {
      contract: "praxis.review.submission", version: 1, reviewId: "r", view: "requirements", workItemId: changed.workItem.id, baseFingerprint: "old",
      requirements: { requirements: [{ id: "REQ-ORD-002", revision: 1, comment: "stale remark", criteria: [], addCriteria: [], removeCriteria: [] }], acceptAll: false },
    };
    const plan = submissionToCommands(changed, submission);
    expect(plan.commands).toHaveLength(0);
    expect(plan.conflicts[0].reason).toMatch(/edited since you opened this page/);
  });

  it("a stored criterion with trailing whitespace is not 'edited' by the same text, and the repeat needs no approval", () => {
    let s = run(null, { action: "open", projectId: "o", title: "O", request: "r", mode: "guided" }, T1);
    s = run(s, { action: "add-requirement", id: "REQ-ORD-003", statement: "S", acceptanceCriteria: ["one "] }, T1);
    const same = applyWorkflowCommand(s, { action: "revise-acceptance", edits: [{ id: "REQ-ORD-003-AC-01", statement: "one " }] }, { now: T2 });
    expect(same.duplicate).toBe(true);
    expect(same.state).toBe(s);
  });
});
