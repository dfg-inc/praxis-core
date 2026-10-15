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
  lsRemoteHeadSha,
  lsRemoteHeads,
  pushRefspec,
  readGitIdentity,
  readWorkingTree,
  requireGitRepo,
  setLocalIdentity,
  setRemoteUrl,
  stagePaths,
  committedPaths,
  commitCount,
  hasGithubWorkflows,
  type GitIdentity,
  type GitRemote,
  type GitWorkingTree,
} from "./git-local.js";
import {
  exactRemoteUrlsEqual,
  parseRemoteUrl,
  redactRemoteUrl,
  resolveProvider,
  type GitProtocol,
  type VcsProviderKind,
} from "./git-url.js";
import { previewGitignore, type GitignorePreview } from "./gitignore-policy.js";
import { handoffPath, readJournal, writeJournal, type DeliveryLifecycle, type GitDeliveryJournal } from "./journal.js";
import { compareToQualitySnapshot, readQualitySnapshot } from "./quality-snapshot.js";
import { defaultAllowlist, planStaging } from "./staging-policy.js";
import { createGithubProvider, githubTokenFlags } from "./github-provider.js";
import { createGitlabProvider, gitlabTokenFlags } from "./gitlab-provider.js";
import type { CiStatus, RemoteRepositoryInfo, VcsProvider } from "./provider.js";
import { requireCleanSecretScan } from "./secret-scan.js";
import { authorizeLocal, hasMutationLease, localMutation } from "./mutation-auth.js";

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
  /** Default true. Tests may disable ls-remote so HTTPS↔SSH URL writes do not wait on the network. */
  probeRemoteAccess?: boolean;
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
  baselineRequired: boolean | null;
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
    baselineRequired: remoteConfigured ? null : true,
    remoteEmpty: remoteConfigured ? null : true,
    configurationRequirements,
    warnings,
  };
}

export type RemoteInspectResult =
  | RemoteRepositoryInfo
  | { remoteConfigured: false }
  | { remoteConfigured: boolean; inspectFailed: true; inspectError?: string };

export function mergeGitStatusRemote(
  status: GitStatusReport,
  remote: RemoteInspectResult,
): GitStatusReport & { remote: RemoteInspectResult; jiraMutated: false } {
  const warnings = [...status.warnings];
  let remoteEmpty = status.remoteEmpty;
  let baselineRequired: boolean | null = status.baselineRequired;
  if (remote && "empty" in remote && typeof remote.empty === "boolean") {
    remoteEmpty = remote.empty;
    baselineRequired = remote.empty;
  } else if (status.remoteConfigured) {
    const failed = "inspectFailed" in remote && remote.inspectFailed;
    const unknownProvider = "remoteConfigured" in remote && remote.remoteConfigured === false;
    if (failed || unknownProvider) {
      remoteEmpty = null;
      baselineRequired = null;
      if (failed) {
        warnings.push(
          "Git provider API did not report repository emptiness; remoteEmpty is unknown (not false). Do not skip baseline publication on this result.",
        );
      }
    }
  }
  return { ...status, remoteEmpty, baselineRequired, warnings, remote, jiraMutated: false };
}

export type ConnectPreview = {
  remotes: GitStatusReport["remotes"];
  proposedRemoteName: string;
  proposedUrlDisplay: string;
  proposedIdentity: string;
  proposedProtocol: GitProtocol;
  provider: VcsProviderKind;
  accessCheck: "skipped" | "ok" | "failed";
  accessError?: string;
  createsRemote: boolean;
  updatesExistingUrl: boolean;
  previewFingerprint: string;
  jiraMutated: false;
};

