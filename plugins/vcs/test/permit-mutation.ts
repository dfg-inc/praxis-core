import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { installHostApproval, type ApprovalOperation } from "@praxis/contracts";

export function permitLocal(
  repo: string,
  spec: {
    action: string;
    operation: ApprovalOperation;
    workItemId: string;
    previewFingerprint?: string;
  },
): void {
  let root = resolve(repo);
  try {
    root = realpathSync(root);
  } catch {
    /* keep the unresolved path when the directory does not exist yet */
  }
  rmSync(join(root, ".praxis", "approvals"), { recursive: true, force: true });
  installHostApproval(root, {
    planId: `t-${randomUUID()}`,
    role: "developer",
    provider: "local",
    workItemIds: [spec.workItemId],
    repositories: [root],
    operations: [spec.operation],
    inScope: [spec.action],
    outOfScope: [],
    assumptions: [],
    risks: ["test fixture"],
    ...(spec.previewFingerprint ? { previewFingerprint: spec.previewFingerprint } : {}),
  });
}
