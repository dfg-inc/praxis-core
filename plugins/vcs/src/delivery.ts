import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VCS_CODES, VcsError } from "./errors.js";
import { deliveryFingerprint } from "./fingerprint.js";
import {
  addRemote,
  branchExists,
  checkoutBranch,
  commitStaged,
  committedFileSha256,
  createBranch,
  fileSha256,
  gitCurrentBranch,
  gitHeadSha,
  gitTreeSha,
  listCommitFiles,
  listHooks,
  listRemotes,
  lsRemoteHeads,
  pushBranch,
  readGitIdentity,
  readWorkingTree,
  remoteBranchExists,
  requireGitRepo,
  setLocalIdentity,
  setRemoteUrl,
  stagePaths,
  type GitIdentity,
  type GitRemote,
  type GitWorkingTree,
} from "./git-local.js";
import { parseRemoteUrl, resolveProvider, type VcsProviderKind } from "./git-url.js";
import { previewGitignore, type GitignorePreview } from "./gitignore-policy.js";
import { handoffPath, readJournal, writeJournal, type DeliveryLifecycle, type GitDeliveryJournal } from "./journal.js";
import { compareToQualitySnapshot, readQualitySnapshot } from "./quality-snapshot.js";
import { defaultAllowlist, planStaging } from "./staging-policy.js";
import { createGithubProvider, githubTokenFlags } from "./github-provider.js";
import { createGitlabProvider, gitlabTokenFlags } from "./gitlab-provider.js";
import type { CiStatus, RemoteRepositoryInfo, VcsProvider } from "./provider.js";

export type DeliveryInputs = {
  repo: string;
  workPackageId: string;
  jiraWorkPackageKey?: string;
  remoteName?: string;
  remoteUrl?: string;
  branch?: string;
  targetBranch?: string;
  files?: string[];
  commitMessage?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  providerKind?: VcsProviderKind;
  vcsProvider?: VcsProvider;
  fetchImpl?: typeof fetch;
};

export type GitStatusReport = {
  repositoryRoot: string;
  currentBranch: string | null;
  headSha: string | null;
  workingTree: GitWorkingTree;
  remotes: Array<Omit<GitRemote, "fetchUrl" | "pushUrl"> & { fetchUrl?: never; pushUrl?: never }>;
  remoteConfigured: boolean;
  provider: VcsProviderKind;
  providerSelectionRequired: boolean;
  identity: GitIdentity;
  hooks: ReturnType<typeof listHooks>;
  gitignore: GitignorePreview;
  pushReady: boolean;
  mergeRequestReady: boolean;
  baselineRequired: boolean;
  remoteEmpty: boolean | null;
  configurationRequirements: string[];
  warnings: string[];
};

function publicRemotes(remotes: GitRemote[]) {
  return remotes.map(({ fetchUrl: _f, pushUrl: _p, ...rest }) => rest);
}

function configuredProvider(env = process.env): string | undefined {
  return env.PRAXIS_GIT_PROVIDER;
}

