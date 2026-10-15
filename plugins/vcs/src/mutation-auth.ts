import { resolve } from "node:path";
import {
  hasMutationLease,
  runAuthorizedMutation,
  type ApprovalOperation,
  type MutationRequest,
} from "@praxis/contracts";

export { hasMutationLease };

export function localMutation(
  repo: string,
  spec: {
    action: string;
    operation: ApprovalOperation;
    workItemId: string;
    previewFingerprint?: string;
  },
): MutationRequest {
  const root = resolve(repo);
  return {
    repo: root,
    operation: spec.operation,
    provider: "local",
    workItemId: spec.workItemId,
    repository: root,
    action: spec.action,
    ...(spec.previewFingerprint ? { previewFingerprint: spec.previewFingerprint } : {}),
    ...(process.env.PRAXIS_APPROVAL_AUTHORIZATION
      ? { authorization: process.env.PRAXIS_APPROVAL_AUTHORIZATION }
      : {}),
  };
}

export function authorizeLocal<T>(request: MutationRequest, write: () => T): T {
  if (hasMutationLease()) return write();
  return runAuthorizedMutation(request, write);
}
