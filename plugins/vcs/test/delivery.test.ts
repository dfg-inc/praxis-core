import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCommit,
  createGithubProvider,
  createGitlabProvider,
  createMockGithubFetch,
  createMockGithubState,
  createMockGitlabFetch,
  createMockGitlabState,
  inspectGitStatus,
  parseRemoteUrl,
  planStaging,
  previewConnect,
  previewDelivery,
  previewPublish,
  redactRemoteUrl,
  VCS_CODES,
} from "../src/index.js";

const WP = "WP-20260914-002";

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
    expect(() => previewPublish({ repo, workPackageId: WP })).toThrow(/no remote/i);
  });
});

describe("GitHub and GitLab mocked APIs", () => {
  it("creates a GitHub pull request once and reports unknown CI", async () => {
    const state = createMockGithubState({ empty: false, defaultBranch: "master" });
    const provider = createGithubProvider({
      config: { token: "ghp_not_a_real_token_value", apiUrl: "https://api.github.com" },
      fetchImpl: createMockGithubFetch(state),
    });
    const first = await provider.createMergeRequest({
      owner: "hisagedru",
      repo: "praxis-acceptance-test",
      sourceBranch: "feature/PRX-4-counter-reset",
      targetBranch: "master",
      title: "PRX-4",
      body: "body",
    });
    const second = await provider.createMergeRequest({
      owner: "hisagedru",
      repo: "praxis-acceptance-test",
      sourceBranch: "feature/PRX-4-counter-reset",
      targetBranch: "master",
      title: "PRX-4",
      body: "body",
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
    const mr = await provider.createMergeRequest({
      projectPath: "group/project",
      sourceBranch: "feature/x",
      targetBranch: "main",
      title: "t",
      body: "b",
    });
    expect(mr.kind).toBe("merge-request");
    expect(mr.merged).toBe(false);
  });
});