export function inspectGitStatus(opts: DeliveryInputs): GitStatusReport {
  const repositoryRoot = requireGitRepo(opts.repo);
  const remotes = listRemotes(repositoryRoot);
  const identity = readGitIdentity(repositoryRoot);
  const workingTree = readWorkingTree(repositoryRoot);
  const currentBranch = gitCurrentBranch(repositoryRoot);
  const headSha = gitHeadSha(repositoryRoot);
  const configurationRequirements: string[] = [];
  const warnings: string[] = [];
  let provider: VcsProviderKind = "unknown";
  let providerSelectionRequired = false;
  if (!remotes.length) {
    provider = "unknown";
    configurationRequirements.push("Connect a Git remote. Praxis will not guess GitHub or GitLab from Jira or other checkouts.");
  } else if (opts.remoteName) {
    const chosen = remotes.find((r) => r.name === opts.remoteName);
    if (!chosen) configurationRequirements.push(`Unknown remote ${opts.remoteName}`);
    else {
      provider = resolveProvider({ inferred: chosen.inferredProvider, configured: opts.providerKind ?? configuredProvider() });
      if (provider === "unknown") providerSelectionRequired = true;
    }
  } else if (remotes.length > 1) {
    configurationRequirements.push("GIT_REMOTE_SELECTION_REQUIRED: multiple remotes; choose remoteName.");
    providerSelectionRequired = true;
  } else {
    provider = resolveProvider({
      inferred: remotes[0]!.inferredProvider,
      configured: opts.providerKind ?? configuredProvider(),
    });
    if (provider === "unknown") {
      providerSelectionRequired = true;
      configurationRequirements.push(
        "GIT_PROVIDER_UNKNOWN: set provider github or gitlab. Praxis does not infer a host from Jira.",
      );
    }
  }
  if (!identity.configured) {
    configurationRequirements.push(
      "GIT_IDENTITY_REQUIRED: set Git user.name and user.email (repo-local or effective global). Praxis will not invent an author or copy Jira email without confirmation.",
    );
  }
  const remoteConfigured = remotes.length > 0;
  return {
    repositoryRoot,
    currentBranch,
    headSha,
    workingTree,
    remotes: publicRemotes(remotes),
    remoteConfigured,
    provider,
    providerSelectionRequired,
    identity,
    hooks: listHooks(repositoryRoot),
    gitignore: previewGitignore(repositoryRoot),
    pushReady: false,
    mergeRequestReady: false,
    baselineRequired: !remoteConfigured,
    remoteEmpty: remoteConfigured ? null : true,
    configurationRequirements,
    warnings,
  };
}

export type ConnectPreview = {
  remotes: GitStatusReport["remotes"];
  proposedRemoteName: string;
  proposedUrlDisplay: string;
  proposedIdentity: string;
  provider: VcsProviderKind;
  accessCheck: "skipped" | "ok" | "failed";
  accessError?: string;
  createsRemote: boolean;
  previewFingerprint: string;
  jiraMutated: false;
};

export function previewConnect(opts: DeliveryInputs): ConnectPreview {
  const repo = requireGitRepo(opts.repo);
  const remotes = listRemotes(repo);
  const name = opts.remoteName || "origin";
  const existing = remotes.find((r) => r.name === name);
  if (!opts.remoteUrl && remotes.length > 1 && !opts.remoteName) {
    throw new VcsError(
      VCS_CODES.GIT_REMOTE_SELECTION_REQUIRED,
      "Multiple remotes found. Choose remoteName. Praxis will not pick a corporate or personal account for you.",
    );
  }
  const url = opts.remoteUrl || existing?.fetchUrl;
  if (!url) {
    throw new VcsError(
      VCS_CODES.GIT_REMOTE_REQUIRED,
      "No remote configured. Provide remoteUrl for the target GitHub or GitLab repository. Praxis will not guess gl.jetru.by, github.com, or any other host.",
    );
  }
  const parsed = parseRemoteUrl(url);
  const provider = resolveProvider({
    inferred: parsed.inferredProvider,
    configured: opts.providerKind ?? configuredProvider(),
  });
  const plan = {
    remoteName: name,
    identity: parsed.identity,
    protocol: parsed.protocol,
    provider,
    createsRemote: !existing,
  };
  return {
    remotes: publicRemotes(remotes),
    proposedRemoteName: name,
    proposedUrlDisplay: parsed.displayUrl,
    proposedIdentity: parsed.identity,
    provider,
    accessCheck: "skipped",
    createsRemote: !existing,
    previewFingerprint: deliveryFingerprint(plan),
    jiraMutated: false,
  };
}

export function applyConnect(opts: DeliveryInputs & { previewFingerprint: string }): ConnectPreview & {
  wrote: boolean;
} {
  const preview = previewConnect(opts);
  if (preview.previewFingerprint !== opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, "connect previewFingerprint mismatch; re-run git connect preview");
  }
  const repo = requireGitRepo(opts.repo);
  const name = preview.proposedRemoteName;
  const url = opts.remoteUrl;
  if (!url) {
    throw new VcsError(VCS_CODES.GIT_REMOTE_REQUIRED, "remoteUrl required to add a remote");
  }
  const remotes = listRemotes(repo);
  const existing = remotes.find((r) => r.name === name);
  if (!existing) addRemote(repo, name, url);
  else if (parseRemoteUrl(existing.fetchUrl).identity !== preview.proposedIdentity) {
    setRemoteUrl(repo, name, url);
  }
  let accessCheck: ConnectPreview["accessCheck"] = "ok";
  let accessError: string | undefined;
  try {
    lsRemoteHeads(repo, name);
  } catch (err) {
    accessCheck = "failed";
    accessError = err instanceof Error ? err.message : String(err);
  }
  return { ...previewConnect({ ...opts, remoteName: name }), accessCheck, accessError, wrote: true };
}

