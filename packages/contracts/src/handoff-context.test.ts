import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  openLocalWorkflow,
  RoleHandoffSchema,
  type WorkflowState,
} from "./index.js";

const REQ = "REQ-HOF-901" as const;

function base(): WorkflowState {
  const state = openLocalWorkflow({ projectId: "hof", title: "Handoff", request: "Carry context" });
  return applyWorkflowCommand(state, {
    action: "add-requirement",
    id: REQ,
    statement: "Context survives handoffs.",
    acceptanceCriteria: ["Context is carried."],
  }).state;
}

function handoff(state: WorkflowState, sourceRole: "ba" | "architect" | "developer" | "quality", targetRole: "ba" | "architect" | "developer" | "quality", extra: Record<string, unknown> = {}) {
  return applyWorkflowCommand(state, {
    action: "handoff",
    sourceRole,
    targetRole,
    requirementIds: [REQ],
    readiness: "ready",
    ...extra,
  });
}

function seeded(): WorkflowState {
  return handoff(base(), "ba", "architect", {
    risks: ["RISK-A"],
    openQuestions: ["Q-A"],
    blockers: ["B-A"],
    assumptions: ["AS-A"],
    notes: "N-A",
  }).state;
}

describe("handoff context carry-forward", () => {
  it("regression: BA context reaches Architect, Developer and Quality handoffs", () => {
    // Original defect: hop 2 and hop 3 had empty risks/questions/blockers and no notes.
    let state = seeded();
    state = handoff(state, "architect", "developer", { nextActions: ["build"] }).state;
    state = handoff(state, "developer", "quality").state;
    for (const hop of state.handoffs) {
      expect(hop.risks, hop.handoffId).toEqual(["RISK-A"]);
      expect(hop.openQuestions, hop.handoffId).toEqual(["Q-A"]);
      expect(hop.blockers, hop.handoffId).toEqual(["B-A"]);
      expect(hop.assumptions, hop.handoffId).toEqual(["AS-A"]);
      expect(hop.notes, hop.handoffId).toBe("N-A");
    }
  });

  it("adds new items without duplicating carried ones", () => {
    const state = handoff(seeded(), "architect", "developer", { risks: ["RISK-A", "RISK-B"] }).state;
    expect(state.handoffs[1]?.risks).toEqual(["RISK-A", "RISK-B"]);
  });

  it("resolved items are dropped from the next handoff, recorded, and kept in history", () => {
    const state = handoff(seeded(), "architect", "developer", { resolved: ["Q-A", "B-A"] }).state;
    const next = state.handoffs[1]!;
    expect(next.openQuestions).toEqual([]);
    expect(next.blockers).toEqual([]);
    expect(next.risks).toEqual(["RISK-A"]);
    expect(next.resolved).toEqual(["Q-A", "B-A"]);
    expect(state.handoffs[0]?.openQuestions).toEqual(["Q-A"]);
    const later = handoff(state, "developer", "quality").state.handoffs[2]!;
    expect(later.openQuestions).toEqual([]);
    expect(later.resolved).toEqual([]);
  });

  it("only carries from a handoff addressed to the new source role", () => {
    // Developer never received a handoff, so nothing is inherited from the BA to Architect hop.
    const state = handoff(seeded(), "developer", "quality").state;
    expect(state.handoffs[1]?.risks).toEqual([]);
    expect(state.handoffs[1]?.notes).toBeUndefined();
  });

  it("replaying an identical command is still detected as a duplicate", () => {
    const first = handoff(seeded(), "architect", "developer", { nextActions: ["build"] });
    expect(first.duplicate).toBe(false);
    const replay = handoff(first.state, "architect", "developer", { nextActions: ["build"] });
    expect(replay.duplicate).toBe(true);
    expect(replay.state.handoffs).toHaveLength(2);
  });

  it("handoffs persisted before `resolved` existed still parse and keep their fingerprint", () => {
    const original = seeded().handoffs[0]!;
    const { resolved: _resolved, ...legacy } = original;
    const parsed = RoleHandoffSchema.parse(legacy);
    expect(parsed.resolved).toEqual([]);
    expect(parsed.fingerprint).toBe(original.fingerprint);
    // No resolved list supplied: the hashed body must not include the field.
    const withoutResolved = handoff(base(), "ba", "architect", {
      risks: ["RISK-A"],
      openQuestions: ["Q-A"],
      blockers: ["B-A"],
      assumptions: ["AS-A"],
      notes: "N-A",
    }).state.handoffs[0]!;
    expect(withoutResolved.fingerprint).toBe(original.fingerprint);
  });

  it("preserves decision records and revision metadata on every hop", () => {
    let state = applyWorkflowCommand(base(), {
      action: "record-decision",
      id: "DEC-HOF-901",
      statement: "Carry forward",
      rationale: "history",
      notes: "decision note",
    }).state;
    state = handoff(state, "ba", "architect", { risks: ["RISK-A"] }).state;
    state = handoff(state, "architect", "developer").state;
    for (const [index, hop] of state.handoffs.entries()) {
      expect(hop.decisionRecords).toEqual([
        expect.objectContaining({ id: "DEC-HOF-901", rationale: "history", notes: "decision note", revision: state.decisions[0]!.revision }),
      ]);
      expect(hop.revision).toBe(index + 1);
    }
  });
});
