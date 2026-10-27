import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, commandCatalog, parseWorkflowCommand, reviewProgress, type WorkflowState } from "./index.js";

const T1 = new Date("2026-10-26T10:00:00.000Z");
const T2 = new Date("2026-10-26T11:00:00.000Z");
const T3 = new Date("2026-10-26T12:00:00.000Z");
const run = (state: WorkflowState | null, command: Record<string, unknown>, now = T3, channel?: { via: "html-review" }) =>
  applyWorkflowCommand(state, command, { now, ...(channel ? { channel } : {}) });
const AC6 = "REQ-ORD-002-AC-06";
const AC5 = "REQ-ORD-005-AC-05";
const NEW6 = "В боковой панели отображается только текущий статус заказа. История изменений статуса в панели не выводится";
const NEW5 = "Для работы фильтра и карточки заказа используется текущее значение status. Данные истории смены статусов для этой функциональности не требуются";

/** Two requirements with six and five criteria; AC-06 and AC-05 rejected with a remark, the rest accepted by the user. */
function reviewed(): WorkflowState {
  let s = run(null, { action: "open", projectId: "orders", title: "Orders", request: "r", mode: "guided" }, T1).state;
  const six = (n: number) => Array.from({ length: n }, (_, i) => `criterion ${i + 1}`);
  s = run(s, { action: "add-requirement", id: "REQ-ORD-002", statement: "Side panel", acceptanceCriteria: six(6) }, T1).state;
  s = run(s, { action: "add-requirement", id: "REQ-ORD-005", statement: "Filter", acceptanceCriteria: six(5) }, T1).state;
  const marks = (req: string, n: number, rejected: string) => ({
    requirementId: req,
    acceptance: Array.from({ length: n }, (_, i) => {
      const id = `${req}-AC-${String(i + 1).padStart(2, "0")}`;
      return id === rejected ? { id, status: "rejected", comment: "Не нравится решение" } : { id, status: "accepted" };
    }),
  });
  return run(s, { action: "review-requirements", via: "html-review", decisions: [marks("REQ-ORD-002", 6, AC6), marks("REQ-ORD-005", 5, AC5)] }, T2, { via: "html-review" }).state;
}
const criteria = (s: WorkflowState) => s.requirements.flatMap((r) => r.acceptanceCriteria);
const ac = (s: WorkflowState, id: string) => criteria(s).find((c) => c.id === id)!;
const edit = { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }, { id: AC5, statement: NEW5 }] };