export function previewIdentity(opts: DeliveryInputs): {
  current: GitIdentity;
  proposedName: string | null;
  proposedEmail: string | null;
  previewFingerprint: string;
  jiraMutated: false;
} {
  const repo = requireGitRepo(opts.repo);
  const current = readGitIdentity(repo);
  const proposedName = opts.gitUserName ?? null;
  const proposedEmail = opts.gitUserEmail ?? null;
  return {
    current,
    proposedName,
    proposedEmail,
    previewFingerprint: deliveryFingerprint({
      name: proposedName,
      email: proposedEmail,
      scope: "local",
    }),
    jiraMutated: false,
  };
}

export function applyIdentity(opts: DeliveryInputs & { previewFingerprint: string }): GitIdentity {
  const preview = previewIdentity(opts);
  if (preview.previewFingerprint !== opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, "identity previewFingerprint mismatch");
  }
  if (!opts.gitUserName || !opts.gitUserEmail) {
    throw new VcsError(
      VCS_CODES.GIT_IDENTITY_REQUIRED,
      "gitUserName and gitUserEmail are required. Praxis will not copy Jira email automatically.",
    );
  }
  const repo = requireGitRepo(opts.repo);
  setLocalIdentity(repo, opts.gitUserName, opts.gitUserEmail);
  return readGitIdentity(repo);
}

function defaultBranchName(jiraKey?: string, wp?: string): string {
  const key = jiraKey || wp || "wp";
  return `feature/${key}-counter-reset`;
}

function defaultCommitMessage(jiraKey?: string): string {
  const key = jiraKey || "WP";
  return `feat(${key}): add counter reset support`;
}

function extraDirtyWarnings(tree: GitWorkingTree, selected: string[]): string[] {
  const allow = new Set(selected);
  const extras = [...tree.unstaged, ...tree.untracked].filter((p) => !allow.has(p));
  const warnings: string[] = [];
  if (extras.includes("package.json") || extras.includes("package-lock.json")) {
    warnings.push(
      "COMMITTED_TREE_DIFFERS_FROM_QA: package.json/package-lock.json are dirty but not in the delivery allowlist. Matching source hashes does not prove npm test from the future commit.",
    );
  }
  if (extras.includes(".npmrc") || extras.some((p) => p.endsWith(".npmrc"))) {
    warnings.push("REGISTRY_PREREQUISITE: .npmrc is present locally and is not staged. CI may need a registry config that this commit will not contain.");
  }
  if (extras.length) {
    warnings.push(
      `UNRELATED_CHANGES: ${extras.length} path(s) outside the allowlist remain unstaged. They will not be committed.`,
    );
  }
  return warnings;
}

export type DeliveryPreview = {
  workPackageId: string;
  jiraWorkPackageKey?: string;
  repositoryRoot: string;
  headSha: string | null;
  branch: string;
  currentBranch: string | null;
  targetBranch: string;
  targetRemote?: string;
  provider: VcsProviderKind;
  selectedFiles: string[];
  fileHashes: Array<{ path: string; sha256: string | null }>;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  qualityReviewId: number | null;
  qualitySnapshotDigest: string | null;
  qualityMatch: boolean;
  qualityRows: ReturnType<typeof compareToQualitySnapshot>["rows"];
  commitMessage: string;
  proposedOperations: string[];
  potentialConflicts: string[];
  warnings: string[];
  blockers: Array<{ code: string; message: string }>;
  baselineRequired: boolean;
  remoteEmpty: boolean | null;
  remoteConfigured: boolean;
  pushReady: boolean;
  mergeRequestReady: boolean;
  hooks: ReturnType<typeof listHooks>;
  ciStatus: CiStatus;
  previewFingerprint: string;
  jiraMutated: false;
};

function buildAllowlist(opts: DeliveryInputs, snapshotFiles: string[]): string[] {
  if (opts.files?.length) return opts.files;
  if (snapshotFiles.length) return snapshotFiles;
  return ["src/counter.js", "src/counter.test.js"];
}