export type ConnectApplyResult = ConnectPreview & {
  wrote: boolean;
  configurationWriteSucceeded: boolean;
  actualRemoteUrl: string;
  actualIdentity: string;
  actualProtocol: GitProtocol;
  ok: boolean;
  errors?: string[];
  code?: string;
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
  const updatesExistingUrl = Boolean(existing && !exactRemoteUrlsEqual(existing.fetchUrl, url));
  const plan = {
    remoteName: name,
    identity: parsed.identity,
    protocol: parsed.protocol,
    exactUrl: parsed.displayUrl,
    existingExactUrl: existing ? redactRemoteUrl(existing.fetchUrl) : null,
    createsRemote: !existing,
    updatesExistingUrl,
  };
  return {
    remotes: publicRemotes(remotes),
    proposedRemoteName: name,
    proposedUrlDisplay: parsed.displayUrl,
    proposedIdentity: parsed.identity,
    proposedProtocol: parsed.protocol,
    provider,
    accessCheck: "skipped",
    createsRemote: !existing,
    updatesExistingUrl,
    previewFingerprint: deliveryFingerprint(plan),
    jiraMutated: false,
  };
}

export function applyConnect(opts: DeliveryInputs & { previewFingerprint: string }): ConnectApplyResult {
  const preview = previewConnect(opts);
  if (preview.previewFingerprint !== opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, "connect previewFingerprint mismatch; re-run git connect preview");
  }
  const repo = requireGitRepo(opts.repo);
  const name = preview.proposedRemoteName;
  const url = opts.remoteUrl;
  if (!url) {
    throw new VcsError(VCS_CODES.GIT_REMOTE_REQUIRED, "remoteUrl required to add or update a remote");
  }
  const remotesBefore = listRemotes(repo);
  const existing = remotesBefore.find((r) => r.name === name);
  const alreadyExact = Boolean(existing && exactRemoteUrlsEqual(existing.fetchUrl, url));
  if ((!existing || !alreadyExact) && !hasMutationLease()) {
    return authorizeLocal(localMutation(repo, {
      action: "praxis_developer_git_connect_apply",
      operation: "repository_edit",
      workItemId: opts.workPackageId,
      previewFingerprint: opts.previewFingerprint,
    }), () => applyConnect(opts));
  }
  let wrote = false;
  if (!existing) {
    addRemote(repo, name, url);
    wrote = true;
  } else if (!alreadyExact) {
    setRemoteUrl(repo, name, url);
    wrote = true;
  }
  const remotesAfter = listRemotes(repo);
  const actual = remotesAfter.find((r) => r.name === name);
  if (!actual) {
    throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, `git remote ${name} missing after connect write`);
  }
  const configurationWriteSucceeded = exactRemoteUrlsEqual(actual.fetchUrl, url);
  if (!configurationWriteSucceeded) {
    throw new VcsError(
      VCS_CODES.GIT_TRANSPORT_FAILED,
      `GIT_CONNECT_POSTCONDITION: ${name} is still ${actual.displayUrl}; expected ${preview.proposedUrlDisplay}. Repository identity match is not enough when the exact URL (HTTPS vs SSH) differs.`,
    );
  }

  let accessCheck: ConnectPreview["accessCheck"] = opts.probeRemoteAccess === false ? "skipped" : "ok";
  let accessError: string | undefined;
  if (opts.probeRemoteAccess !== false) {
    try {
      lsRemoteHeads(repo, name);
      accessCheck = "ok";
    } catch (err) {
      accessCheck = "failed";
      accessError = err instanceof Error ? err.message : String(err);
    }
  }

  const ok = accessCheck !== "failed";
  return {
    remotes: publicRemotes(remotesAfter),
    proposedRemoteName: preview.proposedRemoteName,
    proposedUrlDisplay: preview.proposedUrlDisplay,
    proposedIdentity: preview.proposedIdentity,
    proposedProtocol: preview.proposedProtocol,
    provider: preview.provider,
    createsRemote: preview.createsRemote,
    updatesExistingUrl: preview.updatesExistingUrl,
    previewFingerprint: opts.previewFingerprint,
    jiraMutated: false,
    accessCheck,
    accessError,
    wrote,
    configurationWriteSucceeded: true,
    actualRemoteUrl: actual.displayUrl,
    actualIdentity: actual.identity,
    actualProtocol: actual.protocol,
    ok,
    errors: ok ? undefined : [accessError ?? "git connect access check failed"],
    code: ok ? undefined : VCS_CODES.GIT_TRANSPORT_FAILED,
  };
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
  if (!hasMutationLease()) {
    return authorizeLocal(localMutation(repo, {
      action: "praxis_developer_git_identity_apply",
      operation: "repository_edit",
      workItemId: opts.workPackageId,
      previewFingerprint: opts.previewFingerprint,
    }), () => applyIdentity(opts));
  }
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
  baselineRequired: boolean | null;
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
  const jiraKey = opts.jiraWorkPackageKey || snapshot.jiraWorkPackageKey;
  const selectedFiles = buildAllowlist(opts, snapshot.files.map((f) => f.path).filter(Boolean));
  const staging = planStaging({
    allowlist: selectedFiles,
    staged: status.workingTree.staged,
    unstaged: status.workingTree.unstaged,
    untracked: status.workingTree.untracked,
  });
  const quality = compareToQualitySnapshot(repositoryRoot, staging.selected, snapshot);
  const branch = opts.branch || defaultBranchName(jiraKey, opts.workPackageId);
  let targetBranch = opts.targetBranch?.trim() || "";
  const commitMessage = opts.commitMessage || defaultCommitMessage(jiraKey);
  const remotes = listRemotes(repositoryRoot);
  const remote = opts.remoteName
    ? remotes.find((r) => r.name === opts.remoteName)
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  const blockers: DeliveryPreview["blockers"] = [];
  const potentialConflicts: string[] = [];
  const unknownEmptyWarnings: string[] = [];
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
  let baselineRequired: boolean | null = remotes.length ? null : true;
  if (remote) {
    let apiKnown = false;
    try {
      const info = await inspectRemoteRepository(opts);
      if (info && "empty" in info && typeof info.empty === "boolean") {
        remoteEmpty = info.empty;
        baselineRequired = info.empty;
        apiKnown = true;
        if (!targetBranch && "defaultBranch" in info && info.defaultBranch) {
          targetBranch = info.defaultBranch;
        }
      }
    } catch {
      /* fall through to ls-remote; do not treat API failure as empty=false */
    }
    if (!apiKnown) {
      try {
        const heads = lsRemoteHeads(repositoryRoot, remote.name);
        remoteEmpty = heads.empty;
        baselineRequired = heads.empty;
        const conflict = heads.refs.some((ref) => ref.endsWith(`/${branch}`));
        if (conflict) potentialConflicts.push(`remote already has ${branch}`);
      } catch {
        remoteEmpty = null;
        baselineRequired = null;
        unknownEmptyWarnings.push(
          "Could not determine whether the remote is empty; remoteEmpty is unknown (not false).",
        );
      }
    }
  }
  if (!targetBranch) {
    const inferred = remote
      ? resolveProvider({
          inferred: remote.inferredProvider,
          configured: opts.providerKind ?? configuredProvider(),
        })
      : status.provider;
    targetBranch = inferred === "gitlab" ? "main" : "main";
  }
  const proposedOperations = ["create-branch", "stage-allowlist", "commit"];
  if (!status.remoteConfigured) {
    // local commit still allowed
  }
  const warnings = [
    ...extraDirtyWarnings(status.workingTree, staging.selected),
    ...status.configurationRequirements,
    ...unknownEmptyWarnings,
  ];
  if (status.hooks.length) {
    warnings.push(`GIT_HOOKS_PRESENT: ${status.hooks.map((h) => h.name).join(", ")} may run on commit/push.`);
  }
  const fingerprintBody = {
    workPackageId: opts.workPackageId,
    jiraWorkPackageKey: opts.jiraWorkPackageKey ?? snapshot.jiraWorkPackageKey,
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
    jiraWorkPackageKey: jiraKey,
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
): Promise<GitDeliveryJournal & GitWriteFields> {
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
    return {
      ...journal,
      ok: true,
      writeSucceeded: false,
      verificationStatus: "ok",
      partial: false,
      completed: true,
      recoveryInstructions: "Commit already exists at HEAD; retry is a no-op.",
    };
  }
  if (!hasMutationLease()) {
    return authorizeLocal(localMutation(repo, {
      action: "praxis_developer_git_commit",
      operation: "git_commit",
      workItemId: opts.workPackageId,
      previewFingerprint: opts.previewFingerprint,
    }), () => applyCommit(opts));
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
  for (const row of hashes) {
    const expected = preview.fileHashes.find((f) => f.path === row.path)?.sha256;
    if (!row.sha256 || row.sha256 !== expected) {
      throw new VcsError(
        VCS_CODES.GIT_QUALITY_SNAPSHOT_MISMATCH,
        `Committed ${row.path} does not match the Quality snapshot. This commit is not QA-approved.`,
      );
    }
  }
  const entry: GitDeliveryJournal = {
    ...(journal ?? {
      workPackageId: opts.workPackageId,
      forcePush: false as const,
      merged: false as const,
      lifecycle: "not-started",
    }),
    workPackageId: opts.workPackageId,
    jiraWorkPackageKey: opts.jiraWorkPackageKey ?? preview.jiraWorkPackageKey ?? journal?.jiraWorkPackageKey,
    provider: preview.provider,
    repository: repo,
    remoteName: preview.targetRemote ?? journal?.remoteName,
    remoteIdentity: listRemotes(repo).find((r) => r.name === preview.targetRemote)?.identity ?? journal?.remoteIdentity,
    displayRemoteUrl: listRemotes(repo).find((r) => r.name === preview.targetRemote)?.displayUrl ?? journal?.displayRemoteUrl,
    branch: preview.branch,
    featureBranch: preview.branch,
    targetBranch: preview.targetBranch,
    baselineSha: journal?.baselineSha,
    baselineRemoteBranch: journal?.baselineRemoteBranch,
    baseSha: journal?.baselineSha ?? headBefore ?? undefined,
    commitSha,
    commitTreeSha: gitTreeSha(repo, commitSha) ?? undefined,
    selectedFiles: preview.selectedFiles,
    qaReviewId: preview.qualityReviewId,
    qaSnapshotDigest: preview.qualitySnapshotDigest,
    ciStatus: hasGithubWorkflows(repo, commitSha) ? "not_started" : "not_configured",
    lifecycle: extra.length ? "partial" : "committed",
    previewFingerprint: preview.previewFingerprint,
    forcePush: false,
    merged: false,
  };
  writeJournal(repo, entry);
  const saved = readJournal(repo, opts.workPackageId)!;
  return {
    ...saved,
    ok: extra.length === 0,
    writeSucceeded: true,
    verificationStatus: extra.length === 0 ? "ok" : "failed",
    partial: extra.length > 0,
    completed: extra.length === 0,
    errors: extra.length ? [`commit contains extra files: ${extra.join(", ")}`] : undefined,
  };
}

