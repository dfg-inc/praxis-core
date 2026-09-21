import {
  applyCommit,
  applyConnect,
  applyIdentity,
  applyMergeRequest,
  applyPublish,
  inspectDeliveryStatus,
  inspectGitStatus,
  inspectRemoteRepository,
  mergeGitStatusRemote,
  previewConnect,
  previewDelivery,
  previewIdentity,
  previewPublish,
  previewMergeRequest,
  type DeliveryInputs,
  type GitDeliveryJournal,
  type GitStatusReport,
  type GitWriteFields,
  type RemoteInspectResult,
  type VcsProvider,
  type VcsProviderKind,
} from "@praxis/vcs";

export type GitOpContext = DeliveryInputs & {
  confirmation?: string;
  previewFingerprint?: string;
  gitPublishMode?: "baseline" | "branch";
  vcsProvider?: VcsProvider;
};

export function toGitInputs(ctx: GitOpContext): DeliveryInputs {
  return {
    repo: ctx.repo,
    workPackageId: ctx.workPackageId,
    jiraWorkPackageKey: ctx.jiraWorkPackageKey,
    remoteName: ctx.remoteName,
    remoteUrl: ctx.remoteUrl,
    branch: ctx.branch,
    targetBranch: ctx.targetBranch,
    files: ctx.files,
    commitMessage: ctx.commitMessage,
    gitUserName: ctx.gitUserName,
    gitUserEmail: ctx.gitUserEmail,
    providerKind: ctx.providerKind,
    vcsProvider: ctx.vcsProvider,
    fetchImpl: ctx.fetchImpl,
  };
}

export async function gitStatusData(
  ctx: GitOpContext,
): Promise<GitStatusReport & { remote: RemoteInspectResult; jiraMutated: false }> {
  const inputs = toGitInputs(ctx);
  const status = inspectGitStatus(inputs);
  let remote: Awaited<ReturnType<typeof inspectRemoteRepository>> | {
    remoteConfigured: boolean;
    inspectFailed: true;
    inspectError: string;
  };
  try {
    remote = await inspectRemoteRepository(inputs);
  } catch (err) {
    remote = {
      remoteConfigured: status.remoteConfigured,
      inspectFailed: true,
      inspectError: err instanceof Error ? err.message : String(err),
    };
  }
  return mergeGitStatusRemote(status, remote);
}

export function gitConnectPreviewData(ctx: GitOpContext) {
  return previewConnect(toGitInputs(ctx));
}

export function gitConnectApplyData(ctx: GitOpContext) {
  return applyConnect({ ...toGitInputs(ctx), previewFingerprint: ctx.previewFingerprint! });
}

export function gitIdentityPreviewData(ctx: GitOpContext) {
  return previewIdentity(toGitInputs(ctx));
}

export function gitIdentityApplyData(ctx: GitOpContext) {
  return applyIdentity({ ...toGitInputs(ctx), previewFingerprint: ctx.previewFingerprint! });
}

export function gitPreviewData(ctx: GitOpContext) {
  return previewDelivery(toGitInputs(ctx));
}

export function gitCommitData(ctx: GitOpContext): Promise<GitDeliveryJournal & GitWriteFields> {
  return applyCommit({ ...toGitInputs(ctx), previewFingerprint: ctx.previewFingerprint! });
}

export function gitPublishPreviewData(ctx: GitOpContext) {
  return previewPublish({ ...toGitInputs(ctx), mode: ctx.gitPublishMode });
}

export function gitPublishData(ctx: GitOpContext): Promise<GitDeliveryJournal & GitWriteFields> {
  return applyPublish({
    ...toGitInputs(ctx),
    previewFingerprint: ctx.previewFingerprint!,
    mode: ctx.gitPublishMode,
  });
}

export function gitMergeRequestPreviewData(ctx: GitOpContext) {
  return previewMergeRequest(toGitInputs(ctx));
}

export function gitMergeRequestData(ctx: GitOpContext): Promise<GitDeliveryJournal & GitWriteFields> {
  return applyMergeRequest({ ...toGitInputs(ctx), previewFingerprint: ctx.previewFingerprint });
}

export function gitDeliveryStatusData(ctx: GitOpContext) {
  return inspectDeliveryStatus(toGitInputs(ctx));
}

export type { VcsProviderKind };