export async function previewDelivery(opts: DeliveryInputs): Promise<DeliveryPreview> {
  const repositoryRoot = requireGitRepo(opts.repo);
  const status = inspectGitStatus(opts);
  const snapshot = readQualitySnapshot(repositoryRoot, opts.workPackageId);
  const selectedFiles = buildAllowlist(opts, snapshot.files.map((f) => f.path).filter(Boolean));
  const staging = planStaging({
    allowlist: selectedFiles,
    staged: status.workingTree.staged,
    unstaged: status.workingTree.unstaged,
    untracked: status.workingTree.untracked,
  });
  const quality = compareToQualitySnapshot(repositoryRoot, staging.selected, snapshot);
  const branch = opts.branch || defaultBranchName(opts.jiraWorkPackageKey, opts.workPackageId);
  const targetBranch = opts.targetBranch || status.currentBranch || "master";
  const commitMessage = opts.commitMessage || defaultCommitMessage(opts.jiraWorkPackageKey);
  const remotes = listRemotes(repositoryRoot);
  const remote = opts.remoteName
    ? remotes.find((r) => r.name === opts.remoteName)
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  const blockers: DeliveryPreview["blockers"] = [];
  const potentialConflicts: string[] = [];
  if (staging.foreignStaged.length) {
    blockers.push({
      code: VCS_CODES.GIT_FOREIGN_STAGED,
      message: `Index contains paths outside the allowlist: ${staging.foreignStaged.join(", ")}`,
    });
  }
  if (!status.identity.configured) {
    blockers.push({
      code: VCS_CODES.GIT_IDENTITY_REQUIRED,
      message: "Git identity is not configured (local or effective global user.name/email).",
    });
  }
  if (!quality.match) {
    blockers.push({
      code: VCS_CODES.GIT_QUALITY_SNAPSHOT_MISMATCH,
      message:
        "Selected files do not match the Quality Review snapshot. Run a new Quality Review; do not treat this as QA-approved. Praxis will not start Quality Review or Quality Apply.",
    });
  }
  if (status.providerSelectionRequired) {
    blockers.push({
      code: VCS_CODES.GIT_PROVIDER_UNKNOWN,
      message: "Select provider github or gitlab. GitHub is the alpha.42 MVP.",
    });
  }
  if (remotes.length > 1 && !opts.remoteName) {
    blockers.push({
      code: VCS_CODES.GIT_REMOTE_SELECTION_REQUIRED,
      message: "Multiple remotes. Choose remoteName.",
    });
  }
  let remoteEmpty: boolean | null = remotes.length ? null : true;
  let baselineRequired = !status.remoteConfigured;
  if (remote) {
    try {
      const heads = lsRemoteHeads(repositoryRoot, remote.name);
      remoteEmpty = heads.empty;
      baselineRequired = heads.empty;
      const conflict = heads.refs.some((ref) => ref.endsWith(`/${branch}`));
      if (conflict) potentialConflicts.push(`remote already has ${branch}`);
    } catch {
      remoteEmpty = null;
    }
  }
  const proposedOperations = ["create-branch", "stage-allowlist", "commit"];
  if (!status.remoteConfigured) {
    // local commit still allowed
  }
  const warnings = [
    ...extraDirtyWarnings(status.workingTree, staging.selected),
    ...status.configurationRequirements,
  ];
  if (status.hooks.length) {
    warnings.push(`GIT_HOOKS_PRESENT: ${status.hooks.map((h) => h.name).join(", ")} may run on commit/push.`);
  }
  const fingerprintBody = {
    workPackageId: opts.workPackageId,
    jiraWorkPackageKey: opts.jiraWorkPackageKey ?? null,
    repo: repositoryRoot,
    headSha: status.headSha,
    currentBranch: status.currentBranch,
    branch,
    targetBranch,
    remoteIdentity: remote?.identity ?? null,
    selectedFiles: staging.selected,
    fileHashes: staging.selected.map((p) => ({ path: p, sha256: fileSha256(repositoryRoot, p) })),
    index: status.workingTree.staged,
    qualityReviewId: snapshot.reviewId,
    qualitySnapshotDigest: snapshot.digest,
    commitMessage,
    proposedOperations,
  };
  return {
    workPackageId: opts.workPackageId,
    jiraWorkPackageKey: opts.jiraWorkPackageKey,
    repositoryRoot,
    headSha: status.headSha,
    branch,
    currentBranch: status.currentBranch,
    targetBranch,
    targetRemote: remote?.name,
    provider: remote
      ? resolveProvider({ inferred: remote.inferredProvider, configured: opts.providerKind ?? configuredProvider() })
      : "unknown",
    selectedFiles: staging.selected,
    fileHashes: fingerprintBody.fileHashes,
    staged: status.workingTree.staged,
    unstaged: status.workingTree.unstaged,
    untracked: status.workingTree.untracked,
    qualityReviewId: snapshot.reviewId,
    qualitySnapshotDigest: snapshot.digest,
    qualityMatch: quality.match,
    qualityRows: quality.rows,
    commitMessage,
    proposedOperations,
    potentialConflicts,
    warnings,
    blockers,
    baselineRequired,
    remoteEmpty,
    remoteConfigured: status.remoteConfigured,
    pushReady: Boolean(remote) && !baselineRequired && quality.match,
    mergeRequestReady: false,
    hooks: status.hooks,
    ciStatus: "unknown",
    previewFingerprint: deliveryFingerprint(fingerprintBody),
    jiraMutated: false,
  };
}