export type GitWriteFields = {
  ok: boolean;
  writeSucceeded: boolean;
  verificationStatus: "ok" | "failed" | "pending" | "skipped";
  partial: boolean;
  completed: boolean;
  recoveryInstructions?: string;
  errors?: string[];
  code?: string;
};

export type PublishPreview = {
  mode: "baseline" | "branch";
  sourceBranch: string;
  sourceCommitSha: string;
  targetRemote: string;
  targetRemoteBranch: string;
  remoteName: string;
  remoteIdentity: string;
  displayRemoteUrl: string;
  githubRepository?: string;
  refspec: string;
  existingRefs: string[];
  remoteEmpty: boolean;
  defaultBranch: string | null;
  branch: string;
  commitSha?: string;
  baselineRequired: boolean;
  force: false;
  secretScan: { blocked: false } | { blocked: true; paths: string[] };
  previewFingerprint: string;
  jiraMutated: false;
};

async function resolveRemoteDefaultBranch(opts: DeliveryInputs, remote: GitRemote): Promise<string> {
  if (opts.targetBranch?.trim()) return opts.targetBranch.trim();
  const journal = readJournal(requireGitRepo(opts.repo), opts.workPackageId);
  if (journal?.baselineRemoteBranch) return journal.baselineRemoteBranch;
  if (journal?.targetBranch && journal.targetBranch !== gitCurrentBranch(requireGitRepo(opts.repo))) {
    return journal.targetBranch;
  }
  try {
    const info = await inspectRemoteRepository(opts);
    if (info && "defaultBranch" in info && info.defaultBranch) return info.defaultBranch;
  } catch {
    /* fall through */
  }
  const kind = resolveProvider({
    inferred: remote.inferredProvider,
    configured: opts.providerKind ?? configuredProvider(),
  });
  return kind === "github" || kind === "gitlab" ? "main" : "main";
}

