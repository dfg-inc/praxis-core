import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { redactSecrets } from "./redact.js";
import { parseRemoteUrl, type ParsedRemote } from "./git-url.js";
import { VCS_CODES, VcsError } from "./errors.js";

export type GitRunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type GitIdentity = {
  localName: string | null;
  localEmail: string | null;
  globalName: string | null;
  globalEmail: string | null;
  authorIdent: string | null;
  committerIdent: string | null;
  name: string | null;
  email: string | null;
  configured: boolean;
};

export type GitRemote = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  displayUrl: string;
  identity: string;
  protocol: ParsedRemote["protocol"];
  host: string;
  inferredProvider: ParsedRemote["inferredProvider"];
  owner?: string;
  repo?: string;
  projectPath?: string;
};

export type GitWorkingTree = {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  dirty: boolean;
};

export type GitHookInfo = { name: string; executable: boolean };

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: process.env.GIT_ASKPASS ?? "",
  };
}

export function runGit(
  repo: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): GitRunResult {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 30_000,
    env: gitEnv(opts?.env),
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: redactSecrets(r.stderr ?? r.error?.message ?? ""),
  };
}

export function requireGitRepo(cwd: string): string {
  const r = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) {
    throw new VcsError(
      VCS_CODES.GIT_REPOSITORY_UNAVAILABLE,
      `GIT_REPOSITORY_UNAVAILABLE: not a git repository (${cwd})`,
    );
  }
  return r.stdout.trim();
}

export function gitHeadSha(repo: string): string | null {
  const r = runGit(repo, ["rev-parse", "HEAD"]);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export function gitCurrentBranch(repo: string): string | null {
  const r = runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.status !== 0) return null;
  const name = r.stdout.trim();
  return name && name !== "HEAD" ? name : null;
}

function configGet(repo: string, key: string, scope: "local" | "global"): string | null {
  const r = runGit(repo, ["config", `--${scope}`, "--get", key]);
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

function parseIdent(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^(.*)\s+<([^>]+)>/);
  if (!m) return { name: raw.trim() || null, email: null };
  return { name: m[1]!.trim() || null, email: m[2]!.trim() || null };
}

export function readGitIdentity(repo: string): GitIdentity {
  const localName = configGet(repo, "user.name", "local");
  const localEmail = configGet(repo, "user.email", "local");
  const globalName = configGet(repo, "user.name", "global");
  const globalEmail = configGet(repo, "user.email", "global");
  const authorRaw = runGit(repo, ["var", "GIT_AUTHOR_IDENT"]).status === 0
    ? runGit(repo, ["var", "GIT_AUTHOR_IDENT"]).stdout.trim() || null
    : null;
  const committerRaw = runGit(repo, ["var", "GIT_COMMITTER_IDENT"]).status === 0
    ? runGit(repo, ["var", "GIT_COMMITTER_IDENT"]).stdout.trim() || null
    : null;
  const author = parseIdent(authorRaw);
  const name = localName || globalName || author.name;
  const email = localEmail || globalEmail || author.email;
  const configured = Boolean((localName || globalName) && (localEmail || globalEmail));
  return {
    localName,
    localEmail,
    globalName,
    globalEmail,
    authorIdent: authorRaw,
    committerIdent: committerRaw,
    name: configured ? name : null,
    email: configured ? email : null,
    configured,
  };
}

export function listRemotes(repo: string): GitRemote[] {
  const names = runGit(repo, ["remote"]);
  if (names.status !== 0 || !names.stdout.trim()) return [];
  const remotes: GitRemote[] = [];
  for (const name of splitNames(names.stdout)) {
    const fetchCfg = runGit(repo, ["config", "--get", `remote.${name}.url`]);
    const pushCfg = runGit(repo, ["config", "--get", `remote.${name}.pushurl`]);
    const fetchUrl = fetchCfg.stdout.trim();
    if (!fetchUrl) continue;
    const pushUrl = pushCfg.stdout.trim() || fetchUrl;
    const parsed = parseRemoteUrl(fetchUrl);
    remotes.push({
      name,
      fetchUrl,
      pushUrl,
      displayUrl: parsed.displayUrl,
      identity: parsed.identity,
      protocol: parsed.protocol,
      host: parsed.host,
      inferredProvider: parsed.inferredProvider,
      owner: parsed.owner,
      repo: parsed.repo,
      projectPath: parsed.projectPath,
    });
  }
  return remotes;
}