function assertFingerprint(preview: DeliveryPreview, got?: string): void {
  if (!got || preview.previewFingerprint !== got) {
    throw new VcsError(
      VCS_CODES.GIT_PREVIEW_STALE,
      "previewFingerprint mismatch; HEAD, files, remote, or Quality Review changed. Re-run git preview.",
      { expected: preview.previewFingerprint, got },
    );
  }
}

export async function applyCommit(
  opts: DeliveryInputs & { previewFingerprint: string },
): Promise<GitDeliveryJournal> {
  const preview = await previewDelivery(opts);
  assertFingerprint(preview, opts.previewFingerprint);
  if (preview.blockers.length) {
    const first = preview.blockers[0]!;
    throw new VcsError(
      (Object.values(VCS_CODES) as string[]).includes(first.code)
        ? (first.code as (typeof VCS_CODES)[keyof typeof VCS_CODES])
        : VCS_CODES.GIT_STAGING_BLOCKED,
      first.message,
      { blockers: preview.blockers },
    );
  }
  const repo = preview.repositoryRoot;
  const journal = readJournal(repo, opts.workPackageId);
  if (journal?.commitSha && gitHeadSha(repo) === journal.commitSha) {
    return journal;
  }
  const headBefore = gitHeadSha(repo);
  const current = gitCurrentBranch(repo);
  if (current !== preview.branch) {
    if (branchExists(repo, preview.branch)) checkoutBranch(repo, preview.branch);
    else createBranch(repo, preview.branch);
  }
  const tree = readWorkingTree(repo);
  const foreign = tree.staged.filter((p) => !preview.selectedFiles.includes(p));
  if (foreign.length) {
    throw new VcsError(VCS_CODES.GIT_FOREIGN_STAGED, `refusing to commit with foreign staged paths: ${foreign.join(", ")}`);
  }
  for (const rel of preview.selectedFiles) {
    const live = fileSha256(repo, rel);
    const expected = preview.fileHashes.find((f) => f.path === rel)?.sha256;
    if (!live || live !== expected) {
      throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, `file hash changed: ${rel}`);
    }
  }
  stagePaths(repo, preview.selectedFiles);
  const commitSha = commitStaged(repo, preview.commitMessage);
  const committed = listCommitFiles(repo, commitSha);
  const extra = committed.filter((p) => !preview.selectedFiles.includes(p));
  const hashes = preview.selectedFiles.map((path) => ({
    path,
    sha256: committedFileSha256(repo, commitSha, path),
  }));
  const entry: GitDeliveryJournal = {
    workPackageId: opts.workPackageId,
    jiraWorkPackageKey: opts.jiraWorkPackageKey,
    provider: preview.provider,
    remoteName: preview.targetRemote,
    remoteIdentity: listRemotes(repo).find((r) => r.name === preview.targetRemote)?.identity,
    displayRemoteUrl: listRemotes(repo).find((r) => r.name === preview.targetRemote)?.displayUrl,
    branch: preview.branch,
    targetBranch: preview.targetBranch,
    baseSha: headBefore ?? undefined,
    commitSha,
    commitTreeSha: gitTreeSha(repo, commitSha) ?? undefined,
    selectedFiles: preview.selectedFiles,
    qaReviewId: preview.qualityReviewId,
    qaSnapshotDigest: preview.qualitySnapshotDigest,
    ciStatus: "unknown",
    lifecycle: "committed",
    previewFingerprint: preview.previewFingerprint,
    forcePush: false,
    merged: false,
  };
  if (extra.length) {
    entry.lifecycle = "partial";
  }
  writeJournal(repo, entry);
  void hashes;
  return readJournal(repo, opts.workPackageId)!;
}