describe("revise-acceptance changes single criteria by their stable id", () => {
  it("raises only the edited criteria to r2, returns them to pending and keeps the rejection as previous", () => {
    const before = reviewed();
    const { state: after, duplicate, result } = run(before, edit);
    expect(duplicate).toBe(false);
    for (const id of [AC6, AC5]) {
      expect(ac(after, id)).toMatchObject({ revision: 2, review: { status: "pending", previous: { status: "rejected", comment: "Не нравится решение", revision: 1 } } });
    }
    expect(ac(after, AC6).statement).toBe(NEW6);
    expect(ac(after, AC5).statement).toBe(NEW5);
    // every other criterion is byte-for-byte what it was
    const untouched = criteria(before).filter((c) => c.id !== AC6 && c.id !== AC5);
    expect(untouched).toHaveLength(9);
    for (const c of untouched) expect(ac(after, c.id)).toEqual(c);
    expect((result as { changedRequirementIds: string[] }).changedRequirementIds.sort()).toEqual(["REQ-ORD-002", "REQ-ORD-005"]);
    expect((result as { acceptanceChanges: Array<{ id: string; before: { revision: number }; after: { revision: number; status: string } }> }).acceptanceChanges.map((c) => [c.id, c.before.revision, c.after.revision, c.after.status])).toEqual([
      [AC6, 1, 2, "pending"],
      [AC5, 1, 2, "pending"],
    ]);
    expect(after.history[after.history.length - 1].note).toContain(`${AC6} edited`);
    expect(reviewProgress(after)).toMatchObject({ pending: 2, rejected: 0, complete: false });
  });

  it("an accepted criterion can be reworded too: it goes back to pending and the acceptance stays readable as previous", () => {
    const { state } = run(reviewed(), { action: "revise-acceptance", edits: [{ id: "REQ-ORD-002-AC-01", statement: "reworded" }] });
    expect(ac(state, "REQ-ORD-002-AC-01")).toMatchObject({ revision: 2, review: { status: "pending", previous: { status: "accepted", revision: 1 } } });
    expect(ac(state, "REQ-ORD-002-AC-02").revision).toBe(1);
  });

  it("a second edit keeps the original decision as previous", () => {
    const once = run(reviewed(), { action: "revise-acceptance", edits: [{ id: AC6, statement: "second try" }] }).state;
    const twice = run(once, { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }] }).state;
    expect(ac(twice, AC6)).toMatchObject({ revision: 3, review: { status: "pending", previous: { status: "rejected", comment: "Не нравится решение" } } });
  });

  it("the same text again is a no-op: same state object, no revision, no history", () => {
    const edited = run(reviewed(), edit).state;
    const again = run(edited, edit);
    expect(again.duplicate).toBe(true);
    expect(again.state).toBe(edited);
    expect(again.state.history).toHaveLength(edited.history.length);
    expect(again.state.workItem.revision).toBe(edited.workItem.revision);
    expect((again.result as { noChange: boolean }).noChange).toBe(true);
  });

  it("only the criteria whose text differs change when one edit is a repeat", () => {
    const first = run(reviewed(), { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }] }).state;
    const { state } = run(first, edit);
    expect(ac(state, AC6).revision).toBe(2);
    expect(ac(state, AC5).revision).toBe(2);
    expect(ac(state, AC6).review.previous?.comment).toBe("Не нравится решение");
  });

  it("an unknown criterion, a repeated id and a changed revision are refused with a clear reason and change nothing", () => {
    const s = reviewed();
    expect(() => run(s, { action: "revise-acceptance", edits: [{ id: "REQ-ORD-002-AC-99", statement: "x" }] })).toThrow(/not an acceptance criterion/);
    expect(() => run(s, { action: "revise-acceptance", edits: [{ id: AC6, statement: "a" }, { id: AC6, statement: "b" }] })).toThrow(/edited twice/);
    expect(() => run(s, { action: "revise-acceptance", edits: [{ id: AC6, statement: "x", expectedRevision: 2 }] })).toThrow(/ACCEPTANCE_REVISION_CONFLICT|revision 1, not 2/);
    expect(() => run(s, { action: "revise-acceptance", edits: [] })).toThrow();
    // a partly bad command applies none of it
    expect(() => run(s, { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }, { id: "REQ-ORD-002-AC-99", statement: "x" }] })).toThrow();
  });

  it("expectedRevision matching the stored revision is accepted", () => {
    const { state } = run(reviewed(), { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6, expectedRevision: 1 }] });
    expect(ac(state, AC6).revision).toBe(2);
  });

  it("the requirement and the stories resting on it are marked changed, other requirements are not", () => {
    const before = reviewed();
    const { state } = run(before, { action: "revise-acceptance", edits: [{ id: AC6, statement: NEW6 }] });
    expect(state.requirements.find((r) => r.id === "REQ-ORD-002")!.revision).toBe(before.requirements.find((r) => r.id === "REQ-ORD-002")!.revision + 1);
    expect(state.requirements.find((r) => r.id === "REQ-ORD-005")).toEqual(before.requirements.find((r) => r.id === "REQ-ORD-005"));
  });
});

