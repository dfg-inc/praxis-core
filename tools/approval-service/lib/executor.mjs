/**
 * The Trusted Executor: derives, from the repository itself, what an operation would do (describe), and performs it
 * (execute). Nothing here believes the requester: the agent supplies a few validated parameters (a commit message, a
 * branch, a remote *name*) and the service reads everything else from the repository and its own root-owned config.
 *
 *   commit        plumbing only: write-tree, commit-tree, update-ref with an expected old value (compare-and-swap).
 *                 No `git commit`, so no hooks, no templates, no signing programs.
 *   push          one explicit URL from the service config and one `<sha>:refs/heads/<branch>` refspec; never forced;
 *                 credentials come from the service's own files through GIT_ASKPASS / GIT_SSH_COMMAND.
 *   merge request through a provider interface with strict provider/instance/action scope.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { GitxError, assertRepositorySafe, gitEnvironment, prepareHome, readLocalConfigProblems, runGit } from "./gitx.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const ZERO = "0".repeat(40);
const MAX_LISTED_FILES = 200;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
/** Text the agent supplied, shown to the owner: JSON-quoted with control and bidi characters made visible, so it cannot forge lines or reorder what is read. */
const safeText = (text, max = 2000) =>
  JSON.stringify(String(text).length > max ? `${String(text).slice(0, max)}…[+${String(text).length - max} characters]` : String(text)).replace(CONTROL_OR_BIDI, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : undefined);
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** URL as shown to a human and used as an instance id: credentials and query stripped, local paths marked as such. */
export function remoteIdentity(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? `local-file:${parsed.pathname}` : `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname.replace(/\.git$/, "")}`;
  }
  if (/^[^@\s]+@[^:\s]+:/.test(url)) {
    const [, host, path] = /^[^@]+@([^:]+):(.*)$/.exec(url);
    return `${host}/${path.replace(/\.git$/, "")}`;
  }
  return `local-file:${url}`;
}

