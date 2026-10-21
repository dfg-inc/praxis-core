import { resolve } from "node:path";
import { ApprovalError, hasMutationLease, type ApprovalOperation } from "@praxis/contracts";

export { hasMutationLease };

/** What a local Git/delivery write is, for the error that explains why it did not run. */
export type LocalMutationRequest = {
  repo: string;
  operation: ApprovalOperation;
  provider: "local";
  workItemId: string;
  repository: string;
  action: string;
  previewFingerprint?: string;
};

export function localMutation(
  repo: string,
  spec: {
    action: string;
    operation: ApprovalOperation;
    workItemId: string;
    previewFingerprint?: string;
  },
): LocalMutationRequest {
  const root = resolve(repo);
  return {
    repo: root,
    operation: spec.operation,
    provider: "local",
    workItemId: spec.workItemId,
    repository: root,
    action: spec.action,
    ...(spec.previewFingerprint ? { previewFingerprint: spec.previewFingerprint } : {}),
  };
}

/**
 * A repository or delivery write runs only inside an approved action (the user's approval opens the lease in the
 * Praxis apply tool). Called any other way it refuses before anything changes.
 */
export function authorizeLocal<T>(request: LocalMutationRequest, write: () => T): T {
  if (hasMutationLease()) return write();
  throw new ApprovalError(
    "APPROVAL_REQUIRED",
    `${request.action} changes the repository and needs the user's approval: run it through its Praxis apply tool (preview, then approve). Nothing was changed.`,
  );
}
