import type { ApprovalOperation } from "./approval.js";

/** The Git operations that are protected by the user's approval. */
export type GitOperationKind = Extract<ApprovalOperation, "git_commit" | "git_push" | "merge_request" | "repository_edit">;

/** What the live repository says a Git operation would do. Supplied by the caller from its own preview; shown to the user. */
export type GitDescribed = {
  /** "local" for operations that stay in the repository; the remote identity (host/owner/repo) for push and merge request. */
  instanceId: string;
  /** Exact resources touched: branch, refspec, file@sha256 ... */
  targets: string[];
  /** HEAD or commit sha the operation starts from. */
  revision: string;
  previewFingerprint: string;
  summary: string;
  description: string;
  risks?: string[];
  branch?: string;
  remote?: string;
};
