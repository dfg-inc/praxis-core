import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runApprovedForTest } from "@praxis/contracts";
import {
  applyCommit as applyCommitRaw,
  applyConnect as applyConnectRaw,
  applyMergeRequest as applyMergeRequestRaw,
  applyPublish as applyPublishRaw,
  createGithubProvider,
  createGitlabProvider,
  createMockGithubFetch,
  createMockGithubState,
  createMockGitlabFetch,
  createMockGitlabState,
  exactRemoteUrlsEqual,
  inspectDeliveryStatus,
  inspectGitStatus,
  listRemotes,
  lsRemoteHeads,
  mergeGitStatusRemote,
  parseRemoteUrl,
  planStaging,
  previewConnect,
  previewDelivery,
  previewMergeRequest,
  previewPublish,
  readJournal,
  redactRemoteUrl,
  setRemoteUrl,
  validateGithubApiUrl,
  VCS_CODES,
} from "../src/index.js";

const WP = "WP-20260914-002";

function applyConnect(opts: Parameters<typeof applyConnectRaw>[0]) {
  return runApprovedForTest("praxis_developer_git_connect_apply", () => applyConnectRaw(opts));
}

function applyCommit(opts: Parameters<typeof applyCommitRaw>[0]) {
  return runApprovedForTest("praxis_developer_git_commit", () => applyCommitRaw(opts));
}

function applyPublish(opts: Parameters<typeof applyPublishRaw>[0]) {
  return runApprovedForTest("praxis_developer_git_publish", () => applyPublishRaw(opts));
}

function withDeliveryLease<T>(write: () => T): T {
  return runApprovedForTest("praxis_developer_git_merge_request", write);
}

function applyMergeRequest(opts: Parameters<typeof applyMergeRequestRaw>[0]) {
  return runApprovedForTest("praxis_developer_git_merge_request", () => applyMergeRequestRaw(opts));
}

function sha(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv) {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if ((r.status ?? 1) !== 0) throw new Error(r.stderr || r.stdout || args.join(" "));
  return r.stdout.trim();
}

