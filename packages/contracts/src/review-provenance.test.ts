import { beforeAll, describe, expect, it } from "vitest";
import { applyWorkflowCommand, createUserApproval, reviewApprovalRequest, reviewProgress, acceptanceStatus, type WorkflowState } from "./index.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
beforeAll(() => {
  process.env.PRAXIS_TEST_APPROVALS = "1";
});

function base(): WorkflowState {
  let s = applyWorkflowCommand(null, { action: "open", projectId: "p", title: "Orders", request: "r", mode: "guided" }, { now: NOW }).state;
  s = applyWorkflowCommand(s, { action: "add-requirement", id: "REQ-ORD-001", statement: "View orders", acceptanceCriteria: ["List shows orders"] }, { now: NOW }).state;
  return s;
}

describe("who may record that the user accepted something", () => {
  it("an agent command cannot accept, mark or agree, whatever via it claims", () => {
    const s = base();
    for (const command of [
      { action: "accept-requirements", via: "html-review" },
      { action: "review-requirements", via: "html-review", decisions: [{ requirementId: "REQ-ORD-001", acceptance: [{ id: "REQ-ORD-001-AC-01", status: "accepted" }] }] },
      { action: "accept-prototype", via: "html-review" },
      { action: "agree-story-plan", via: "html-review" },
      { action: "accept-stories", via: "html-review" },
      { action: "review-stories", via: "html-review", items: [] },
    ]) {
      expect(() => applyWorkflowCommand(s, command, { now: NOW }), command.action).toThrow(/cannot come from the agent|records that the user/);
    }
  });

  it("an agent can still edit requirements and comment on criteria", () => {
    const s = applyWorkflowCommand(base(), { action: "review-requirements", decisions: [{ requirementId: "REQ-ORD-001", statement: "View and filter orders", acceptance: [{ id: "REQ-ORD-001-AC-01", comment: "clarify paging" }] }] }, { now: NOW }).state;
    expect(s.requirements[0].revision).toBe(2);
    expect(s.requirements[0].acceptanceCriteria[0].review.status).toBe("pending");
  });

  it("the review page channel records via html-review, ignoring what the command says", () => {
    const s = applyWorkflowCommand(base(), { action: "accept-requirements", via: "system" }, { now: NOW, channel: { via: "html-review" } }).state;
    expect(s.phaseAcceptance.requirements_review?.via).toBe("html-review");
    expect(s.requirements[0].acceptanceCriteria[0].review.via).toBe("html-review");
    expect(acceptanceStatus(s, "requirements_review")).toBe("accepted");
  });

  it("decisions the user approved in the dialog are recorded as approved, and only those exact decisions", () => {
    const s = base();
    const batch = [{ action: "accept-requirements" }];
    const approval = createUserApproval({ request: reviewApprovalRequest(batch, "Accept requirements"), channel: "test" });
    const accepted = applyWorkflowCommand(s, batch[0], { now: NOW, channel: { via: "approved", approval, batch } }).state;
    expect(accepted.phaseAcceptance.requirements_review?.via).toBe("approved");
    expect(reviewProgress(accepted).complete).toBe(true);
    // a different command under the same approval is refused
    expect(() => applyWorkflowCommand(s, { action: "accept-prototype" }, { now: NOW, channel: { via: "approved", approval, batch } })).toThrow(/not part of what the user approved/);
    // an approval for other content is refused
    const other = createUserApproval({ request: reviewApprovalRequest([{ action: "accept-stories" }], "x"), channel: "test" });
    expect(() => applyWorkflowCommand(s, batch[0], { now: NOW, channel: { via: "approved", approval: other, batch } })).toThrow(/content differs|not for/);
  });

  it("an approval object that was not issued by the approval module is refused", () => {
    const s = base();
    const batch = [{ action: "accept-requirements" }];
    const fake = { contract: "praxis.approval.user", version: 1, action: "review-decisions", decision: "approved", subjectDigest: "x", decidedAt: NOW.toISOString() } as never;
    expect(() => applyWorkflowCommand(s, batch[0], { now: NOW, channel: { via: "approved", approval: fake, batch } })).toThrow(/needs the user's approval/);
  });
});
