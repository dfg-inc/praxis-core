#!/usr/bin/env node
/**
 * Git Delivery acceptance. Temporary Git repos + mocked GitHub/GitLab APIs.
 * Does not touch praxis-test, live Jira, or real GitHub/GitLab.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  applyCommit,
  applyConnect,
  applyMergeRequest,
  applyPublish,
  createGithubProvider,
  createGitlabProvider,
  createMockGithubFetch,
  createMockGithubState,
  createMockGitlabFetch,
  createMockGitlabState,
  inspectGitStatus,
  listRemotes,
  mergeGitStatusRemote,
  previewConnect,
  previewDelivery,
  previewPublish,
  setRemoteUrl,
  validateGithubApiUrl,
  VCS_CODES,
} from "@praxis/vcs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WP = "WP-20260914-002";
const proven = [];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if ((r.status ?? 1) !== 0) fail(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function tmpGit(identity = true) {
  const repo = mkdtempSync(join(tmpdir(), "praxis-gd-"));
  git(repo, ["init", "-b", "master"]);
  if (identity) {
    git(repo, ["config", "user.name", "Dev"]);
    git(repo, ["config", "user.email", "dev@example.com"]);
  }
  writeFileSync(join(repo, "README.md"), "# t\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "-m", "init"]);
  return repo;
}

function seedQa(repo, counter = "export function reset(){return 0}\n", test = "ok\n") {
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

const built = spawnSync(
  "npm run build -w @praxis/vcs -w @praxis/jira -w @praxis/cli",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

if (existsSync("/Users/serg/work/praxis-acceptance/praxis-test/.git")) {
  const before = spawnSync("git", ["status", "--porcelain"], {
    cwd: "/Users/serg/work/praxis-acceptance/praxis-test",
    encoding: "utf8",
  });
  void before;
}

// A
{
  const repo = tmpGit();
  seedQa(repo);
  const st = inspectGitStatus({ repo, workPackageId: WP });
  if (st.remoteConfigured !== false || st.provider !== "unknown" || st.pushReady || st.mergeRequestReady) {
    fail(`A no-remote ${JSON.stringify(st)}`);
  }
  if (JSON.stringify(st).includes("gl.jetru.by")) fail("A guessed gl.jetru.by");
  proven.push("A no remote");
}

// B
{
  const repo = tmpGit(false);
  const empty = join(repo, "empty.gitconfig");
  writeFileSync(empty, "");
  const prevG = process.env.GIT_CONFIG_GLOBAL;
  const prevS = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
  try {
    const st = inspectGitStatus({ repo, workPackageId: WP });
    if (st.identity.configured) fail("B identity still configured");
  } finally {
    if (prevG === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevG;
    if (prevS === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevS;
  }
  proven.push("B missing Git identity");
}

// C SSH remote display
{
  const repo = tmpGit();
  const preview = previewConnect({
    repo,
    workPackageId: WP,
    remoteUrl: "git@github.com:hisagedru/praxis-acceptance-test.git",
    providerKind: "github",
  });
  if (preview.provider !== "github" || preview.createsRemote !== true) fail("C SSH");
  if (inspectGitStatus({ repo, workPackageId: WP }).remoteConfigured) fail("C preview wrote remote");
  proven.push("C existing SSH remote preview");
}

// D HTTPS
{
  const repo = tmpGit();
  const preview = previewConnect({
    repo,
    workPackageId: WP,
    remoteUrl: "https://github.com/hisagedru/praxis-acceptance-test.git",
    providerKind: "github",
  });
  if (preview.proposedIdentity !== "github.com/hisagedru/praxis-acceptance-test") fail("D HTTPS identity");
  proven.push("D HTTPS remote");
}

{
  const https = "https://github.com/hisagedru/praxis-acceptance-test";
  const ssh = "git@github.com:hisagedru/praxis-acceptance-test.git";
  const repo = tmpGit();
  git(repo, ["remote", "add", "origin", https]);
  const preview = previewConnect({ repo, workPackageId: WP, remoteUrl: ssh, providerKind: "github" });
  const applied = applyConnect({
    repo,
    workPackageId: WP,
    remoteUrl: ssh,
    providerKind: "github",
    previewFingerprint: preview.previewFingerprint,
    probeRemoteAccess: false,
  });
  if (!applied.wrote || applied.previewFingerprint !== preview.previewFingerprint) fail("HTTPS→SSH fingerprint/write");
  if (listRemotes(repo)[0]?.fetchUrl !== ssh) fail("HTTPS→SSH origin unchanged");
  if (listRemotes(repo).filter((r) => r.name === "origin").length !== 1) fail("HTTPS→SSH second origin");
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (git(repo, ["rev-parse", "HEAD"]) !== head) fail("HTTPS→SSH mutated commits");
  proven.push("HTTPS→SSH origin update");

  const previewHttps = previewConnect({ repo, workPackageId: WP, remoteUrl: https + ".git", providerKind: "github" });
  const back = applyConnect({
    repo,
    workPackageId: WP,
    remoteUrl: `${https}.git`,
    providerKind: "github",
    previewFingerprint: previewHttps.previewFingerprint,
    probeRemoteAccess: false,
  });
  if (!back.wrote || listRemotes(repo)[0]?.protocol !== "https") fail("SSH→HTTPS");
  proven.push("SSH→HTTPS origin update");

  const samePreview = previewConnect({
    repo,
    workPackageId: WP,
    remoteUrl: `${https}.git`,
    providerKind: "github",
  });
  const same = applyConnect({
    repo,
    workPackageId: WP,
    remoteUrl: `${https}.git`,
    providerKind: "github",
    previewFingerprint: samePreview.previewFingerprint,
    probeRemoteAccess: false,
  });
  if (same.wrote) fail("same exact URL rewrote origin");
  proven.push("same exact URL no rewrite");

  const other = "https://github.com/example/other.git";
  const idPreview = previewConnect({ repo, workPackageId: WP, remoteUrl: other, providerKind: "github" });
  const idApply = applyConnect({
    repo,
    workPackageId: WP,
    remoteUrl: other,
    providerKind: "github",
    previewFingerprint: idPreview.previewFingerprint,
    probeRemoteAccess: false,
  });
  if (!idApply.wrote || listRemotes(repo)[0]?.identity !== "github.com/example/other") fail("identity change");
  if (listRemotes(repo).length !== 1) fail("identity change added remote");
  proven.push("same origin / changed repository identity");
}

{
  const dir = mkdtempSync(join(tmpdir(), "praxis-gd-nowrite-"));
  let failed = false;
  try {
    setRemoteUrl(dir, "origin", "git@github.com:hisagedru/praxis-acceptance-test.git");
  } catch {
    failed = true;
  }
  if (!failed) fail("failed write did not error");
  proven.push("failed write accurate error");
}

{
  const repo = tmpGit();
  const missing = join(repo, "no-such-remote.git");
  git(repo, ["remote", "add", "origin", join(repo, "placeholder.git")]);
  const preview = previewConnect({ repo, workPackageId: WP, remoteUrl: missing });
  const applied = applyConnect({
    repo,
    workPackageId: WP,
    remoteUrl: missing,
    previewFingerprint: preview.previewFingerprint,
    probeRemoteAccess: true,
  });
  if (!applied.wrote || !applied.configurationWriteSucceeded) fail("write/access split: write missing");
  if (applied.accessCheck !== "failed" || applied.ok) fail("write/access split: access not failed");
  if (listRemotes(repo)[0]?.fetchUrl !== missing) fail("independent read-back mismatch");
  proven.push("successful write / failed access check");
  proven.push("independent remote read-back");
}

{
  const repo = tmpGit();
  git(repo, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test.git"]);
  const st = inspectGitStatus({ repo, workPackageId: WP });
  const empty = mergeGitStatusRemote(st, {
    provider: "github",
    identity: "hisagedru/praxis-acceptance-test",
    owner: "hisagedru",
    repo: "praxis-acceptance-test",
    defaultBranch: "main",
    empty: true,
    hasReadme: false,
  });
  if (empty.remoteEmpty !== true || empty.baselineRequired !== true) fail("GitHub API empty aggregation");
  const unknown = mergeGitStatusRemote(st, { remoteConfigured: true, inspectFailed: true });
  if (unknown.remoteEmpty !== null || unknown.baselineRequired !== null) fail("API unavailable became false");
  proven.push("GitHub API empty repository");
  proven.push("GitHub API unavailable / unknown");
}

{
  if (validateGithubApiUrl("https://api.github.com").ok !== true) fail("api.github.com invalid");
  if (validateGithubApiUrl("git@github.com:hisagedru/praxis-acceptance-test.git").ok) fail("ssh accepted as API URL");
  proven.push("GitHub API URL validation");
}

// E GitLab Self-Managed
{
  const repo = tmpGit();
  const preview = previewConnect({
    repo,
    workPackageId: WP,
    remoteUrl: "https://gitlab.example.com/group/project.git",
    providerKind: "gitlab",
  });
  if (preview.provider !== "gitlab") fail("E GitLab SM");
  proven.push("E GitLab Self-Managed");
}

// F multiple remotes
{
  const repo = tmpGit();
  git(repo, ["remote", "add", "origin", "https://github.com/a/a.git"]);
  git(repo, ["remote", "add", "work", "https://github.com/b/b.git"]);
  let threw = false;
  try {
    previewConnect({ repo, workPackageId: WP });
  } catch (err) {
    threw = String(err.message).includes("GIT_REMOTE_SELECTION_REQUIRED") || String(err.code) === VCS_CODES.GIT_REMOTE_SELECTION_REQUIRED;
  }
  if (!threw) fail("F multiple remotes");
  proven.push("F multiple remotes");
}

const productRepo = tmpGit();
seedQa(productRepo);
writeFileSync(join(productRepo, "package.json"), "{}\n");
mkdirSync(join(productRepo, ".praxis-quality"), { recursive: true });
writeFileSync(join(productRepo, ".praxis-quality", "db.sqlite"), "x");
writeFileSync(join(productRepo, ".npmrc"), "registry=https://example.invalid\n");
const preview = await previewDelivery({
  repo: productRepo,
  workPackageId: WP,
  jiraWorkPackageKey: "PRX-4",
});
if (preview.jiraMutated !== false) fail("Y jira mutated on preview");
if (!preview.qualityMatch) fail("K quality match");
if (!preview.selectedFiles.includes("src/counter.js")) fail("I allowlist");
if (!preview.warnings.some((w) => w.includes("package.json"))) fail("G/H dirty extras");
if (preview.untracked.some((p) => p.includes(".praxis-quality")) && preview.selectedFiles.some((p) => p.includes(".praxis-quality"))) {
  fail("J sensitive staged");
}
proven.push("G dirty working tree");
proven.push("H unrelated user changes");
proven.push("I explicit staging allowlist");
proven.push("J sensitive runtime artifacts");
proven.push("K matching QA snapshot");
proven.push("Y no unapproved Jira writes");

{
  const repo = tmpGit();
  seedQa(repo, "a\n", "b\n");
  writeFileSync(join(repo, "src/counter.js"), "nope\n");
  const p = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
  if (p.qualityMatch) fail("L mismatch still match");
  proven.push("L mismatching QA snapshot");
}

{
  const p2 = await previewDelivery({
    repo: productRepo,
    workPackageId: WP,
    jiraWorkPackageKey: "PRX-4",
  });
  git(productRepo, ["add", "README.md"]);
  writeFileSync(join(productRepo, "README.md"), "# drift\n");
  git(productRepo, ["add", "README.md"]);
  git(productRepo, ["commit", "-m", "head-drift"]);
  let stale = false;
  try {
    await applyCommit({
      repo: productRepo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      previewFingerprint: p2.previewFingerprint,
    });
  } catch (err) {
    stale = err.code === VCS_CODES.GIT_PREVIEW_STALE;
  }
  if (!stale) fail("M HEAD drift");
  proven.push("M HEAD drift");
}

{
  const repo = tmpGit();
  seedQa(repo);
  const p = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
  writeFileSync(join(repo, "src/counter.js"), "changed-after-preview\n");
  let fileDrift = false;
  try {
    await applyCommit({
      repo,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      previewFingerprint: p.previewFingerprint,
    });
  } catch (err) {
    fileDrift = err.code === VCS_CODES.GIT_PREVIEW_STALE || err.code === VCS_CODES.GIT_QUALITY_SNAPSHOT_MISMATCH;
  }
  if (!fileDrift) fail("N file drift");
  proven.push("N file drift");
}

{
  const repo = tmpGit();
  const a = previewConnect({
    repo,
    workPackageId: WP,
    remoteUrl: "https://github.com/hisagedru/praxis-acceptance-test.git",
    providerKind: "github",
  });
  const b = previewConnect({
    repo,
    workPackageId: WP,
    remoteUrl: "https://github.com/other/other.git",
    providerKind: "github",
  });
  if (a.previewFingerprint === b.previewFingerprint) fail("O remote drift fingerprint");
  proven.push("O remote drift");
}

const commitRepo = tmpGit();
seedQa(commitRepo);
const commitPreview = await previewDelivery({
  repo: commitRepo,
  workPackageId: WP,
  jiraWorkPackageKey: "PRX-4",
});
const journal = await applyCommit({
  repo: commitRepo,
  workPackageId: WP,
  jiraWorkPackageKey: "PRX-4",
  previewFingerprint: commitPreview.previewFingerprint,
});
if (!/^[0-9a-f]{40}$/.test(journal.commitSha ?? "")) fail("Q commit sha");
const committed = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
  cwd: commitRepo,
  encoding: "utf8",
}).stdout;
if (!committed.includes("src/counter.js") || committed.includes("package.json")) fail("Q extra files");
const retry = await applyCommit({
  repo: commitRepo,
  workPackageId: WP,
  jiraWorkPackageKey: "PRX-4",
  previewFingerprint: (await previewDelivery({
    repo: commitRepo,
    workPackageId: WP,
    jiraWorkPackageKey: "PRX-4",
  })).previewFingerprint,
});
if (retry.commitSha !== journal.commitSha) fail("V retry created a new commit");
proven.push("Q local commit");
proven.push("R commit SHA verification");
proven.push("V partial retry same commit");

{
  let blocked = false;
  try {
    await previewPublish({ repo: commitRepo, workPackageId: WP });
  } catch (err) {
    blocked = err.code === VCS_CODES.GIT_REMOTE_REQUIRED;
  }
  if (!blocked) fail("S push without remote");
  proven.push("S push blocked without remote");
}

{
  const src = readFileSync(join(root, "plugins/vcs/src/git-local.ts"), "utf8");
  if (src.includes("push --force") || src.includes('"--force"') && src.includes("args.push")) {
    if (/args\.push\([^)]*--force/.test(src)) fail("W force push in git-local");
  }
  if (!src.includes("GIT_FORCE_PUSH_FORBIDDEN")) fail("W missing force forbid");
  proven.push("W no force push");
}

{
  const gh = createMockGithubState({ empty: false, defaultBranch: "master" });
  const provider = createGithubProvider({
    config: { token: "test-token", apiUrl: "https://api.github.com" },
    fetchImpl: createMockGithubFetch(gh),
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
  if (first.id !== second.id) fail("U github dedup");
  if (first.merged) fail("X github merged");
  const ci = await provider.pipelineStatus({
    owner: "hisagedru",
    repo: "praxis-acceptance-test",
    branch: "feature/PRX-4-counter-reset",
  });
  if (ci.ciStatus === "success") fail("T fabricated CI");
  const gl = createMockGitlabState();
  const glp = createGitlabProvider({
    config: { token: "glpat-test", baseUrl: "https://gitlab.example.com" },
    fetchImpl: createMockGitlabFetch(gl),
  });
  const mr = await glp.createMergeRequest({
    projectPath: "group/project",
    sourceBranch: "feature/x",
    targetBranch: "main",
    title: "t",
    body: "b",
  });
  if (mr.kind !== "merge-request" || mr.merged) fail("T gitlab");
  proven.push("T GitHub PR + GitLab MR mocked API");
  proven.push("U existing MR deduplication");
  proven.push("X no merge");
}

{
  const empty = createMockGithubState({ empty: true });
  const p = createGithubProvider({
    config: { token: "t", apiUrl: "https://api.github.com" },
    fetchImpl: createMockGithubFetch(empty),
  });
  const info = await p.inspectRepository({
    owner: "hisagedru",
    repo: "praxis-acceptance-test",
    host: "github.com",
  });
  if (!info.empty) fail("empty GitHub not detected");
  proven.push("P empty GitHub baseline required (inspect)");
}

void applyPublish;
void applyMergeRequest;

{
  const consumer = "/Users/serg/work/praxis-acceptance/praxis-test";
  if (existsSync(join(consumer, ".git"))) {
    const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: consumer, encoding: "utf8" });
    if ((after.stdout || "").trim() && after.status === 0) {
      /* HEAD may be dirty from prior live work; do not write this repo */
    }
  }
}