export function readWorkingTree(repo: string): GitWorkingTree {
  const stagedR = runGit(repo, ["diff", "--cached", "--name-only", "--diff-filter=ACDMR"]);
  const unstagedR = runGit(repo, ["diff", "--name-only"]);
  const untrackedR = runGit(repo, ["ls-files", "--others", "--exclude-standard"]);
  const staged = splitNames(stagedR.stdout);
  const unstaged = splitNames(unstagedR.stdout);
  const untracked = splitNames(untrackedR.stdout);
  return {
    staged,
    unstaged,
    untracked,
    dirty: staged.length + unstaged.length + untracked.length > 0,
  };
}

function splitNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fileSha256(repo: string, rel: string): string | null {
  const abs = join(repo, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return createHash("sha256").update(readFileSync(abs, "utf8")).digest("hex");
}

export function committedFileSha256(repo: string, rev: string, rel: string): string | null {
  const r = runGit(repo, ["show", `${rev}:${rel}`]);
  if (r.status !== 0) return null;
  return createHash("sha256").update(r.stdout).digest("hex");
}

export function listCommitFiles(repo: string, rev: string): string[] {
  const r = runGit(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", rev]);
  if (r.status !== 0) return [];
  return splitNames(r.stdout);
}

export function listHooks(repo: string): GitHookInfo[] {
  const dir = join(repo, ".git", "hooks");
  if (!existsSync(dir)) return [];
  const out: GitHookInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".sample")) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      const executable = (st.mode & 0o111) !== 0;
      if (executable) out.push({ name, executable });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function branchExists(repo: string, name: string): boolean {
  return runGit(repo, ["rev-parse", "--verify", name]).status === 0;
}

export function createBranch(repo: string, name: string): void {
  const r = runGit(repo, ["checkout", "-b", name]);
  if (r.status !== 0) {
    throw new VcsError(VCS_CODES.GIT_STAGING_BLOCKED, redactSecrets(r.stderr || "git checkout -b failed"));
  }
}

export function checkoutBranch(repo: string, name: string): void {
  const r = runGit(repo, ["checkout", name]);
  if (r.status !== 0) {
    throw new VcsError(VCS_CODES.GIT_STAGING_BLOCKED, redactSecrets(r.stderr || "git checkout failed"));
  }
}

export function stagePaths(repo: string, paths: string[]): void {
  if (paths.length === 0) return;
  const r = runGit(repo, ["add", "--", ...paths]);
  if (r.status !== 0) {
    throw new VcsError(VCS_CODES.GIT_STAGING_BLOCKED, redactSecrets(r.stderr || "git add failed"));
  }
}

export function commitStaged(repo: string, message: string): string {
  const r = runGit(repo, ["commit", "-m", message]);
  if (r.status !== 0) {
    throw new VcsError(VCS_CODES.GIT_STAGING_BLOCKED, redactSecrets(r.stderr || "git commit failed"));
  }
  const sha = gitHeadSha(repo);
  if (!sha) throw new VcsError(VCS_CODES.GIT_COMMIT_DIVERGED, "commit succeeded but HEAD SHA is missing");
  return sha;
}

export function gitTreeSha(repo: string, rev = "HEAD"): string | null {
  const r = runGit(repo, ["rev-parse", `${rev}^{tree}`]);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export function addRemote(repo: string, name: string, url: string): void {
  const r = runGit(repo, ["remote", "add", name, url]);
  if (r.status !== 0) {
    throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, redactSecrets(r.stderr || "git remote add failed"));
  }
}

export function setRemoteUrl(repo: string, name: string, url: string): void {
  const r = runGit(repo, ["remote", "set-url", name, url]);
  if (r.status !== 0) {
    throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, redactSecrets(r.stderr || "git remote set-url failed"));
  }
}

export function setLocalIdentity(repo: string, name: string, email: string): void {
  const n = runGit(repo, ["config", "user.name", name]);
  const e = runGit(repo, ["config", "user.email", email]);
  if (n.status !== 0 || e.status !== 0) {
    throw new VcsError(
      VCS_CODES.GIT_IDENTITY_REQUIRED,
      redactSecrets(n.stderr || e.stderr || "git config user.name/email failed"),
    );
  }
}