function tmpRepo(opts?: { identity?: boolean }) {
  const repo = mkdtempSync(join(tmpdir(), "praxis-vcs-"));
  git(repo, ["init", "-b", "master"]);
  if (opts?.identity !== false) {
    git(repo, ["config", "user.name", "Dev"]);
    git(repo, ["config", "user.email", "dev@example.com"]);
  } else {
    git(repo, ["config", "--local", "user.name", ""]);
    git(repo, ["config", "--local", "user.email", ""]);
  }
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

function seedProduct(repo: string, counter = "export function reset(){return 0}\n", test = "ok\n") {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/counter.js"), counter);
  writeFileSync(join(repo, "src/counter.test.js"), test);
  mkdirSync(join(repo, "design", WP, "qa"), { recursive: true });
  writeFileSync(
    join(repo, "design", WP, "qa", "quality-review.json"),
    JSON.stringify({
      reviewId: 1,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      verdict: "PASSED",
      approvalApplied: true,
      snapshot: {
        digest: "d",
        files: [
          { path: "src/counter.js", sha256: sha(counter) },
          { path: "src/counter.test.js", sha256: sha(test) },
        ],
      },
    }),
  );
}

describe("git url", () => {
  it("redacts HTTPS credentials and infers GitHub", () => {
    const p = parseRemoteUrl("https://user:ghp_secretsecret@github.com/hisagedru/praxis-acceptance-test.git");
    expect(p.inferredProvider).toBe("github");
    expect(p.identity).toBe("github.com/hisagedru/praxis-acceptance-test");
    expect(redactRemoteUrl(p.raw)).not.toMatch(/ghp_/);
    expect(p.displayUrl).not.toMatch(/secret/);
  });

  it("parses SSH GitLab self-managed without guessing Praxis hosts", () => {
    const p = parseRemoteUrl("git@gitlab.example.com:group/project.git");
    expect(p.protocol).toBe("ssh");
    expect(p.inferredProvider).toBe("gitlab");
    expect(p.identity).not.toContain("gl.jetru.by");
  });
});

describe("staging policy", () => {
  it("rejects runtime artifacts and keeps allowlist", () => {
    const plan = planStaging({
      allowlist: ["src/counter.js"],
      staged: [],
      unstaged: ["package.json"],
      untracked: [".praxis-quality/quality.sqlite", ".npmrc", ".project", "design/x.md"],
    });
    expect(plan.selected).toEqual(["src/counter.js"]);
    expect(plan.rejected.some((r) => r.reason === "sensitive" && r.path.includes(".praxis-quality"))).toBe(true);
    expect(plan.rejected.some((r) => r.path === ".npmrc")).toBe(true);
    expect(plan.rejected.some((r) => r.reason === "opt-in-required")).toBe(true);
  });
});

describe("git status / connect", () => {
  it("reports no remote without guessing a host", () => {
    const repo = tmpRepo();
    seedProduct(repo);
    const st = inspectGitStatus({ repo, workPackageId: WP });
    expect(st.remoteConfigured).toBe(false);
    expect(st.provider).toBe("unknown");
    expect(st.pushReady).toBe(false);
    expect(st.mergeRequestReady).toBe(false);
    expect(JSON.stringify(st)).not.toMatch(/gl\.jetru\.by/);
  });

  it("requires identity when local and global name/email are unset", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-vcs-noid-"));
    const emptyCfg = join(repo, "empty.gitconfig");
    writeFileSync(emptyCfg, "");
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = emptyCfg;
    process.env.GIT_CONFIG_SYSTEM = emptyCfg;
    try {
      spawnSync("git", ["init", "-b", "master"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "x\n");
      spawnSync("git", ["-c", "user.name=Tmp", "-c", "user.email=t@t.t", "add", "."], { cwd: repo });
      spawnSync("git", ["-c", "user.name=Tmp", "-c", "user.email=t@t.t", "commit", "-m", "i"], { cwd: repo });
      const st = inspectGitStatus({ repo, workPackageId: WP });
      expect(st.identity.configured).toBe(false);
      expect(st.configurationRequirements.some((c) => c.includes("GIT_IDENTITY_REQUIRED"))).toBe(true);
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prevSystem;
    }
  });

  it("previews connect without adding origin", () => {
    const repo = tmpRepo();
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: "https://github.com/hisagedru/praxis-acceptance-test.git",
      providerKind: "github",
    });
    expect(preview.createsRemote).toBe(true);
    expect(preview.provider).toBe("github");
    expect(inspectGitStatus({ repo, workPackageId: WP }).remoteConfigured).toBe(false);
  });

  it("updates origin HTTPS to SSH for the same repository identity", () => {
    const repo = tmpRepo();
    git(repo, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test"]);
    const https = "https://github.com/hisagedru/praxis-acceptance-test";
    const ssh = "git@github.com:hisagedru/praxis-acceptance-test.git";
    expect(parseRemoteUrl(https).identity).toBe(parseRemoteUrl(ssh).identity);
    expect(exactRemoteUrlsEqual(https, ssh)).toBe(false);
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: ssh,
      providerKind: "github",
    });
    expect(preview.createsRemote).toBe(false);
    expect(preview.updatesExistingUrl).toBe(true);
    expect(preview.proposedProtocol).toBe("ssh");
    const applied = applyConnect({
      repo,
      workPackageId: WP,
      remoteUrl: ssh,
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    });
    expect(applied.wrote).toBe(true);
    expect(applied.configurationWriteSucceeded).toBe(true);
    expect(applied.previewFingerprint).toBe(preview.previewFingerprint);
    expect(applied.actualProtocol).toBe("ssh");
    expect(listRemotes(repo)[0]?.fetchUrl).toBe(ssh);
    expect(listRemotes(repo).filter((r) => r.name === "origin")).toHaveLength(1);
    const head = git(repo, ["rev-parse", "HEAD"]);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("updates origin SSH to HTTPS for the same repository identity", () => {
    const repo = tmpRepo();
    git(repo, ["remote", "add", "origin", "git@github.com:hisagedru/praxis-acceptance-test.git"]);
    const https = "https://github.com/hisagedru/praxis-acceptance-test.git";
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: https,
      providerKind: "github",
    });
    const applied = applyConnect({
      repo,
      workPackageId: WP,
      remoteUrl: https,
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    });
    expect(applied.wrote).toBe(true);
    expect(listRemotes(repo)[0]?.protocol).toBe("https");
    expect(listRemotes(repo)[0]?.fetchUrl).toBe(https);
  });

  it("does not rewrite the same exact URL", () => {
    const repo = tmpRepo();
    const url = "https://github.com/hisagedru/praxis-acceptance-test.git";
    git(repo, ["remote", "add", "origin", url]);
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: url,
      providerKind: "github",
    });
    expect(preview.updatesExistingUrl).toBe(false);
    const applied = applyConnect({
      repo,
      workPackageId: WP,
      remoteUrl: url,
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    });
    expect(applied.wrote).toBe(false);
    expect(applied.ok).toBe(true);
    expect(applied.previewFingerprint).toBe(preview.previewFingerprint);
    expect(listRemotes(repo)[0]?.fetchUrl).toBe(url);
  });

  it("updates origin when the repository identity changes", () => {
    const repo = tmpRepo();
    git(repo, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test.git"]);
    const next = "https://github.com/example/other.git";
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: next,
      providerKind: "github",
    });
    const applied = applyConnect({
      repo,
      workPackageId: WP,
      remoteUrl: next,
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    });
    expect(applied.wrote).toBe(true);
    expect(applied.actualIdentity).toBe("github.com/example/other");
    expect(listRemotes(repo).filter((r) => r.name === "origin")).toHaveLength(1);
  });

  it("keeps the approved connect fingerprint after a first remote add", () => {
    const repo = tmpRepo();
    const url = "https://github.com/hisagedru/praxis-acceptance-test.git";
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: url,
      providerKind: "github",
    });
    expect(preview.createsRemote).toBe(true);
    const applied = applyConnect({
      repo,
      workPackageId: WP,
      remoteUrl: url,
      providerKind: "github",
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: false,
    });
    expect(applied.wrote).toBe(true);
    expect(applied.createsRemote).toBe(true);
    expect(applied.previewFingerprint).toBe(preview.previewFingerprint);
    const reread = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: url,
      providerKind: "github",
    });
    expect(reread.createsRemote).toBe(false);
    expect(reread.previewFingerprint).not.toBe(preview.previewFingerprint);
  });

  it("reports git remote set-url failure without claiming wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "praxis-vcs-nowrite-"));
    expect(() => setRemoteUrl(dir, "origin", "git@github.com:hisagedru/praxis-acceptance-test.git")).toThrow(
      /not authorized/,
    );
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "fails accurately when git remote set-url cannot write",
    () => {
      const repo = tmpRepo();
      git(repo, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test.git"]);
      const next = "git@github.com:hisagedru/praxis-acceptance-test.git";
      const preview = previewConnect({
        repo,
        workPackageId: WP,
        remoteUrl: next,
        providerKind: "github",
      });
      const gitDir = join(repo, ".git");
      spawnSync("chmod", ["a-w", gitDir], { encoding: "utf8" });
      try {
        applyConnect({
          repo,
          workPackageId: WP,
          remoteUrl: next,
          providerKind: "github",
          previewFingerprint: preview.previewFingerprint,
          probeRemoteAccess: false,
        });
        throw new Error("expected connect write to fail");
      } catch (err) {
        spawnSync("chmod", ["u+w", gitDir], { encoding: "utf8" });
        if (err instanceof Error && err.message === "expected connect write to fail") throw err;
        expect((err as { code?: string }).code).toBe(VCS_CODES.GIT_TRANSPORT_FAILED);
        expect(listRemotes(repo)[0]?.protocol).toBe("https");
      } finally {
        spawnSync("chmod", ["u+w", gitDir], { encoding: "utf8" });
      }
    },
  );

  it("reports configuration write succeeded when access check fails", () => {
    const repo = tmpRepo();
    const missing = join(repo, "missing-remote.git");
    git(repo, ["remote", "add", "origin", join(repo, "unused.git")]);
    const preview = previewConnect({
      repo,
      workPackageId: WP,
      remoteUrl: missing,
    });
    const applied = applyConnect({
      repo,
      workPackageId: WP,
      remoteUrl: missing,
      previewFingerprint: preview.previewFingerprint,
      probeRemoteAccess: true,
    });
    expect(applied.wrote).toBe(true);
    expect(applied.configurationWriteSucceeded).toBe(true);
    expect(applied.accessCheck).toBe("failed");
    expect(applied.ok).toBe(false);
    expect(listRemotes(repo)[0]?.fetchUrl).toBe(missing);
  });

  it("aggregates GitHub API empty=true onto remoteEmpty and baselineRequired", () => {
    const repo = tmpRepo();
    git(repo, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test.git"]);
    const status = inspectGitStatus({ repo, workPackageId: WP });
    expect(status.remoteEmpty).toBeNull();
    expect(status.baselineRequired).toBeNull();
    const merged = mergeGitStatusRemote(status, {
      provider: "github",
      identity: "hisagedru/praxis-acceptance-test",
      owner: "hisagedru",
      repo: "praxis-acceptance-test",
      defaultBranch: "main",
      empty: true,
      hasReadme: false,
    });
    expect(merged.remote.empty).toBe(true);
    expect(merged.remoteEmpty).toBe(true);
    expect(merged.baselineRequired).toBe(true);
  });

  it("does not turn unknown emptiness into false when the API is unavailable", () => {
    const repo = tmpRepo();
    git(repo, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test.git"]);
    const status = inspectGitStatus({ repo, workPackageId: WP });
    const merged = mergeGitStatusRemote(status, {
      remoteConfigured: true,
      inspectFailed: true,
      inspectError: "GITHUB_TOKEN_UNAVAILABLE",
    });
    expect(merged.remoteEmpty).toBeNull();
    expect(merged.baselineRequired).toBeNull();
    expect(JSON.stringify(merged)).not.toMatch(/ghp_|github_pat_/);
  });
});

describe("GitHub API URL", () => {
  it("accepts api.github.com and rejects git remotes", () => {
    expect(validateGithubApiUrl("https://api.github.com").ok).toBe(true);
    expect(validateGithubApiUrl("https://api.github.com/").ok).toBe(true);
    expect(validateGithubApiUrl(undefined).ok).toBe(true);
    expect(validateGithubApiUrl("git@github.com:hisagedru/praxis-acceptance-test.git").ok).toBe(false);
    expect(validateGithubApiUrl("git@github.com:hisagedru/praxis-acceptance-test.git").issue).toBe("git-ssh-remote");
    expect(validateGithubApiUrl("https://github.com/hisagedru/praxis-acceptance-test.git").ok).toBe(false);
    expect(validateGithubApiUrl("https://ghe.example.com/api/v3").ok).toBe(true);
  });
});

describe("delivery preview and commit", () => {
  it("binds Quality snapshot and commits only the allowlist", async () => {
    const repo = tmpRepo();
    const counter = "export function reset(){return 0}\n";
    const test = "ok\n";
    seedProduct(repo, counter, test);
    mkdirSync(join(repo, ".praxis-quality"), { recursive: true });
    writeFileSync(join(repo, ".praxis-quality", "x.sqlite"), "db");
    writeFileSync(join(repo, "package.json"), "{}\n");
    const preview = await previewDelivery({
      repo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
    });
    expect(preview.qualityMatch).toBe(true);
    expect(preview.selectedFiles).toEqual(["src/counter.js", "src/counter.test.js"]);
    expect(preview.jiraMutated).toBe(false);
    expect(preview.warnings.some((w) => w.includes("package.json"))).toBe(true);
    const journal = await applyCommit({
      repo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      previewFingerprint: preview.previewFingerprint,
    });
    expect(journal.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(journal.lifecycle).toBe("committed");
    const files = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout;
    expect(files).toContain("src/counter.js");
    expect(files).not.toContain("package.json");
    expect(files).not.toContain(".praxis-quality");
  });

  it("blocks when snapshot hashes no longer match", async () => {
    const repo = tmpRepo();
    seedProduct(repo, "a\n", "b\n");
    writeFileSync(join(repo, "src/counter.js"), "changed\n");
    const preview = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
    expect(preview.qualityMatch).toBe(false);
    expect(preview.blockers.some((b) => b.code === VCS_CODES.GIT_QUALITY_SNAPSHOT_MISMATCH)).toBe(true);
    await expect(
      applyCommit({
        repo,
        workPackageId: WP,
        jiraWorkPackageKey: "PRX-4",
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({ code: VCS_CODES.GIT_QUALITY_SNAPSHOT_MISMATCH });
  });

  it("stales preview after HEAD drift", async () => {
    const repo = tmpRepo();
    seedProduct(repo);
    const preview = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
    writeFileSync(join(repo, "README.md"), "# changed\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "drift"]);
    await expect(
      applyCommit({
        repo,
        workPackageId: WP,
        jiraWorkPackageKey: "PRX-4",
        previewFingerprint: preview.previewFingerprint,
      }),
    ).rejects.toMatchObject({ code: VCS_CODES.GIT_PREVIEW_STALE });
  });

  it("blocks push without a remote", async () => {
    const repo = tmpRepo();
    seedProduct(repo);
    const preview = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
    await applyCommit({
      repo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      previewFingerprint: preview.previewFingerprint,
    });
    await expect(previewPublish({ repo, workPackageId: WP })).rejects.toMatchObject({
      code: VCS_CODES.GIT_REMOTE_REQUIRED,
    });
  });
});

describe("GitHub and GitLab mocked APIs", () => {
  it("creates a GitHub pull request once and reports unknown CI", async () => {
    const state = createMockGithubState({ empty: false, defaultBranch: "master" });
    const provider = createGithubProvider({
      config: { token: "ghp_not_a_real_token_value", apiUrl: "https://api.github.com" },
      fetchImpl: createMockGithubFetch(state),
    });
    const { first, second } = await withDeliveryLease(async () => {
      const created = await provider.createMergeRequest({
        owner: "hisagedru",
        repo: "praxis-acceptance-test",
        sourceBranch: "feature/PRX-4-counter-reset",
        targetBranch: "master",
        title: "PRX-4",
        body: "body",
      });
      const again = await provider.createMergeRequest({
        owner: "hisagedru",
        repo: "praxis-acceptance-test",
        sourceBranch: "feature/PRX-4-counter-reset",
        targetBranch: "master",
        title: "PRX-4",
        body: "body",
      });
      return { first: created, second: again };
    });
    expect(first.url).toContain("/pull/1");
    expect(second.id).toBe(first.id);
    expect(first.merged).toBe(false);
    const ci = await provider.pipelineStatus({
      owner: "hisagedru",
      repo: "praxis-acceptance-test",
      branch: "feature/PRX-4-counter-reset",
    });
    expect(ci.ciStatus).toBe("not_started");
    const empty = createMockGithubState({ empty: true });
    const emptyProvider = createGithubProvider({
      config: { token: "t", apiUrl: "https://api.github.com" },
      fetchImpl: createMockGithubFetch(empty),
    });
    const info = await emptyProvider.inspectRepository({
      owner: "hisagedru",
      repo: "praxis-acceptance-test",
      host: "github.com",
    });
    expect(info.empty).toBe(true);
  });

  it("creates a GitLab merge request via mocked API", async () => {
    const state = createMockGitlabState();
    const provider = createGitlabProvider({
      config: { token: "glpat-not-real", baseUrl: "https://gitlab.example.com" },
      fetchImpl: createMockGitlabFetch(state),
    });
    const mr = await withDeliveryLease(() => provider.createMergeRequest({
      projectPath: "group/project",
      sourceBranch: "feature/x",
      targetBranch: "main",
      title: "t",
      body: "b",
    }));
    expect(mr.kind).toBe("merge-request");
    expect(mr.merged).toBe(false);
  });
});

describe("baseline master → main and feature PR", () => {
  function emptyBare() {
    const bare = mkdtempSync(join(tmpdir(), "praxis-bare-"));
    git(bare, ["init", "--bare"]);
    return bare;
  }

  function attachGithubishRemote(repo: string, bare: string) {
    const ssh = "git@github.com:hisagedru/praxis-acceptance-test.git";
    git(repo, ["remote", "add", "origin", ssh]);
    git(repo, ["config", `url.${bare}.insteadOf`, ssh]);
  }

  it("publishes local master SHA to remote main without creating remote master", async () => {
    const repo = tmpRepo();
    seedProduct(repo);
    const baseline = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "src/counter.js"), "dirty-not-in-baseline\n");
    writeFileSync(join(repo, "untracked.txt"), "no\n");
    const bare = emptyBare();
    attachGithubishRemote(repo, bare);
    const gh = createMockGithubState({ empty: true, defaultBranch: "main", hasReadme: false });
    const fetchImpl = createMockGithubFetch(gh);
    const pub = await previewPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
    });
    expect(pub.sourceBranch).toBe("master");
    expect(pub.sourceCommitSha).toBe(baseline);
    expect(pub.targetRemote).toBe("origin");
    expect(pub.targetRemoteBranch).toBe("main");
    expect(pub.refspec).toBe(`${baseline}:refs/heads/main`);
    expect(pub.remoteEmpty).toBe(true);
    expect(pub.force).toBe(false);
    expect(pub.existingRefs).toEqual([]);
    const applied = await applyPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
      previewFingerprint: pub.previewFingerprint,
    });
    expect(applied.ok).toBe(true);
    expect(applied.lifecycle).toBe("baseline-published");
    expect(applied.baselineSha).toBe(baseline);
    expect(applied.baselineRemoteBranch).toBe("main");
    expect(applied.targetBranch).toBe("main");
    const remoteRefs = git(bare, ["show-ref", "--heads"]);
    expect(remoteRefs).toContain("refs/heads/main");
    expect(remoteRefs).not.toContain("refs/heads/master");
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(baseline);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("master");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(baseline);
    expect(readFileSync(join(repo, "src/counter.js"), "utf8")).toBe("dirty-not-in-baseline\n");
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("no\n");
    const retry = await applyPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
      previewFingerprint: (await previewPublish({
        repo,
        workPackageId: WP,
        providerKind: "github",
        fetchImpl,
        mode: "baseline",
      })).previewFingerprint,
    });
    expect(retry.writeSucceeded).toBe(false);
    expect(retry.completed).toBe(true);
    expect(git(bare, ["rev-list", "--count", "refs/heads/main"])).toBe("1");
  });

  it("commits allowlist, pushes feature branch, and opens a PR onto main", async () => {
    const counter = "export function reset(){return 0}\n";
    const testBody = "ok\n";
    const repo = tmpRepo();
    seedProduct(repo, counter, testBody);
    const baseline = git(repo, ["rev-parse", "HEAD"]);
    const bare = emptyBare();
    attachGithubishRemote(repo, bare);
    const gh = createMockGithubState({ empty: true, defaultBranch: "main" });
    const fetchImpl = createMockGithubFetch(gh);
    const basePrev = await previewPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
    });
    await applyPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
      previewFingerprint: basePrev.previewFingerprint,
    });
    const preview = await previewDelivery({
      repo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      providerKind: "github",
      fetchImpl,
    });
    expect(preview.targetBranch).toBe("main");
    expect(preview.selectedFiles).toEqual(["src/counter.js", "src/counter.test.js"]);
    const committed = await applyCommit({
      repo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      providerKind: "github",
      fetchImpl,
      previewFingerprint: preview.previewFingerprint,
    });
    expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.featureBranch).toBe("feature/PRX-4-counter-reset");
    expect(committed.lifecycle).toBe("committed");
    const names = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", committed.commitSha!], {
      cwd: repo,
      encoding: "utf8",
    }).stdout;
    expect(names).toContain("src/counter.js");
    expect(names).not.toContain("package.json");
    const featPrev = await previewPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "branch",
    });
    expect(featPrev.sourceBranch).toBe("feature/PRX-4-counter-reset");
    expect(featPrev.targetRemoteBranch).toBe("feature/PRX-4-counter-reset");
    expect(featPrev.refspec).toBe(`${committed.commitSha}:refs/heads/feature/PRX-4-counter-reset`);
    const pushed = await applyPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "branch",
      previewFingerprint: featPrev.previewFingerprint,
    });
    expect(pushed.ok).toBe(true);
    expect(pushed.lifecycle).toBe("pushed");
    expect(git(bare, ["rev-parse", "refs/heads/feature/PRX-4-counter-reset"])).toBe(committed.commitSha);
    const mrPrev = await previewMergeRequest({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
    });
    expect(mrPrev.targetBranch).toBe("main");
    expect(mrPrev.sourceBranch).toBe("feature/PRX-4-counter-reset");
    const mr = await applyMergeRequest({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      previewFingerprint: mrPrev.previewFingerprint,
    });
    expect(mr.ok).toBe(true);
    expect(mr.pullRequestBase).toBe("main");
    expect(mr.pullRequestHead).toBe("feature/PRX-4-counter-reset");
    expect(mr.lifecycle).toBe("awaiting-review");
    expect(mr.ciStatus).toBe("not_configured");
    expect(gh.pulls).toHaveLength(1);
    const retryMr = await applyMergeRequest({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      previewFingerprint: mrPrev.previewFingerprint,
    });
    expect(gh.pulls).toHaveLength(1);
    expect(retryMr.pullRequestUrl).toBe(mr.pullRequestUrl);
    const status = inspectDeliveryStatus({ repo, workPackageId: WP });
    expect(status.journal?.deliveryLifecycle ?? status.journal?.lifecycle).toBe("awaiting-review");
    expect(status.journal?.baselineRemoteBranch).toBe("main");
    expect(status.jiraMutated).toBe(false);
    expect(readJournal(repo, WP)?.forcePush).toBe(false);
    expect(lsRemoteHeads(repo, "origin").refs.some((r) => r.endsWith("/master"))).toBe(false);
    expect(git(bare, ["rev-parse", "refs/heads/main"])).toBe(baseline);
  });
});