export async function previewPublish(
  opts: DeliveryInputs & { mode?: "baseline" | "branch" },
): Promise<PublishPreview> {
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
  const sourceBranch =
    mode === "baseline"
      ? (gitCurrentBranch(repo) || "master")
      : (journal?.featureBranch || journal?.branch || defaultBranchName(opts.jiraWorkPackageKey, opts.workPackageId));
  const sourceCommitSha =
    mode === "baseline"
      ? (gitHeadSha(repo) ?? "")
      : (journal?.commitSha || gitHeadSha(repo) || "");
  if (!sourceCommitSha) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "No committed HEAD to publish.");
  }
  const targetRemoteBranch =
    mode === "baseline" ? await resolveRemoteDefaultBranch(opts, remote) : sourceBranch;
  const refspec = `${sourceCommitSha}:refs/heads/${targetRemoteBranch}`;
  let secretBlocked: PublishPreview["secretScan"] = { blocked: false };
  try {
    requireCleanSecretScan(repo, sourceCommitSha);
  } catch (err) {
    if (err instanceof VcsError && err.code === VCS_CODES.GIT_SECRETS_DETECTED) {
      secretBlocked = { blocked: true, paths: (err.details?.paths as string[]) ?? ["(hidden)"] };
    } else {
      throw err;
    }
  }
  const body = {
    mode,
    sourceBranch,
    sourceCommitSha,
    targetRemote: remote.name,
    targetRemoteBranch,
    remoteIdentity: remote.identity,
    displayUrl: remote.displayUrl,
    refspec,
    remoteEmpty: heads.empty,
    existingRefs: heads.refs,
    force: false as const,
    committedFileCount: commitCount(repo, sourceCommitSha),
    committedPathCount: committedPaths(repo, sourceCommitSha).length,
    qualityReviewId: journal?.qaReviewId ?? null,
    qualitySnapshotDigest: journal?.qaSnapshotDigest ?? null,
    commitMessage: journal?.commitSha ? undefined : null,
    githubRepository: remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : remote.identity,
  };
  return {
    mode,
    sourceBranch,
    sourceCommitSha,
    targetRemote: remote.name,
    targetRemoteBranch,
    remoteName: remote.name,
    remoteIdentity: remote.identity,
    displayRemoteUrl: remote.displayUrl,
    githubRepository: remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : remote.identity,
    refspec,
    existingRefs: heads.refs,
    remoteEmpty: heads.empty,
    defaultBranch: targetRemoteBranch,
    branch: mode === "baseline" ? targetRemoteBranch : sourceBranch,
    commitSha: sourceCommitSha,
    baselineRequired: heads.empty && mode === "branch",
    force: false,
    secretScan: secretBlocked,
    previewFingerprint: deliveryFingerprint(body),
    jiraMutated: false,
  };
}