export type PublishPreview = {
  mode: "baseline" | "branch";
  remoteName: string;
  remoteIdentity: string;
  branch: string;
  commitSha?: string;
  remoteEmpty: boolean;
  baselineRequired: boolean;
  force: false;
  previewFingerprint: string;
  jiraMutated: false;
};

export function previewPublish(
  opts: DeliveryInputs & { mode?: "baseline" | "branch" },
): PublishPreview {
  const repo = requireGitRepo(opts.repo);
  const journal = readJournal(repo, opts.workPackageId);
  const remotes = listRemotes(repo);
  const remote = opts.remoteName
    ? remotes.find((r) => r.name === opts.remoteName)
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  if (!remote) {
    throw new VcsError(
      VCS_CODES.GIT_REMOTE_REQUIRED,
      "Remote delivery is blocked: no remote configured. Local commit is allowed. Connect Git first.",
    );
  }
  const heads = lsRemoteHeads(repo, remote.name);
  const mode = opts.mode ?? (heads.empty ? "baseline" : "branch");
  const branch =
    mode === "baseline"
      ? (journal?.targetBranch || gitCurrentBranch(repo) || "master")
      : (journal?.branch || defaultBranchName(opts.jiraWorkPackageKey, opts.workPackageId));
  const body = {
    mode,
    remoteIdentity: remote.identity,
    branch,
    commitSha: journal?.commitSha ?? null,
    remoteEmpty: heads.empty,
    force: false as const,
  };
  return {
    mode,
    remoteName: remote.name,
    remoteIdentity: remote.identity,
    branch,
    commitSha: journal?.commitSha,
    remoteEmpty: heads.empty,
    baselineRequired: heads.empty && mode === "branch",
    force: false,
    previewFingerprint: deliveryFingerprint(body),
    jiraMutated: false,
  };
}

