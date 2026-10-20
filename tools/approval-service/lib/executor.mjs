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
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { GitxError, assertRepositorySafe, gitEnvironment, prepareHome, readLocalConfigProblems, runGit } from "./gitx.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const ZERO = "0".repeat(40);
const MAX_LISTED_FILES = 200;

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

  function credentialEnv(url) {
    const extra = {};
    const credentials = config.credentials ?? {};
    if (/^https:/i.test(url) && credentials.httpsTokenFile && existsSync(credentials.httpsTokenFile)) {
      const askpass = join(home, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
      const body = process.platform === "win32"
        ? `@echo off\r\necho %1 | findstr /i "Username" >nul && (echo x-access-token) || (type "${credentials.httpsTokenFile}")\r\n`
        : `#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) cat '${credentials.httpsTokenFile.replaceAll("'", "'\\''")}' ;;\nesac\n`;
      writeFileSync(askpass, body, { mode: 0o700 });
      chmodSync(askpass, 0o700);
      extra.GIT_ASKPASS = askpass;
    }
    if (credentials.sshKeyFile && !/^https?:|^file:|^\//i.test(url)) {
      extra.GIT_SSH_COMMAND = `ssh -i ${credentials.sshKeyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${join(home, "known_hosts")}`;
    }
    return extra;
  }

  const envFor = (url) => gitEnvironment({ home, pathEnv: config.path, extra: url ? credentialEnv(url) : {} });

  async function open(req) {
    const safe = assertRepositorySafe(req.repository, { allowed: config.repositories ?? [] });
    const env = envFor();
    const problems = await readLocalConfigProblems({ real: safe.real, env, emptyHooksDir, remoteUrls: Object.values(safe.entry.remotes ?? {}) });
    if (problems.length) throw new GitxError("REPOSITORY_UNSAFE", `the repository's local Git configuration is not accepted: ${problems.slice(0, 5).join("; ")}`, { problems });
    const git = (args, opts = {}) => runGit({ repo: safe.real, args, env: opts.env ?? env, emptyHooksDir, ...opts }).then((r) => r);
    return { ...safe, env, git };
  }

  function assertBranchAllowed(entry, branch) {
    const patterns = entry.branches ?? ["*"];
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
    const shown = entries.slice(0, MAX_LISTED_FILES).map((e) => (e.status === "D" ? `${e.path}@deleted` : `${e.path}@${e.blob.slice(0, 12)}`));
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

  /** Builds the tree to commit from HEAD plus exactly the named paths, in a private index file, without touching the repository's index. */
  async function treeFromPaths(repo, head, paths) {
    checkPaths(repo, paths);
    const tmpIndex = join(home, `index-${randomUUID()}`);
    const env = { ...repo.env, GIT_INDEX_FILE: tmpIndex };
    try {
      if (head) await repo.git(["read-tree", head], { env });
      for (const path of paths) {
        const st = lstatSync(join(repo.real, path), { throwIfNoEntry: false });
        if (st && !st.isFile()) throw new GitxError("UNSUPPORTED_CHANGE", `${path} is not a regular file (links and directories are not committed by this service)`);
        await repo.git(["update-index", "--add", "--remove", "--", path], { env });
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
      `author:${identity.name} <${identity.email}>`,
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
        description: `${creating ? `Create branch ${branch} from ${current} and ` : ""}create a commit on branch ${branch} from ${head ?? "no parent (first commit)"} containing the tree ${tree} (HEAD plus ${req.params.paths ? "exactly the named paths as they are in the working tree now" : "exactly the staged changes"}). Author ${identity.name} <${identity.email}>. The commit message is text supplied by the agent, shown verbatim: ${JSON.stringify(req.params.message)}. Files: ${listFiles(staged).join(", ")}.`,
        risks: ["creates a commit on a local branch; does not push", "reversible: yes, until it is pushed (reset the branch to the previous revision)"],
        branch,
      },
      facts: { branch, current, creating, head, tree, identity, paths: req.params.paths },
    };
  }

  async function describePush(req, repo) {
    const url = repo.entry.remotes?.[req.params.remote];
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
        description: `Push exactly commit ${sha} to refs/heads/${req.params.branch} on ${identity} (remote name ${req.params.remote}). Never forced. Most recent commits (subjects are agent-supplied text): ${log.map((l) => JSON.stringify(l)).join("; ")}.`,
        risks: ["publishes commits to a remote", "reversible: not by Praxis; undoing a push needs a force-push by someone with rights on the remote"],
        branch: req.params.branch,
        remote: identity,
      },
      facts: { sha, url, identity },
    };
  }

  async function describeMergeRequest(req, repo) {
    const url = repo.entry.remotes?.[req.params.remote];
    if (!url) throw new GitxError("REMOTE_NOT_ALLOWED", `remote ${req.params.remote} is not configured for this repository in the service configuration`);
    assertBranchAllowed(repo.entry, req.params.sourceBranch);
    const provider = repo.entry.provider;
    if (!provider) throw new GitxError("PROVIDER_NOT_CONFIGURED", "no merge-request provider is configured for this repository");
    providers.assertScope(provider, "create_merge_request");
    const sha = await revParse(repo, `refs/heads/${req.params.sourceBranch}`);
    if (!sha) throw new GitxError("BRANCH_NOT_FOUND", `branch ${req.params.sourceBranch} does not exist`);
    const remote = await repo.git(["ls-remote", url, `refs/heads/${req.params.sourceBranch}`], { env: envFor(url), allowFail: true });
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
        description: `Open a merge or pull request from ${req.params.sourceBranch} (commit ${sha}) into ${req.params.targetBranch} on ${identity}. Title (agent-supplied text): ${JSON.stringify(req.params.title)}. It is not merged: merging is a separate capability.`,
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
        await repo.git(["push", "--porcelain", "--", facts.url, `${facts.sha}:refs/heads/${req.params.branch}`], { env, timeoutMs: 180_000 });
      } catch (error) {
        error.details = { ...error.details, changed: "nothing: a single-ref push is atomic, the remote branch is unchanged", rollback: "none needed" };
        throw error;
      }
      const verify = await repo.git(["ls-remote", facts.url, `refs/heads/${req.params.branch}`], { env, allowFail: true });
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