export async function applyPublish(
  opts: DeliveryInputs & { previewFingerprint: string; mode?: "baseline" | "branch" },
): Promise<GitDeliveryJournal & GitWriteFields> {
  const repo = requireGitRepo(opts.repo);
  const journal = readJournal(repo, opts.workPackageId);
  const pub = await previewPublish(opts);
  if (pub.previewFingerprint !== opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, "publish previewFingerprint mismatch; re-run git publish preview");
  }
  if (pub.secretScan.blocked) {
    throw new VcsError(
      VCS_CODES.GIT_SECRETS_DETECTED,
      "GIT_SECRETS_DETECTED: committed objects look like credentials. Values are not shown. Publish is blocked.",
    );
  }
  if (pub.baselineRequired) {
    throw new VcsError(
      VCS_CODES.GIT_BASELINE_REQUIRED,
      "GitHub/GitLab repository has no commits. Human-gated baseline publication is required before a pull/merge request. This will not force-push.",
    );
  }
  const remotes = listRemotes(repo);
  const remote = remotes.find((r) => r.name === pub.targetRemote);
  if (!remote) {
    throw new VcsError(VCS_CODES.GIT_REMOTE_REQUIRED, "Remote delivery is blocked: no remote configured.");
  }
  const heads = lsRemoteHeads(repo, remote.name);
  if (pub.mode === "branch" && heads.empty) {
    throw new VcsError(
      VCS_CODES.GIT_BASELINE_REQUIRED,
      "GitHub/GitLab repository has no commits. Human-gated baseline publication is required before a pull/merge request. This will not force-push.",
    );
  }
  if (!hasMutationLease()) {
    return authorizeLocal(localMutation(repo, {
      action: "praxis_developer_git_publish",
      operation: "git_push",
      workItemId: opts.workPackageId,
      previewFingerprint: opts.previewFingerprint,
    }), () => applyPublish(opts));
  }
  if (pub.mode === "baseline" && !heads.empty) {
    const existingMain = lsRemoteHeadSha(repo, remote.name, pub.targetRemoteBranch);
    if (existingMain && existingMain === pub.sourceCommitSha) {
      const next: GitDeliveryJournal = {
        ...(journal ?? {
          workPackageId: opts.workPackageId,
          forcePush: false,
          merged: false,
          lifecycle: "not-started",
        }),
        repository: repo,
        remoteName: remote.name,
        remoteIdentity: remote.identity,
        displayRemoteUrl: remote.displayUrl,
        baselineSha: pub.sourceCommitSha,
        baselineRemoteBranch: pub.targetRemoteBranch,
        targetBranch: pub.targetRemoteBranch,
        baseSha: pub.sourceCommitSha,
        lifecycle: "baseline-published",
        ciStatus: "not_configured",
        forcePush: false,
        merged: false,
      };
      writeJournal(repo, next);
      const saved = readJournal(repo, opts.workPackageId)!;
      return {
        ...saved,
        ok: true,
        writeSucceeded: false,
        verificationStatus: "ok",
        partial: false,
        completed: true,
        recoveryInstructions: "Baseline already published; retry is a no-op.",
      };
    }
    throw new VcsError(
      VCS_CODES.GIT_REMOTE_HISTORY_CONFLICT,
      "Remote already has history. Baseline publication is skipped. Praxis will not force-push or overwrite it.",
    );
  }
  if (pub.mode === "branch") {
    if (!journal?.commitSha) {
      throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "No local delivery commit. Run git commit first.");
    }
    if (gitHeadSha(repo) !== journal.commitSha) {
      const onBranch = gitCurrentBranch(repo);
      if (onBranch !== journal.branch) checkoutBranch(repo, journal.branch!);
    }
    const remoteFeat = lsRemoteHeadSha(repo, remote.name, pub.targetRemoteBranch);
    if (remoteFeat && remoteFeat === journal.commitSha) {
      const next: GitDeliveryJournal = {
        ...journal,
        lifecycle: "pushed",
        forcePush: false,
        merged: false,
      };
      writeJournal(repo, next);
      const saved = readJournal(repo, opts.workPackageId)!;
      return {
        ...saved,
        ok: true,
        writeSucceeded: false,
        verificationStatus: "ok",
        partial: false,
        completed: true,
      };
    }
  }
  if (pub.mode === "baseline" && gitHeadSha(repo) !== pub.sourceCommitSha) {
    throw new VcsError(
      VCS_CODES.GIT_PREVIEW_STALE,
      "HEAD moved since baseline preview. Re-run publish preview. Working tree is not published.",
    );
  }
  const pushed = pushRefspec(repo, remote.name, pub.sourceCommitSha, pub.targetRemoteBranch, {
    setUpstream: pub.mode === "branch",
  });
  if (pushed.force) {
    throw new VcsError(VCS_CODES.GIT_FORCE_PUSH_FORBIDDEN, "force push is not allowed");
  }
  const after = lsRemoteHeads(repo, remote.name);
  const remoteSha = lsRemoteHeadSha(repo, remote.name, pub.targetRemoteBranch);
  const masterCreated =
    pub.targetRemoteBranch !== "master" && after.refs.some((ref) => ref.endsWith("/master") || ref === "refs/heads/master");
  const verified = remoteSha === pub.sourceCommitSha && !masterCreated;
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
    repository: repo,
    remoteName: remote.name,
    remoteIdentity: remote.identity,
    displayRemoteUrl: remote.displayUrl,
    branch: pub.mode === "branch" ? pub.sourceBranch : journal?.branch,
    featureBranch: journal?.featureBranch ?? journal?.branch,
    targetBranch: pub.mode === "baseline" ? pub.targetRemoteBranch : journal?.targetBranch ?? pub.targetRemoteBranch,
    baselineSha: pub.mode === "baseline" ? pub.sourceCommitSha : journal?.baselineSha,
    baselineRemoteBranch: pub.mode === "baseline" ? pub.targetRemoteBranch : journal?.baselineRemoteBranch,
    baseSha: pub.mode === "baseline" ? pub.sourceCommitSha : journal?.baseSha,
    lifecycle: pub.mode === "baseline" ? "baseline-published" : verified ? "pushed" : "partial",
    ciStatus: hasGithubWorkflows(repo, pub.sourceCommitSha) ? "not_started" : "not_configured",
    previewFingerprint: pub.previewFingerprint,
    forcePush: false,
    merged: false,
  };
  writeJournal(repo, next);
  const saved = readJournal(repo, opts.workPackageId)!;
  return {
    ...saved,
    ok: verified,
    writeSucceeded: true,
    verificationStatus: verified ? "ok" : "failed",
    partial: !verified,
    completed: verified,
    errors: verified
      ? undefined
      : [
          masterCreated
            ? "remote refs/heads/master was created; expected only the GitHub default branch"
            : `remote ${pub.targetRemoteBranch} SHA ${remoteSha ?? "(missing)"} does not match ${pub.sourceCommitSha}`,
        ],
    recoveryInstructions: verified
      ? undefined
      : "Re-run git publish preview. Praxis will not force-push. Confirm the remote ref SHA before retry.",
  };
}