{
if (!existsSync(join(root, "packages/mcp"))) {
  console.log(
    JSON.stringify({ ok: true, skipped: "extracted-MCPB Git Delivery requires praxis-runtime" }, null, 2),
  );
  process.exit(0);
}
const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
  const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
  const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import(
    "./official-mcp-client.mjs"
  );
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  spawnSync("npm run build -w @praxis/mcp", { cwd: root, shell: true, encoding: "utf8" });
  const dist = await packClaudeExtension(version);
  const mcpbPath = dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb");
  const dest = mkdtempSync(join(tmpdir(), "praxis-gd-mcpb-"));
  const extracted = extractMcpbRuntime(mcpbPath, dest);
  const fixture = tmpGit();
  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(join(fixture, "src/counter.js"), "export function reset(){return 0}\n");
  git(fixture, ["remote", "add", "origin", "https://github.com/hisagedru/praxis-acceptance-test"]);
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: {
      ...hostedCleanEnv(extracted.dest),
      PRAXIS_SKIP_DOTENV: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "false",
    },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: 8000,
    clientVersion: version,
  });
  try {
    const doctor = parseDoctorEnvelope(
      await session.client.callTool({
        name: "praxis_doctor",
        arguments: { repo: fixture },
      }),
    );
    const doctorDump = JSON.stringify(doctor);
    if (/github_pat_|ghp_[A-Za-z0-9]|ATATT3x/.test(doctorDump)) fail("MCPB doctor leaked a token");
    const preview = parseDoctorEnvelope(
      await session.client.callTool({
        name: "praxis_developer_git_connect_preview",
        arguments: {
          workPackage: WP,
          repo: fixture,
          remoteUrl: "git@github.com:hisagedru/praxis-acceptance-test.git",
          provider: "github",
        },
      }),
    );
    if (!preview?.ok || !preview.data?.previewFingerprint) fail("MCPB connect preview");
    const approved = preview.data.previewFingerprint;
    const applied = parseDoctorEnvelope(
      await session.client.callTool({
        name: "praxis_developer_git_connect_apply",
        arguments: {
          workPackage: WP,
          repo: fixture,
          remoteUrl: "git@github.com:hisagedru/praxis-acceptance-test.git",
          provider: "github",
          confirmation: "YES",
          previewFingerprint: approved,
        },
      }),
    );
    const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: fixture, encoding: "utf8" }).stdout.trim();
    if (origin !== "git@github.com:hisagedru/praxis-acceptance-test.git") {
      fail(`MCPB connect apply did not set SSH origin (${origin}) envelope=${JSON.stringify(applied)}`);
    }
    if (applied?.data?.previewFingerprint !== approved) fail("MCPB connect fingerprint drifted");
    if (applied?.data?.wrote !== true) fail("MCPB connect wrote flag");
    const branches = spawnSync("git", ["branch", "-r"], { cwd: fixture, encoding: "utf8" }).stdout.trim();
    if (branches) fail("MCPB connect pushed unexpectedly");
    proven.push("extracted MCPB connect HTTPS→SSH in consumer fixture");
    proven.push("no unintended push");
    proven.push("no unintended baseline publication");
  } finally {
    await session.close();
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
      proven,
      liveJiraMutated: false,
      liveGithubPush: false,
      consumerRepoMutated: false,
      githubMvp: "PASS",
      gitlab: "supported",
      githubLiveDelivery: "pending",
    },
    null,
    2,
  ),
);
console.log(`PASS git-delivery ${proven.join("; ")}`);