export function createExecutor({ config, paths, providers }) {
  const home = join(paths.stateDir, "git-home");
  const { emptyHooksDir } = prepareHome(home);

  // The credential helper is written once at start, never while an operation runs (a concurrent reader could see a truncated script).
  const askpassPath = join(home, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
  const tokenFile = config.credentials?.httpsTokenFile;
  if (tokenFile) {
    const body = process.platform === "win32"
      ? `@echo off\r\necho %1 | findstr /i "Username" >nul && (echo x-access-token) || (type "${tokenFile}")\r\n`
      : `#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) cat '${tokenFile.replaceAll("'", "'\\''")}' ;;\nesac\n`;
    writeFileSync(askpassPath, body, { mode: 0o700 });
    chmodSync(askpassPath, 0o700);
  }

  function credentialEnv(url) {
    const extra = {};
    const credentials = config.credentials ?? {};
    if (/^https:/i.test(url) && tokenFile && existsSync(tokenFile)) {
      if (process.platform !== "win32" && (lstatSync(tokenFile).mode & 0o077)) throw new GitxError("CREDENTIAL_UNSAFE", "the HTTPS token file is readable by group or others; refusing to use it");
      extra.GIT_ASKPASS = askpassPath;
    }
    if (credentials.sshKeyFile && !/^https?:|^file:|^\//i.test(url)) {
      if (process.platform !== "win32" && (lstatSync(credentials.sshKeyFile).mode & 0o077)) throw new GitxError("CREDENTIAL_UNSAFE", "the SSH key file is readable by group or others; refusing to use it");
      extra.GIT_SSH_COMMAND = `ssh -i ${credentials.sshKeyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${join(home, "known_hosts")}`;
    }
    return extra;
  }

  const envFor = (url) => gitEnvironment({ home, pathEnv: config.path, extra: url ? credentialEnv(url) : {} });

  /**
   * Network operations never read the repository's own configuration (the agent can edit it at any moment): they run from
   * a service-owned bare repository whose object store points at the repository's objects, or outside any repository.
   */
  async function shadowFor(repo) {
    const dir = join(home, "shadow", createHash("sha256").update(repo.real).digest("hex").slice(0, 24));
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        execFileSync("git", ["init", "--bare", "-q", dir], { env: envFor(), cwd: home });
      } catch {
        if (!existsSync(join(dir, "HEAD"))) throw new GitxError("GIT_FAILED", "could not create the service's push repository");
      }
    }
    mkdirSync(join(dir, "objects", "info"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "objects", "info", "alternates"), `${join(repo.real, ".git", "objects")}\n`, { mode: 0o600 });
    return dir;
  }
  // A service-owned empty bare repository stands in as GIT_DIR for network commands that need none, so git never goes looking
  // for a repository (and its configuration) from the working directory upwards.
  const neutralDir = join(home, "neutral.git");
  // A remote that is a local path (tests, mirrors) is a repository owned by someone else, and git's ownership check would refuse it,
  // including in the receive-pack child it starts (which does not inherit -c options). Only the exact paths the root-owned
  // configuration names are trusted, in the service's own global git configuration.
  const localRemotePaths = [...new Set((config.repositories ?? []).flatMap((r) => Object.values(r.remotes ?? {})).map((u) => (u.startsWith("file://") ? new URL(u).pathname : u.startsWith("/") ? u : undefined)).filter(Boolean))];
  writeFileSync(join(home, "gitconfig"), `[core]\n\tpager = cat\n[advice]\n\tdetachedHead = false\n${localRemotePaths.map((p) => `[safe]\n\tdirectory = ${p}\n`).join("")}`, { mode: 0o600 });
  const localRemoteConfig = () => [];
  const network = (args, opts) => runGit({ gitDir: neutralDir, cwd: home, args, emptyHooksDir, ...opts });

  if (!existsSync(join(neutralDir, "HEAD"))) execFileSync("git", ["init", "--bare", "-q", neutralDir], { env: envFor(), cwd: home });

  async function open(req) {
    const safe = assertRepositorySafe(req.repository, { allowed: config.repositories ?? [] });
    const env = envFor();
    const problems = await readLocalConfigProblems({ real: safe.real, env, emptyHooksDir, remoteUrls: Object.values(safe.entry.remotes ?? {}) });
    if (problems.length) throw new GitxError("REPOSITORY_UNSAFE", `the repository's local Git configuration is not accepted: ${problems.slice(0, 5).join("; ")}`, { problems });
    const git = (args, opts = {}) => runGit({ repo: safe.real, args, env: opts.env ?? env, emptyHooksDir, ...opts }).then((r) => r);
    return { ...safe, env, git };
  }

  function assertBranchAllowed(entry, branch) {
    // default deny: a repository entry with no "branches" list allows no branch at all
    const patterns = Array.isArray(entry.branches) ? entry.branches : [];
    const ok = patterns.some((p) => (p === "*" ? true : p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : p === branch));
    if (!ok) throw new GitxError("BRANCH_NOT_ALLOWED", `branch ${branch} is not allowed for this repository by the service configuration`);
  }

  async function currentBranch(repo) {
    const { stdout, code } = await repo.git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true });
    if (code !== 0 || !stdout.trim()) throw new GitxError("DETACHED_HEAD", "HEAD is not on a branch");
    return stdout.trim();
  }

  async function revParse(repo, ref) {
    const { stdout, code } = await repo.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { allowFail: true });
    return code === 0 ? stdout.trim() : undefined;
  }

  async function stagedEntries(repo, head) {
    if (head) return parseRaw((await repo.git(["diff-index", "--cached", "--raw", "-z", "--no-renames", head])).stdout);
    return parseLsFiles((await repo.git(["ls-files", "-s", "-z"])).stdout);
  }

  function listFiles(entries) {
    for (const e of entries) if (CONTROL_OR_BIDI.test(e.path)) throw new GitxError("UNSUPPORTED_CHANGE", `a path contains control or direction-changing characters: ${safeText(e.path, 120)}`);
    const shown = entries.slice(0, MAX_LISTED_FILES).map((e) => (e.status === "D" ? `${safeText(e.path, 300)}@deleted` : `${safeText(e.path, 300)}@${e.blob.slice(0, 12)}`));
    if (entries.length > MAX_LISTED_FILES) shown.push(`+${entries.length - MAX_LISTED_FILES} more (sha256:${sha256(entries.map((e) => `${e.path}:${e.blob}`).join("\n"))})`);
    return shown;
  }

  function fingerprintOf(operation, params, targets, revision) {
    return `sha256:${sha256(JSON.stringify({ operation, params, targets, revision }))}`;
  }

  /** @returns {Promise<{described: object, facts: object}>} described is the contracts GitDescribed shape. */
  async function describe(req) {
    const repo = await open(req);
    const result =
      req.operation === "git_commit" ? await describeCommit(req, repo)
      : req.operation === "git_push" ? await describePush(req, repo)
      : req.operation === "merge_request" ? await describeMergeRequest(req, repo)
      : undefined;
    if (!result) throw new GitxError("UNSUPPORTED_OPERATION", "operation is not supported by this service");
    return { ...result, real: repo.real };
  }

  /** A path the agent names for a commit: relative, inside the repository, never in .git, a regular file or a tracked deletion. */
  function checkPaths(repo, paths) {
    const seen = new Set();
    for (const path of paths) {
      if (path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).some((seg) => seg === ".." || seg === "") || /^\.git(\/|$)/i.test(path)) {
        throw new GitxError("BAD_PATH", `path ${JSON.stringify(path)} is not an accepted repository-relative path`);
      }
      if (seen.has(path)) throw new GitxError("BAD_PATH", `path ${JSON.stringify(path)} is listed twice`);
      seen.add(path);
      const parent = join(repo.real, path, "..");
      let realParent;
      try {
        realParent = realpathSync(parent);
      } catch {
        realParent = undefined; // a deleted file's directory may be gone; update-index decides
      }
      if (realParent && realParent !== repo.real && !realParent.startsWith(repo.real + sep)) throw new GitxError("BAD_PATH", `path ${JSON.stringify(path)} resolves outside the repository`);
    }
  }

  /** Reads a regular file without following a link that appears after the check (O_NOFOLLOW), bounded in size. */
  function readRegularFile(abs, label) {
    let fd;
    try {
      fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      throw new GitxError("UNSUPPORTED_CHANGE", `${label} cannot be read as a regular file (${error.code})`);
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new GitxError("UNSUPPORTED_CHANGE", `${label} is not a regular file`);
      if (st.size > MAX_FILE_BYTES) throw new GitxError("UNSUPPORTED_CHANGE", `${label} is larger than ${MAX_FILE_BYTES} bytes`);
      const buffer = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < st.size) {
        const n = readSync(fd, buffer, offset, st.size - offset, offset);
        if (n === 0) break;
        offset += n;
      }
      return { buffer: buffer.subarray(0, offset), executable: Boolean(st.mode & 0o111) };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Builds the tree to commit from HEAD plus exactly the named paths, in a private index file. File contents are hashed
   * as raw bytes (`hash-object --no-filters`), so no clean filter, attribute or line-ending conversion from the
   * agent-controlled repository can run a program or change what is committed.
   */
  async function treeFromPaths(repo, head, paths) {
    checkPaths(repo, paths);
    const tmpIndex = join(home, `index-${randomUUID()}`);
    const env = { ...repo.env, GIT_INDEX_FILE: tmpIndex };
    try {
      if (head) await repo.git(["read-tree", head], { env });
      for (const path of paths) {
        const abs = join(repo.real, path);
        const st = lstatSync(abs, { throwIfNoEntry: false });
        if (!st) {
          await repo.git(["update-index", "--force-remove", "--", path], { env });
          continue;
        }
        if (!st.isFile()) throw new GitxError("UNSUPPORTED_CHANGE", `${path} is not a regular file (links and directories are not committed by this service)`);
        const { buffer, executable } = readRegularFile(abs, path);
        const blob = (await repo.git(["hash-object", "-w", "--no-filters", "--stdin"], { env, input: buffer })).stdout.trim();
        await repo.git(["update-index", "--add", "--cacheinfo", `${executable ? "100755" : "100644"},${blob},${path}`], { env });
      }
      const tree = (await repo.git(["write-tree"], { env })).stdout.trim();
      const raw = head
        ? (await repo.git(["diff-index", "--cached", "--raw", "-z", "--no-renames", head], { env })).stdout
        : (await repo.git(["ls-files", "-s", "-z"], { env })).stdout;
      return { tree, entries: head ? parseRaw(raw) : parseLsFiles(raw) };
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  function parseRaw(stdout) {
    const parts = stdout.split("\0").filter(Boolean);
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [, newMode, , newSha, status] = parts[i].slice(1).split(/[ \t]/);
      out.push({ path: parts[i + 1], mode: newMode, blob: newSha, status });
    }
    return out;
  }

  function parseLsFiles(stdout) {
    return stdout.split("\0").filter(Boolean).map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, blob, stage] = meta.split(" ");
      return { path, mode, blob, status: "A", stage };
    });
  }

  async function describeCommit(req, repo) {
    const current = await currentBranch(repo);
    const branch = req.params.branch ?? current;
    const creating = branch !== current;
    if (creating && (await revParse(repo, `refs/heads/${branch}`))) throw new GitxError("BRANCH_MISMATCH", `HEAD is on ${current}; ${branch} already exists, so the service will not switch to it`);
    assertBranchAllowed(repo.entry, branch);
    const head = await revParse(repo, "HEAD");
    let staged;
    let tree;
    if (req.params.paths) {
      ({ tree, entries: staged } = await treeFromPaths(repo, head, req.params.paths));
      if (!staged.length) throw new GitxError("NOTHING_STAGED", "the named paths do not differ from HEAD; there is nothing to commit");
    } else {
      staged = await stagedEntries(repo, head);
      if (!staged.length) throw new GitxError("NOTHING_STAGED", "nothing is staged and no paths were named; the service commits exactly what is staged or named and never stages anything else");
      tree = (await repo.git(["write-tree"])).stdout.trim();
    }
    if (staged.some((e) => e.mode === "160000" || (e.stage && e.stage !== "0"))) throw new GitxError("UNSUPPORTED_CHANGE", "submodule entries and unmerged paths are not committed by this service");
    const identity = repo.entry.identity ?? config.identity ?? { name: "Praxis Approval Service", email: "approval-service@localhost" };
    const targets = [
      `branch:${branch}`,
      ...(creating ? [`create-branch:${branch}-from-${current}@${head ?? "unborn"}`] : []),
      `source:${req.params.paths ? "named-paths" : "staged-index"}`,
      `tree:${tree}`,
      `message:sha256:${sha256(req.params.message)}`,
      `author:${safeText(`${identity.name} <${identity.email}>`, 200)}`,
      ...listFiles(staged),
    ];
    const revision = head ?? "unborn";
    const fingerprint = fingerprintOf("git_commit", { message: req.params.message, paths: req.params.paths ?? null }, targets, revision);
    return {
      described: {
        instanceId: "local",
        targets,
        revision,
        previewFingerprint: fingerprint,
        summary: `Commit ${staged.length} file(s) to branch ${branch}`,
        description: `${creating ? `Create branch ${branch} from ${current} and ` : ""}create a commit on branch ${branch} from ${head ?? "no parent (first commit)"} containing the tree ${tree} (HEAD plus ${req.params.paths ? "exactly the named paths as they are in the working tree now" : "exactly the staged changes"}). Author ${safeText(`${identity.name} <${identity.email}>`, 200)}. The commit message is text supplied by the agent, shown quoted: ${safeText(req.params.message, 8000)}. Files: ${listFiles(staged).join(", ")}.`,
        risks: ["creates a commit on a local branch; does not push", "reversible: yes, until it is pushed (reset the branch to the previous revision)"],
        branch,
      },
      facts: { branch, current, creating, head, tree, identity, paths: req.params.paths },
    };
  }

  async function describePush(req, repo) {
    const url = own(repo.entry.remotes, req.params.remote);
    if (!url) throw new GitxError("REMOTE_NOT_ALLOWED", `remote ${req.params.remote} is not configured for this repository in the service configuration`);
    assertBranchAllowed(repo.entry, req.params.branch);
    const sha = await revParse(repo, `refs/heads/${req.params.branch}`);
    if (!sha) throw new GitxError("BRANCH_NOT_FOUND", `branch ${req.params.branch} does not exist`);
    const log = (await repo.git(["log", "--format=%h %s", "-n", "10", sha])).stdout.trim().split("\n").filter(Boolean);
    const identity = remoteIdentity(url);
    const targets = [`push:${identity}`, `refspec:${sha}:refs/heads/${req.params.branch}`, "mode:fast-forward-only"];
    return {
      described: {
        instanceId: identity,
        targets,
        revision: sha,
        previewFingerprint: fingerprintOf("git_push", { remote: req.params.remote, branch: req.params.branch }, targets, sha),
        summary: `Push ${req.params.branch} (${sha.slice(0, 12)}) to ${identity}`,
        description: `Push exactly commit ${sha} to refs/heads/${req.params.branch} on ${identity} (remote name ${req.params.remote}). Never forced. Most recent commits (subjects are agent-supplied text): ${log.map((l) => safeText(l, 200)).join("; ")}.`,
        risks: ["publishes commits to a remote", "reversible: not by Praxis; undoing a push needs a force-push by someone with rights on the remote"],
        branch: req.params.branch,
        remote: identity,
      },
      facts: { sha, url, identity },
    };
  }

  async function describeMergeRequest(req, repo) {
    const url = own(repo.entry.remotes, req.params.remote);
    if (!url) throw new GitxError("REMOTE_NOT_ALLOWED", `remote ${req.params.remote} is not configured for this repository in the service configuration`);
    assertBranchAllowed(repo.entry, req.params.sourceBranch);
    const provider = repo.entry.provider;
    if (!provider) throw new GitxError("PROVIDER_NOT_CONFIGURED", "no merge-request provider is configured for this repository");
    providers.assertScope(provider, "create_merge_request");
    const sha = await revParse(repo, `refs/heads/${req.params.sourceBranch}`);
    if (!sha) throw new GitxError("BRANCH_NOT_FOUND", `branch ${req.params.sourceBranch} does not exist`);
    const remote = await network(["ls-remote", "--", url, `refs/heads/${req.params.sourceBranch}`], { env: envFor(url), allowFail: true, extraConfig: localRemoteConfig(url) });
    if (remote.code !== 0 || remote.stdout.split(/\s/)[0] !== sha) {
      throw new GitxError("PUSH_REQUIRED", `the remote does not have ${req.params.sourceBranch} at ${sha.slice(0, 12)}; push it first (a separate approval)`);
    }
    const identity = provider.instanceId;
    const targets = [`merge-request:${req.params.sourceBranch}->${req.params.targetBranch}`, `title:sha256:${sha256(req.params.title)}`, `body:sha256:${sha256(req.params.body ?? "")}`, `remote:${remoteIdentity(url)}`];
    return {
      described: {
        instanceId: identity,
        targets,
        revision: sha,
        previewFingerprint: fingerprintOf("merge_request", req.params, targets, sha),
        summary: `Open a merge request ${req.params.sourceBranch} -> ${req.params.targetBranch} on ${identity}`,
        description: `Open a merge or pull request from ${req.params.sourceBranch} (commit ${sha}) into ${req.params.targetBranch} on ${identity}. Title (agent-supplied text): ${safeText(req.params.title, 300)}. Description (agent-supplied text, posted under the service credential): ${safeText(req.params.body ?? "", 2000)}. It is not merged: merging is a separate capability.`,
        risks: ["creates a review request on the hosting provider", "reversible: yes, the request can be closed"],
        remote: remoteIdentity(url),
      },
      facts: { sha, url, provider },
    };
  }

  /** Runs the approved operation. `approved` is the plan's content string; the caller has already compared it with a fresh describe. */
  async function execute(req, facts) {
    const repo = await open(req);
    if (req.operation === "git_commit") {
      const message = req.params.message;
      const env = gitEnvironment({
        home,
        pathEnv: config.path,
        extra: {
          GIT_AUTHOR_NAME: facts.identity.name,
          GIT_AUTHOR_EMAIL: facts.identity.email,
          GIT_COMMITTER_NAME: facts.identity.name,
          GIT_COMMITTER_EMAIL: facts.identity.email,
        },
      });
      const args = ["commit-tree", facts.tree, ...(facts.head ? ["-p", facts.head] : [])];
      const created = (await repo.git(args, { env, input: `${message}\n` })).stdout.trim();
      // Compare-and-swap: the branch moves only if it is still exactly where it was approved (or still absent when the branch is new).
      const old = facts.creating ? ZERO : (facts.head ?? ZERO);
      await repo.git(["update-ref", "-m", "praxis-approval-service: commit", `refs/heads/${facts.branch}`, created, old]);
      if (facts.creating) await repo.git(["symbolic-ref", "HEAD", `refs/heads/${facts.branch}`]);
      const after = await revParse(repo, `refs/heads/${facts.branch}`);
      if (after !== created) throw new GitxError("POST_CHECK_FAILED", "the branch does not point at the new commit after the update");
      let indexRefreshed = true;
      if (facts.paths) {
        // Bring the repository's own index in line with the new HEAD for the committed paths, as `git commit <paths>` would. Best effort: the commit stands either way.
        try {
          for (const path of facts.paths) await repo.git(["update-index", "--add", "--remove", "--", path]);
        } catch {
          indexRefreshed = false;
        }
      }
      return { operation: "git_commit", commit: created, parent: facts.head ?? null, tree: facts.tree, branch: facts.branch, changed: true, indexRefreshed };
    }
    if (req.operation === "git_push") {
      const env = envFor(facts.url);
      try {
        const shadow = await shadowFor(repo);
        await runGit({ gitDir: shadow, cwd: home, args: ["push", "--porcelain", "--", facts.url, `${facts.sha}:refs/heads/${req.params.branch}`], env, emptyHooksDir, timeoutMs: 180_000, extraConfig: localRemoteConfig(facts.url) });
      } catch (error) {
        error.details = { ...error.details, changed: "nothing: a single-ref push is atomic, the remote branch is unchanged", rollback: "none needed" };
        throw error;
      }
      const verify = await network(["ls-remote", "--", facts.url, `refs/heads/${req.params.branch}`], { env, allowFail: true, extraConfig: localRemoteConfig(facts.url) });
      if (verify.stdout.split(/\s/)[0] !== facts.sha) throw new GitxError("POST_CHECK_FAILED", "the remote does not report the pushed commit after the push", { changed: "unknown: verify on the remote" });
      return { operation: "git_push", pushed: facts.sha, branch: req.params.branch, remote: facts.identity, changed: true };
    }
    if (req.operation === "merge_request") {
      const created = await providers.createMergeRequest(facts.provider, {
        sourceBranch: req.params.sourceBranch,
        targetBranch: req.params.targetBranch,
        title: req.params.title,
        body: req.params.body ?? "",
        sha: facts.sha,
      });
      return { operation: "merge_request", ...created, source: req.params.sourceBranch, target: req.params.targetBranch, changed: true };
    }
    throw new GitxError("UNSUPPORTED_OPERATION", "operation is not supported by this service");
  }

  return { describe, execute, home };
}