export function lsRemoteHeads(repo: string, remote: string): { empty: boolean; refs: string[] } {
  const r = runGit(repo, ["ls-remote", "--heads", remote], { timeoutMs: 20_000 });
  if (r.status !== 0) {
    throw new VcsError(
      VCS_CODES.GIT_TRANSPORT_FAILED,
      redactSecrets(r.stderr || `git ls-remote failed for ${remote}`),
    );
  }
  const refs = splitNames(r.stdout).map((line) => line.replace(/^[0-9a-f]+\s+/, ""));
  return { empty: refs.length === 0, refs };
}

export function pushBranch(
  repo: string,
  remote: string,
  branch: string,
  opts?: { setUpstream?: boolean },
): { pushed: true; force: false } {
  const args = ["push"];
  if (opts?.setUpstream !== false) args.push("-u");
  args.push(remote, branch);
  if (args.includes("--force") || args.includes("-f") || args.includes("--force-with-lease")) {
    throw new VcsError(VCS_CODES.GIT_FORCE_PUSH_FORBIDDEN, "force push is not allowed");
  }
  const r = runGit(repo, args, { timeoutMs: 60_000 });
  if (r.status !== 0) {
    const err = r.stderr.toLowerCase();
    if (err.includes("non-fast-forward") || err.includes("rejected")) {
      throw new VcsError(VCS_CODES.GIT_REMOTE_HISTORY_CONFLICT, redactSecrets(r.stderr), {
        remote,
        branch,
        force: false,
      });
    }
    throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, redactSecrets(r.stderr || "git push failed"), {
      remote,
      branch,
      force: false,
    });
  }
  return { pushed: true, force: false };
}

export function remoteBranchExists(repo: string, remote: string, branch: string): boolean {
  const r = runGit(repo, ["ls-remote", "--heads", remote, branch]);
  if (r.status !== 0) return false;
  return r.stdout.trim().length > 0;
}

export function lsRemoteHeadSha(repo: string, remote: string, branch: string): string | null {
  const r = runGit(repo, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  if (r.status !== 0) return null;
  const line = r.stdout.trim().split("\n")[0] ?? "";
  const sha = line.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export function pushRefspec(
  repo: string,
  remote: string,
  source: string,
  destinationBranch: string,
  opts?: { setUpstream?: boolean },
): { pushed: true; force: false; refspec: string } {
  if (!destinationBranch || destinationBranch.includes("..") || destinationBranch.startsWith("-")) {
    throw new VcsError(VCS_CODES.GIT_PUSH_BLOCKED, "invalid destination branch");
  }
  if (source.startsWith("+") || destinationBranch.startsWith("+")) {
    throw new VcsError(VCS_CODES.GIT_FORCE_PUSH_FORBIDDEN, "force push is not allowed");
  }
  const dest = `refs/heads/${destinationBranch}`;
  const refspec = `${source}:${dest}`;
  const args = ["push"];
  const shaSource = /^[0-9a-f]{40}$/i.test(source);
  if (opts?.setUpstream && !shaSource) args.push("-u");
  args.push(remote, refspec);
  if (args.includes("--force") || args.includes("-f") || args.includes("--force-with-lease")) {
    throw new VcsError(VCS_CODES.GIT_FORCE_PUSH_FORBIDDEN, "force push is not allowed");
  }
  const r = runGit(repo, args, { timeoutMs: 60_000 });
  if (r.status !== 0) {
    const err = r.stderr.toLowerCase();
    if (err.includes("non-fast-forward") || err.includes("rejected")) {
      throw new VcsError(VCS_CODES.GIT_REMOTE_HISTORY_CONFLICT, redactSecrets(r.stderr), {
        remote,
        destinationBranch,
        force: false,
      });
    }
    throw new VcsError(VCS_CODES.GIT_TRANSPORT_FAILED, redactSecrets(r.stderr || "git push failed"), {
      remote,
      destinationBranch,
      force: false,
    });
  }
  return { pushed: true, force: false, refspec };
}

export function committedPaths(repo: string, rev = "HEAD"): string[] {
  const r = runGit(repo, ["ls-tree", "-r", "--name-only", rev]);
  if (r.status !== 0) return [];
  return splitNames(r.stdout);
}

export function commitCount(repo: string, rev = "HEAD"): number {
  const r = runGit(repo, ["rev-list", "--count", rev]);
  if (r.status !== 0) return 0;
  return Number(r.stdout.trim()) || 0;
}

export function hasGithubWorkflows(repo: string, rev = "HEAD"): boolean {
  return committedPaths(repo, rev).some(
    (p) => p.startsWith(".github/workflows/") && (p.endsWith(".yml") || p.endsWith(".yaml")),
  );
}

export function writeTextFile(repo: string, rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

export function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}