export async function applyPublish(
  opts: DeliveryInputs & { previewFingerprint: string; mode?: "baseline" | "branch" },
): Promise<GitDeliveryJournal> {
  const repo = requireGitRepo(opts.repo);
  const journal = readJournal(repo, opts.workPackageId);
  if (!journal?.commitSha && opts.mode !== "baseline") {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "No local delivery commit. Run git commit first.");
  }
  const pub = previewPublish(opts);
  if (pub.previewFingerprint !== opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, "publish previewFingerprint mismatch; re-run git publish preview");
  }
  if (pub.baselineRequired) {
    throw new VcsError(
      VCS_CODES.GIT_BASELINE_REQUIRED,
      "GitHub/GitLab repository has no commits. Human-gated baseline publication is required before a pull/merge request. This will not force-push.",
    );
  }
  const remotes = listRemotes(repo);
  const remote = opts.remoteName
    ? remotes.find((r) => r.name === opts.remoteName)
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  if (!remote) {
    throw new VcsError(
      VCS_CODES.GIT_REMOTE_REQUIRED,
      "Remote delivery is blocked: no remote configured. Local commit is allowed. Connect Git first.",
    );
  }
  const heads = lsRemoteHeads(repo, remote.name);
  const mode = opts.mode ?? (heads.empty ? "baseline" : "branch");
  if (mode === "branch" && heads.empty) {
    throw new VcsError(
      VCS_CODES.GIT_BASELINE_REQUIRED,
      "GitHub/GitLab repository has no commits. Human-gated baseline publication is required before a pull/merge request. This will not force-push.",
    );
  }
  if (mode === "baseline" && !heads.empty) {
    throw new VcsError(
      VCS_CODES.GIT_REMOTE_HISTORY_CONFLICT,
      "Remote already has history. Baseline publication is skipped. Praxis will not force-push or overwrite it.",
    );
  }
  const branch = pub.branch;
  if (mode === "branch" && journal?.lifecycle === "pushed" && journal.commitSha) {
    return journal;
  }
  if (mode === "branch" && journal?.commitSha && gitHeadSha(repo) !== journal.commitSha) {
    const onBranch = gitCurrentBranch(repo);
    if (onBranch !== journal.branch) checkoutBranch(repo, journal.branch!);
  }
  if (remoteBranchExists(repo, remote.name, branch) && mode === "branch") {
    /* non-ff checked by git push rejection */
  }
  const pushed = pushBranch(repo, remote.name, branch, { setUpstream: true });
  if (pushed.force) {
    throw new VcsError(VCS_CODES.GIT_FORCE_PUSH_FORBIDDEN, "force push is not allowed");
  }
  const next: GitDeliveryJournal = {
    ...(journal ?? {
      workPackageId: opts.workPackageId,
      forcePush: false,
      merged: false,
      lifecycle: "not-started",
    }),
    provider: resolveProvider({
      inferred: remote.inferredProvider,
      configured: opts.providerKind ?? configuredProvider(),
    }),
    remoteName: remote.name,
    remoteIdentity: remote.identity,
    displayRemoteUrl: remote.displayUrl,
    branch: journal?.branch ?? pub.branch,
    targetBranch: journal?.targetBranch ?? "master",
    lifecycle: mode === "baseline" ? "baseline-published" : "pushed",
    ciStatus: "unknown",
    forcePush: false,
    merged: false,
  };
  writeJournal(repo, next);
  return readJournal(repo, opts.workPackageId)!;
}

function resolveVcsProvider(opts: DeliveryInputs, kind: VcsProviderKind): VcsProvider {
  if (opts.vcsProvider) return opts.vcsProvider;
  if (kind === "github") {
    return createGithubProvider({ fetchImpl: opts.fetchImpl, env: process.env });
  }
  if (kind === "gitlab") {
    return createGitlabProvider({ fetchImpl: opts.fetchImpl, env: process.env });
  }
  throw new VcsError(
    VCS_CODES.GIT_PROVIDER_UNKNOWN,
    "Unknown Git provider. Choose github (MVP) or gitlab. GitHub API/PR is implemented; do not assume GitHub from Jira.",
  );
}

export function mergeRequestBody(opts: {
  jiraKey?: string;
  workPackageId: string;
  commitSha?: string;
  sourceBranch: string;
  targetBranch: string;
  qualityReviewId?: number | null;
  selectedFiles?: string[];
  testSummary?: string;
}): string {
  return [
    `## Praxis Git Delivery`,
    "",
    `- Jira: ${opts.jiraKey ?? "(none)"}`,
    `- Work Package: ${opts.workPackageId}`,
    `- Commit: ${opts.commitSha ?? "(pending)"}`,
    `- Source: ${opts.sourceBranch}`,
    `- Target: ${opts.targetBranch}`,
    `- Quality Review: ${opts.qualityReviewId ?? "(none)"}`,
    `- Scope: ${(opts.selectedFiles ?? []).join(", ") || "(allowlist)"}`,
    `- Tests: ${opts.testSummary ?? "see Quality Review evidence; CI status is unknown until GitHub Actions / GitLab pipelines complete."}`,
    "",
    "CI is **not** claimed PASS. Merge is **not** performed by Praxis.",
  ].join("\n");
}

