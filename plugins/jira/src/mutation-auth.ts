import { resolve } from "node:path";
import { ApprovalError, hasMutationLease, type ApprovalOperation } from "@praxis/contracts";

export { hasMutationLease };

/** What a Jira write is, for the error that explains why it did not run. */
export type JiraMutationRequest = {
  repo: string;
  operation: ApprovalOperation;
  provider: "jira";
  instanceId?: string;
  workItemId: string;
  repository: string;
  action: string;
  previewFingerprint?: string;
};

export function jiraMutation(
  repo: string,
  spec: {
    action: string;
    operation: ApprovalOperation;
    workItemId: string;
    previewFingerprint?: string;
  },
): JiraMutationRequest {
  const root = resolve(repo);
  return {
    repo: root,
    operation: spec.operation,
    provider: "jira",
    instanceId: process.env.PRAXIS_JIRA_BASE_URL,
    workItemId: spec.workItemId,
    repository: root,
    action: spec.action,
    ...(spec.previewFingerprint ? { previewFingerprint: spec.previewFingerprint } : {}),
  };
}

/**
 * A Jira write runs only inside an approved action (the user's approval opens the lease in the Praxis apply tool).
 * Called any other way it refuses before anything is sent.
 */
export function authorizeJira<T>(request: JiraMutationRequest, write: () => T): T {
  if (hasMutationLease()) return write();
  throw new ApprovalError(
    "APPROVAL_REQUIRED",
    `${request.action} changes Jira and needs the user's approval: run it through its Praxis apply tool (preview, then approve). Nothing was sent.`,
  );
}
