import { humanActApprovalRequest } from "./human-acts.js";
import { createUserApproval, runApprovedMutation, type UserApproval } from "./user-approval.js";
import { humanActRequest, type WorkflowCommand, type WorkflowState } from "./workflow.js";

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
