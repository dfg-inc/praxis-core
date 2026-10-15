import { requireMutationLease } from "@praxis/contracts";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CiStatus } from "./provider.js";
import type { VcsProviderKind } from "./git-url.js";

export type DeliveryLifecycle =
  | "not-started"
  | "previewed"
  | "committed"
  | "baseline-published"
  | "pushed"
  | "awaiting-review"
  | "partial";

export type GitDeliveryJournal = {
  workPackageId: string;
  jiraWorkPackageKey?: string;
  provider?: VcsProviderKind;
  repository?: string;
  remoteName?: string;
  remoteIdentity?: string;
  displayRemoteUrl?: string;
  branch?: string;
  featureBranch?: string;
  targetBranch?: string;
  baselineSha?: string;
  baselineRemoteBranch?: string;
  baseSha?: string;
  commitSha?: string;
  commitTreeSha?: string;
  selectedFiles?: string[];
  qaReviewId?: number | null;
  qaSnapshotDigest?: string | null;
  mergeRequestUrl?: string;
  mergeRequestId?: string | number;
  pullRequestUrl?: string;
  pullRequestNumber?: string | number;
  pullRequestBase?: string;
  pullRequestHead?: string;
  ciStatus?: CiStatus;
  deliveryLifecycle?: DeliveryLifecycle;
  lifecycle: DeliveryLifecycle;
  previewFingerprint?: string;
  forcePush: false;
  merged: false;
};

export function journalPath(repo: string, workPackageId: string): string {
  return join(repo, ".praxis-git", `${workPackageId}.delivery.json`);
}

export function handoffPath(repo: string, workPackageId: string): string {
  return join(repo, "design", workPackageId, "dev", "git-delivery.json");
}

export function readJournal(repo: string, workPackageId: string): GitDeliveryJournal | null {
  const p = journalPath(repo, workPackageId);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as GitDeliveryJournal;
    return { ...v, forcePush: false, merged: false };
  } catch {
    return null;
  }
}

export function writeJournal(repo: string, entry: GitDeliveryJournal): void {
  requireMutationLease();
  const safe: GitDeliveryJournal = {
    ...entry,
    deliveryLifecycle: entry.lifecycle,
    forcePush: false,
    merged: false,
  };
  const p = journalPath(repo, entry.workPackageId);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `${JSON.stringify(safe, null, 2)}\n`);
  const handoff = handoffPath(repo, entry.workPackageId);
  mkdirSync(join(handoff, ".."), { recursive: true });
  writeFileSync(handoff, `${JSON.stringify(safe, null, 2)}\n`);
}
