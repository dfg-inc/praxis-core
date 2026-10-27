import { describe, expect, it } from "vitest";
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
