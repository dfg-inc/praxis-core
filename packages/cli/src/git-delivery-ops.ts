import {
  applyCommit,
  applyConnect,
  applyIdentity,
  applyMergeRequest,
  applyPublish,
  inspectDeliveryStatus,
  inspectGitStatus,
  inspectRemoteRepository,
  previewConnect,
  previewDelivery,
  previewIdentity,
  previewPublish,
  type DeliveryInputs,
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

export async function gitStatusData(ctx: GitOpContext) {
  const status = inspectGitStatus(toGitInputs(ctx));
  let remote: unknown = { remoteConfigured: false };
  try {
    remote = await inspectRemoteRepository(toGitInputs(ctx));
  } catch {
    remote = { remoteConfigured: status.remoteConfigured };
  }
  return { ...status, remote, jiraMutated: false as const };
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

export function gitCommitData(ctx: GitOpContext) {
  return applyCommit({ ...toGitInputs(ctx), previewFingerprint: ctx.previewFingerprint! });
}

export function gitPublishPreviewData(ctx: GitOpContext) {
  return previewPublish({ ...toGitInputs(ctx), mode: ctx.gitPublishMode });
}

export function gitPublishData(ctx: GitOpContext) {
  return applyPublish({
    ...toGitInputs(ctx),
    previewFingerprint: ctx.previewFingerprint!,
    mode: ctx.gitPublishMode,
  });
}

export function gitMergeRequestData(ctx: GitOpContext) {
  return applyMergeRequest({ ...toGitInputs(ctx), previewFingerprint: ctx.previewFingerprint });
}

export function gitDeliveryStatusData(ctx: GitOpContext) {
  return inspectDeliveryStatus(toGitInputs(ctx));
}

export type { VcsProviderKind };