export type MergeRequestPreview = {
  sourceBranch: string;
  targetBranch: string;
  commitSha: string;
  remoteIdentity: string;
  previewFingerprint: string;
  jiraMutated: false;
};

export async function previewMergeRequest(opts: DeliveryInputs): Promise<MergeRequestPreview> {
  const repo = requireGitRepo(opts.repo);
  const journal = readJournal(repo, opts.workPackageId);
  if (!journal?.commitSha || !journal.branch) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "Commit and push the feature branch before a pull request.");
  }
  const remotes = listRemotes(repo);
  const remote = remotes.find((r) => r.name === (opts.remoteName || journal.remoteName)) ?? remotes[0];
  if (!remote) throw new VcsError(VCS_CODES.GIT_REMOTE_REQUIRED, "No remote configured.");
  const targetBranch =
    opts.targetBranch || journal.baselineRemoteBranch || journal.targetBranch || (await resolveRemoteDefaultBranch(opts, remote));
  const remoteHead = lsRemoteHeadSha(repo, remote.name, journal.branch);
  if (!remoteHead) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "Feature branch is not on the remote. Publish the branch first.");
  }
  const plan = {
    sourceBranch: journal.branch,
    targetBranch,
    commitSha: journal.commitSha,
    remoteHead,
    remoteIdentity: remote.identity,
    displayUrl: remote.displayUrl,
    qualityReviewId: journal.qaReviewId ?? null,
  };
  return {
    sourceBranch: journal.branch,
    targetBranch,
    commitSha: journal.commitSha,
    remoteIdentity: remote.identity,
    previewFingerprint: deliveryFingerprint(plan),
    jiraMutated: false,
  };
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
): Promise<GitDeliveryJournal & GitWriteFields> {
  const repo = requireGitRepo(opts.repo);
  const journal = readJournal(repo, opts.workPackageId);
  if (!journal?.commitSha) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "Create the local commit and push before a pull/merge request.");
  }
  if (journal.mergeRequestUrl && journal.lifecycle === "awaiting-review") {
    return {
      ...journal,
      pullRequestUrl: journal.pullRequestUrl ?? journal.mergeRequestUrl,
      ok: true,
      writeSucceeded: false,
      verificationStatus: "ok",
      partial: false,
      completed: true,
      recoveryInstructions: "Pull request already exists; retry is a no-op.",
    };
  }
  if (journal.lifecycle !== "pushed" && journal.lifecycle !== "awaiting-review" && journal.lifecycle !== "partial") {
    if (journal.lifecycle === "committed" || journal.lifecycle === "baseline-published") {
      throw new VcsError(
        VCS_CODES.GIT_PUSH_BLOCKED,
        "Push the feature branch after baseline publication, then create the pull/merge request.",
      );
    }
  }
  const preview = await previewMergeRequest(opts);
  if (opts.previewFingerprint && preview.previewFingerprint !== opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_PREVIEW_STALE, "merge request previewFingerprint mismatch");
  }
  if (!opts.previewFingerprint) {
    throw new VcsError(VCS_CODES.GIT_CONFIRMATION_REQUIRED, "git merge request requires previewFingerprint from git merge-request preview");
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
  const sourceBranch = preview.sourceBranch;
  const targetBranch = preview.targetBranch;
  const remoteHead = lsRemoteHeadSha(repo, remote.name, sourceBranch);
  if (!remoteHead) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "Feature branch is not on the remote. Publish the branch first.");
  }
  if (remoteHead !== journal.commitSha) {
    throw new VcsError(
      VCS_CODES.GIT_COMMIT_DIVERGED,
      "Remote feature SHA does not match the approved local commit. Praxis will not create a PR from a different SHA.",
    );
  }
  if (!hasMutationLease()) {
    return authorizeLocal(localMutation(repo, {
      action: "praxis_developer_git_merge_request",
      operation: "merge_request",
      workItemId: opts.workPackageId,
      previewFingerprint: opts.previewFingerprint,
    }), () => applyMergeRequest(opts));
  }
  const existing = await provider.listOpenMergeRequests({
    owner: remote.owner,
    repo: remote.repo,
    projectPath: remote.projectPath,
    sourceBranch,
    targetBranch,
  });
  const created = !existing[0];
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
  const ciConfigured = hasGithubWorkflows(repo, journal.commitSha);
  const ci = ciConfigured
    ? await provider.pipelineStatus({
        owner: remote.owner,
        repo: remote.repo,
        projectPath: remote.projectPath,
        branch: sourceBranch,
        commitSha: journal.commitSha,
      })
    : { ciStatus: "not_configured" as CiStatus, details: "CI not configured" };
  if (!ciConfigured && ci.ciStatus === "success") {
    ci.ciStatus = "not_configured";
  }
  const verified = mr.targetBranch === targetBranch && mr.sourceBranch === sourceBranch && !mr.merged;
  const next: GitDeliveryJournal = {
    ...journal,
    mergeRequestUrl: mr.url || undefined,
    mergeRequestId: mr.id,
    pullRequestUrl: mr.url || undefined,
    pullRequestNumber: mr.iid ?? mr.id,
    pullRequestBase: mr.targetBranch,
    pullRequestHead: mr.sourceBranch,
    ciStatus: ci.ciStatus,
    lifecycle: verified ? "awaiting-review" : "partial",
    forcePush: false,
    merged: false,
  };
  writeJournal(repo, next);
  const saved = readJournal(repo, opts.workPackageId)!;
  return {
    ...saved,
    ok: verified && Boolean(mr.url),
    writeSucceeded: created || Boolean(mr.url),
    verificationStatus: verified ? "ok" : "failed",
    partial: !verified,
    completed: verified,
    errors: verified ? undefined : ["pull request base/head did not match the approved preview"],
  };
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
  const journal = readJournal(repo, opts.workPackageId);
  if (journal && journal.commitSha && !hasGithubWorkflows(repo, journal.commitSha)) {
    if (journal.ciStatus === "success" || journal.ciStatus === "not_started" || journal.ciStatus === "unknown" || !journal.ciStatus) {
      journal.ciStatus = "not_configured";
    }
  }
  return {
    journal,
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