describe("parameters a command does not accept are refused, not dropped", () => {
  it("editAcceptance on review-requirements and revise-requirement names the key and points at revise-acceptance", () => {
    const s = reviewed();
    const bad = { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", editAcceptance: [{ id: AC6, statement: NEW6 }] }] };
    expect(() => run(s, bad)).toThrow(/UNKNOWN|"editAcceptance" is not a parameter/);
    try {
      run(s, bad);
    } catch (error) {
      expect((error as { code: string }).code).toBe("UNKNOWN_COMMAND_PARAMETER");
      expect((error as Error).message).toContain("revise-acceptance");
      expect((error as Error).message).toContain("accepted:");
    }
    expect(() => run(s, { action: "revise-requirement", id: "REQ-ORD-002", acceptanceId: AC6, statement: NEW6 })).toThrow(/"acceptanceId" is not a parameter/);
  });

  it("a misspelt top-level key is refused for any action", () => {
    expect(() => parseWorkflowCommand({ action: "revise-acceptance", edits: [{ id: AC6, statement: "x", status: "pending" }] })).toThrow(/"status" is not a parameter/);
    expect(() => parseWorkflowCommand({ action: "add-requirement", id: "REQ-A-001", statement: "s", acceptanceCriteria: ["a"], acceptence: [] })).toThrow(/"acceptence"/);
  });

  it("a valid command and a state object echoed into set-contract still parse", () => {
    expect(() => parseWorkflowCommand(edit)).not.toThrow();
    expect(() => parseWorkflowCommand({ action: "set-contract", contract: { id: "C-1", name: "c", providerServiceId: "a", consumerServiceIds: [], everAgreed: true, agreement: { via: "approved" } } })).not.toThrow();
  });

  it("the refused command changes nothing", () => {
    const s = reviewed();
    expect(() => run(s, { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-002", editAcceptance: [] }] })).toThrow();
    expect(criteria(s).find((c) => c.id === AC6)!.revision).toBe(1);
  });
});

describe("no-op commands change nothing", () => {
  it("review-requirements with identical statement, marks and remarks returns the same state and no history line", () => {
    const s = reviewed();
    const { state, duplicate, result } = run(s, { action: "review-requirements", via: "chat", decisions: [{ requirementId: "REQ-ORD-002", statement: s.requirements[0].statement, acceptance: [{ id: AC6, statement: ac(s, AC6).statement }] }] });
    expect(duplicate).toBe(true);
    expect(state).toBe(s);
    expect((result as { changedRequirementIds: string[]; noChange: boolean })).toMatchObject({ changedRequirementIds: [], noChange: true });
  });

  it("revise-requirement with the unchanged statement keeps the revision", () => {
    const s = reviewed();
    const { state, duplicate } = run(s, { action: "revise-requirement", id: "REQ-ORD-002", statement: s.requirements[0].statement });
    expect(duplicate).toBe(true);
    expect(state).toBe(s);
  });
});

describe("the command catalog tells an agent which command changes one criterion", () => {
  it("lists revise-acceptance with its fields and example, and points revise-requirement at it", () => {
    const catalog = commandCatalog();
    const entry = catalog.find((c) => c.action === "revise-acceptance")!;
    expect(entry.required).toEqual(["edits"]);
    expect(entry.userOnly).toBe(false);
    expect(entry.example).toBeDefined();
    expect(entry.use).toMatch(/stable id/);
    expect(catalog.find((c) => c.action === "revise-requirement")!.use).toMatch(/revise-acceptance/);
  });
});

describe("blank text and unchanged scope", () => {
  it("a blank statement is refused and trailing whitespace is not a change", () => {
    const s = reviewed();
    expect(() => run(s, { action: "revise-acceptance", edits: [{ id: AC6, statement: "   " }] })).toThrow();
    const same = run(s, { action: "revise-acceptance", edits: [{ id: AC6, statement: `${ac(s, AC6).statement}\n` }] });
    expect(same.duplicate).toBe(true);
    expect(same.state).toBe(s);
  });

  it("set-requirement-scope to the scope it already has is a no-op", () => {
    const s = reviewed();
    const r = run(s, { action: "set-requirement-scope", requirementIds: ["REQ-ORD-002"], scope: "in" });
    expect(r.duplicate).toBe(true);
    expect(r.state).toBe(s);
    const moved = run(s, { action: "set-requirement-scope", requirementIds: ["REQ-ORD-002"], scope: "deferred" });
    expect(moved.duplicate).toBe(false);
  });

  it("an edit on a superseded requirement's criterion is refused", () => {
    const s = reviewed();
    const gone = { ...s, requirements: s.requirements.map((r) => (r.id === "REQ-ORD-002" ? { ...r, status: "superseded" as const } : r)) };
    expect(() => run(gone, { action: "revise-acceptance", edits: [{ id: AC6, statement: "x" }] })).toThrow(/not an acceptance criterion/);
  });
});

