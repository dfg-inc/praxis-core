import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, approvalFor, humanActRequest, approvalSummary, describeApproval, storyContentFingerprint, WorkflowStateSchema, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-28T10:00:00.000Z");

function base(): WorkflowState {
  let s = applyWorkflowCommand(null, { action: "open", projectId: "orders", title: "Audit", request: "Audit", mode: "guided" }, { now: NOW }).state;
  s = applyWorkflowCommand(s, { action: "add-requirement", id: "REQ-AUD-001", statement: "Statement", acceptanceCriteria: ["One", "Two"] }, { now: NOW }).state;
  return s;
}
function withStory(s: WorkflowState): WorkflowState {
  // classic path is not needed: put a proposed story straight into the state
  const classic = { ...s, mode: "classic" as const };
  const added = applyWorkflowCommand(classic, { action: "add-story", id: "US-AUD-001", requirementIds: ["REQ-AUD-001"], actor: "manager", narrative: "As a manager, I want to see, so that I know.", objective: "o", userValue: "v", happyPath: ["do"], acceptanceCriteria: [{ id: "REQ-AUD-001-AC-01", given: "g", when: "w", then: "t" }], expectedResults: ["done"], confirmedBehavior: false }, { now: NOW }).state;
  return { ...added, mode: "guided" };
}

describe("S11: a decision that needed a person is recorded with its channel and content", () => {
  it("confirm-story writes who/what/which revision and content/when/through which channel and what that channel proves", () => {
    process.env.PRAXIS_TEST_APPROVALS = "1";
    const s = withStory(base());
    const story = s.stories[0]!;
    const command = { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) };
    const confirmed = applyWorkflowCommand(s, command, { ...approvalFor(s, command), now: NOW }).state;
    expect(confirmed.approvals).toHaveLength(1);
    expect(confirmed.approvals[0]).toMatchObject({
      id: "APR-0001",
      action: "confirm-story",
      subjects: [{ type: "story", id: "US-AUD-001", revision: 1, contentFingerprint: storyContentFingerprint(story) }],
      channel: "test",
      trust: "test-only",
      workItemRevision: confirmed.workItem.revision,
    });
    expect(confirmed.approvals[0]!.subjectDigest).toMatch(/^sha256:/);
    expect(describeApproval({ channel: "test", assurance: "client-ui" })).toMatch(/TEST harness/);
  });

  it("a refused or agent-only command leaves no record, and an agent cannot put one in a command", () => {
    const s = withStory(base());
    const story = s.stories[0]!;
    const command = { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: storyContentFingerprint(story) };
    expect(() => applyWorkflowCommand(s, command, { now: NOW })).toThrow(/approval/);
    expect(() => applyWorkflowCommand(s, { ...command, approvals: [{ id: "APR-0001" }] } as never, { now: NOW })).toThrow();
    const noted = applyWorkflowCommand(s, { action: "log-session", summary: "x", role: "ba" }, { now: NOW }).state;
    expect(noted.approvals).toEqual([]);
  });

  it("a review decision saved from the page is recorded as review-page, not as a client dialog", () => {
    const s = base();
    const accepted = applyWorkflowCommand(s, { action: "accept-requirements", via: "html-review" }, { now: NOW, channel: { via: "html-review" } }).state;
    expect(accepted.approvals.at(-1)).toMatchObject({ action: "accept-requirements", channel: "html-review", assurance: "review-page", trust: "review-page" });
    expect(describeApproval("review-page")).toContain("the client did not vouch");
  });

  it("a state written before the record existed still parses, and its confirmed items are reported as unverified provenance", () => {
    const s = withStory(base());
    const legacy = { ...s, approvals: undefined, stories: s.stories.map((st) => ({ ...st, confirmedBehavior: true, status: "confirmed" as const })) };
    const parsed = WorkflowStateSchema.parse(JSON.parse(JSON.stringify(legacy)));
    expect(parsed.approvals).toEqual([]);
    expect(approvalSummary(parsed)).toMatchObject({ total: 0, unverifiedProvenance: ["story US-AUD-001"] });
  });
});

describe("S13: the revision and fingerprint come from a read, not from a failed attempt", () => {
  it("record-decision returns the revision and content fingerprint confirm-decision needs", () => {
    const s = base();
    const out = applyWorkflowCommand(s, { action: "record-decision", id: "DEC-1", statement: "One service", rationale: "simple" }, { now: NOW });
    const { revision, contentFingerprint } = out.result as { revision: number; contentFingerprint: string };
    expect(contentFingerprint).toMatch(/^sha256:/);
    expect(humanActRequest(out.state, { action: "confirm-decision", id: "DEC-1", revision, contentFingerprint })).not.toBeNull();
  });

  it("a wrong revision or fingerprint is refused when the act is previewed, and the message points at the read", () => {
    const s = applyWorkflowCommand(base(), { action: "record-decision", id: "DEC-1", statement: "One service", rationale: "simple" }, { now: NOW }).state;
    const d = s.decisions[0]!;
    expect(() => humanActRequest(s, { action: "confirm-decision", id: "DEC-1", revision: d.revision, contentFingerprint: `sha256:${"0".repeat(64)}` })).toThrow(/praxis_workflow_inspect \(view decisions\)/);
    expect(() => humanActRequest(s, { action: "confirm-decision", id: "DEC-1", revision: d.revision + 1, contentFingerprint: `sha256:${"0".repeat(64)}` })).toThrow(/DECISION_REVISION|revision/);
    const story = withStory(base()).stories[0]!;
    expect(() => humanActRequest(withStory(base()), { action: "confirm-story", id: story.id, revision: story.revision, contentFingerprint: `sha256:${"0".repeat(64)}` })).toThrow(/praxis_workflow_inspect \(view stories\)/);
  });
});