export async function applyMergeRequest(
  opts: DeliveryInputs & { previewFingerprint?: string },
): Promise<GitDeliveryJournal> {
  const repo = requireGitRepo(opts.repo);
  const journal = readJournal(repo, opts.workPackageId);
  if (!journal?.commitSha) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "Create the local commit and push before a pull/merge request.");
  }
  if (journal.mergeRequestUrl && journal.lifecycle === "awaiting-review") {
    return journal;
  }
  if (journal.lifecycle !== "pushed" && journal.lifecycle !== "awaiting-review" && journal.lifecycle !== "partial") {
    if (journal.lifecycle === "committed" || journal.lifecycle === "baseline-published") {
      throw new VcsError(
        VCS_CODES.GIT_PUSH_BLOCKED,
        "Push the feature branch after baseline publication, then create the pull/merge request.",
      );
    }
  }
  const remotes = listRemotes(repo);
  const remote = remotes.find((r) => r.name === (opts.remoteName || journal.remoteName)) ?? remotes[0];
  if (!remote) {
    throw new VcsError(VCS_CODES.GIT_REMOTE_REQUIRED, "No remote configured.");
  }
  const kind = resolveProvider({
    inferred: remote.inferredProvider,
    configured: opts.providerKind ?? configuredProvider() ?? journal.provider,
  });
  if (kind === "unknown") {
    throw new VcsError(VCS_CODES.GIT_PROVIDER_UNKNOWN, "Select provider github or gitlab.");
  }
  const provider = resolveVcsProvider(opts, kind);
  const sourceBranch = journal.branch!;
  const targetBranch = opts.targetBranch || journal.targetBranch || "master";
  const existing = await provider.listOpenMergeRequests({
    owner: remote.owner,
    repo: remote.repo,
    projectPath: remote.projectPath,
    sourceBranch,
    targetBranch,
  });
  const mr =
    existing[0] ??
    (await provider.createMergeRequest({
      owner: remote.owner,
      repo: remote.repo,
      projectPath: remote.projectPath,
      sourceBranch,
      targetBranch,
      title: journal.jiraWorkPackageKey
        ? `${journal.jiraWorkPackageKey}: ${opts.workPackageId}`
        : opts.workPackageId,
      body: mergeRequestBody({
        jiraKey: journal.jiraWorkPackageKey,
        workPackageId: opts.workPackageId,
        commitSha: journal.commitSha,
        sourceBranch,
        targetBranch,
        qualityReviewId: journal.qaReviewId,
        selectedFiles: journal.selectedFiles,
      }),
      commitSha: journal.commitSha,
    }));
  if (mr.merged) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "Existing pull/merge request is already merged. Praxis does not merge.");
  }
  const ci = await provider.pipelineStatus({
    owner: remote.owner,
    repo: remote.repo,
    projectPath: remote.projectPath,
    branch: sourceBranch,
    commitSha: journal.commitSha,
  });
  const next: GitDeliveryJournal = {
    ...journal,
    mergeRequestUrl: mr.url || undefined,
    mergeRequestId: mr.id,
    ciStatus: ci.ciStatus,
    lifecycle: "awaiting-review",
    forcePush: false,
    merged: false,
  };
  writeJournal(repo, next);
  return readJournal(repo, opts.workPackageId)!;
}

export async function inspectRemoteRepository(
  opts: DeliveryInputs,
): Promise<RemoteRepositoryInfo | { remoteConfigured: false }> {
  const repo = requireGitRepo(opts.repo);
  const remotes = listRemotes(repo);
  const remote = opts.remoteName
    ? remotes.find((r) => r.name === opts.remoteName)
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  if (!remote) return { remoteConfigured: false };
  const kind = resolveProvider({
    inferred: remote.inferredProvider,
    configured: opts.providerKind ?? configuredProvider(),
  });
  if (kind === "unknown") return { remoteConfigured: false };
  const provider = resolveVcsProvider(opts, kind);
  return provider.inspectRepository({
    owner: remote.owner,
    repo: remote.repo,
    projectPath: remote.projectPath,
    host: remote.host,
  });
}

export function inspectDeliveryStatus(opts: DeliveryInputs): {
  journal: GitDeliveryJournal | null;
  handoffPath: string;
  github: ReturnType<typeof githubTokenFlags>;
  gitlab: ReturnType<typeof gitlabTokenFlags>;
  jiraMutated: false;
} {
  const repo = requireGitRepo(opts.repo);
  return {
    journal: readJournal(repo, opts.workPackageId),
    handoffPath: handoffPath(repo, opts.workPackageId),
    github: githubTokenFlags(),
    gitlab: gitlabTokenFlags(),
    jiraMutated: false,
  };
}

export function readHandoffFile(repo: string, workPackageId: string): string | null {
  const p = handoffPath(repo, workPackageId);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export type { DeliveryLifecycle, GitDeliveryJournal };
