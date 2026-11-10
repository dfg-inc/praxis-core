import { humanActApprovalRequest } from "./human-acts.js";
import { reviewApprovalRequest, type ReviewChannel } from "./planning.js";
import { createUserApproval, runApprovedMutation, type UserApproval } from "./user-approval.js";
import { applyWorkflowCommand, humanActRequest, parseWorkflowCommand, type WorkflowCommand, type WorkflowState } from "./workflow.js";

/**
 * Test-only: the approval a person would have given for this human act, as the Runtime would have built the request.
 * Works only under the test harness (PRAXIS_TEST_APPROVALS=1); production code never calls it.
 */
export function approvalFor(state: WorkflowState, command: WorkflowCommand | Record<string, unknown>): { userApproval: UserApproval } {
  const request = humanActRequest(state, command as WorkflowCommand);
  if (!request) throw new Error("not a human act");
  return { userApproval: createUserApproval({ request: humanActApprovalRequest(request), channel: "test" }) };
}

/** Test-only: runs `write` as if the user had approved `action`. Works only under the test harness. */
export function runApprovedForTest<T>(action: string, write: () => T): T {
  const approval = createUserApproval({
    request: { action, kind: "development_action", summary: action, description: action, subject: action },
    channel: "test",
  });
  return runApprovedMutation(approval, write);
}

/**
 * Test-only: the channel the Runtime passes once the client's dialog approved exactly these decisions. Recorded as the test
 * harness (never a person). Works only under the test harness.
 */
export function userChannelFor(...raw: Array<Record<string, unknown>>): ReviewChannel {
  // the Runtime approves the commands as parsed (defaults filled in); one that does not parse fails in the reducer itself
  const batch = raw.map((command) => {
    try {
      return parseWorkflowCommand(command) as unknown as Record<string, unknown>;
    } catch {
      return command;
    }
  });
  const approval = createUserApproval({ request: reviewApprovalRequest(batch, "decisions approved under the test harness"), channel: "test" });
  return { via: "approved", approval, batch };
}

/** Test-only: applies a command as the Runtime does once the client's dialog approved exactly that command. */
export function applyAsUser(state: WorkflowState | null, command: WorkflowCommand | Record<string, unknown>, options: { now?: Date } = {}) {
  return applyWorkflowCommand(state, command, { ...options, channel: userChannelFor(command as Record<string, unknown>) });
}
