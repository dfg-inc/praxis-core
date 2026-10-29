import { describe, expect, it } from "vitest";
import {
  applyWorkflowCommand,
  approvalFor,
  exportWorkflowSnapshot,
  openLocalWorkflow,
  renderWorkflowSnapshotHtml,
  storyContentFingerprint,
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
  let state = openLocalWorkflow({ mode: "classic",
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
    const state = openLocalWorkflow({ mode: "classic", projectId: "beta", title: "Reject flag", request: "no" });
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

  it("confirms only the approved story revision", () => {
    const state = workflowWithStories();
    const target = state.stories[0]!;
    const contentFingerprint = storyContentFingerprint(target);
    const command = { action: "confirm-story" as const, id: target.id, revision: target.revision, contentFingerprint };
    const approval = approvalFor(state, command);
    const confirmed = applyWorkflowCommand(state, command, approval).state;
    expect(confirmed.stories.filter((item) => item.confirmedBehavior)).toHaveLength(1);
    expect(confirmed.stories[0]?.confirmedBehavior).toBe(true);
    expect(confirmed.stories.slice(1).every((item) => item.confirmedBehavior === false)).toBe(true);
    // the same approval does not confirm a story whose content changed afterwards
    const changed = {
      ...confirmed,
      stories: confirmed.stories.map((item, index) =>
        index === 0 ? { ...item, narrative: `${item.narrative} changed`, confirmedBehavior: true, status: "confirmed" as const } : item,
      ),
    };
    expect(() => applyWorkflowCommand(changed, command, approval)).toThrow(/not the reviewed revision/);
  });

  it("an agent cannot confirm: no approval, a look-alike object, or an approval for another story is refused", () => {
    const state = workflowWithStories();
    const target = state.stories[0]!;
    const command = { action: "confirm-story" as const, id: target.id, revision: target.revision, contentFingerprint: storyContentFingerprint(target) };
    expect(() => applyWorkflowCommand(state, command)).toThrow(/needs the user's approval/);
    const forged = { ...approvalFor(state, command).userApproval };
    expect(() => applyWorkflowCommand(state, command, { userApproval: forged })).toThrow(/needs the user's approval/);
    expect(() => applyWorkflowCommand(state, { ...command, userApproval: forged })).toThrow();
    const other = state.stories[1]!;
    const otherCommand = { action: "confirm-story" as const, id: other.id, revision: other.revision, contentFingerprint: storyContentFingerprint(other) };
    expect(() => applyWorkflowCommand(state, command, approvalFor(state, otherCommand))).toThrow(/approval is for confirm-story|not for confirm-story/);
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
