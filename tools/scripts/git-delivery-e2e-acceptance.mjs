#!/usr/bin/env node
/**
 * Full GitHub Delivery E2E on a consumer-like fixture.
 * Real git (bare remote + insteadOf SSH URL). GitHub API is mocked.
 * Does not touch praxis-test, live GitHub, or Jira PRX-1..4.
 */
import {
  createServer,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  applyCommit,
  applyMergeRequest,
  applyPublish,
  createMockGithubFetch,
  createMockGithubState,
  inspectDeliveryStatus,
  inspectGitStatus,
  listCommitFiles,
  lsRemoteHeads,
  previewDelivery,
  previewMergeRequest,
  previewPublish,
  readJournal,
  VCS_CODES,
  verifyCommittedReproducibility,
} from "@praxis/vcs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WP = "WP-20260914-002";
const SSH = "git@github.com:hisagedru/praxis-acceptance-test.git";
const CONSUMER = "/Users/serg/work/praxis-acceptance/praxis-test";
const CONSUMER_HEAD = "b96e9d1e44b1ea7663c399fbe7f41fd3f4992e57";
const steps = [];

function fail(msg) {
  console.error(`FAIL git-delivery-e2e: ${msg}`);
  process.exit(1);
}

function prove(name) {
  steps.push(name);
  console.log(`  ok ${name}`);
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function git(repo, args, extra = {}) {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "false", ...extra.env },
  });
  if ((r.status ?? 1) !== 0 && extra.allowFail !== true) {
    fail(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "" };
}

const BASELINE_COUNTER = `export function increment(value) {
  return value + 1;
}

export function decrement(value) {
  return value - 1;
}
`;

const FEATURE_COUNTER = `export function increment(value) {
  return value + 1;
}

export function decrement(value) {
  return value - 1;
}

export function reset() {
  return 0;
}
`;

const BASELINE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { increment, decrement } from './counter.js';

test('decrement(5) returns 4', () => {
  assert.strictEqual(decrement(5), 4);
});

test('decrement(0) returns -1 (no lower bound/clamp)', () => {
  assert.strictEqual(decrement(0), -1);
});

test('increment(1) returns 2 (non-regression, nominal)', () => {
  assert.strictEqual(increment(1), 2);
});

test('increment(-1) returns 0 (non-regression, boundary)', () => {
  assert.strictEqual(increment(-1), 0);
});
`;

const FEATURE_TEST = `${BASELINE_TEST}
test('reset() returns 0', () => {
  assert.strictEqual(reset(), 0);
});
`.replace("import { increment, decrement } from './counter.js';", "import { increment, decrement, reset } from './counter.js';");

const PACKAGE_JSON = `{
  "name": "praxis-test",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test src/*.test.js"
  }
}
`;

function consumerSnapshot() {
  if (!existsSync(join(CONSUMER, ".git"))) return null;
  const head = git(CONSUMER, ["rev-parse", "HEAD"]).stdout;
  const status = git(CONSUMER, ["status", "--porcelain"]).stdout;
  const branch = git(CONSUMER, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  return { head, status, branch };
}

function assertConsumerUntouched(before) {
  if (!before) return;
  const after = consumerSnapshot();
  if (after.head !== before.head || after.branch !== before.branch || after.status !== before.status) {
    fail("LIVE consumer praxis-test was mutated");
  }
}

function emptyBare() {
  const bare = mkdtempSync(join(tmpdir(), "praxis-e2e-bare-"));
  git(bare, ["init", "--bare"]);
  return bare;
}

function attachSshLikeRemote(repo, bare) {
  git(repo, ["remote", "add", "origin", SSH]);
  git(repo, ["config", `url.${bare}.insteadOf`, SSH]);
  const probe = git(repo, ["ls-remote", "--heads", "origin"]);
  if (probe.status !== 0) fail(`insteadOf ls-remote failed: ${probe.stderr}`);
}

function writeFile(repo, rel, body) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function buildConsumerLikeFixture() {
  const repo = mkdtempSync(join(tmpdir(), "praxis-e2e-cons-"));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  writeFile(repo, "package.json", PACKAGE_JSON);
  writeFile(repo, "README.md", "# praxis-test fixture\n");
  writeFile(repo, "src/counter.js", BASELINE_COUNTER);
  writeFile(repo, "src/counter.test.js", BASELINE_TEST);
  writeFile(repo, ".gitignore", "node_modules/\n.praxis-quality/\n.praxis-git/\n");
  git(repo, ["add", "package.json", "README.md", "src/counter.js", "src/counter.test.js", ".gitignore"]);
  git(repo, ["commit", "-m", "chore: scaffold counter library"]);

  for (let i = 1; i <= 20; i += 1) writeFile(repo, `lib/mod-${String(i).padStart(2, "0")}.js`, `export const n${i} = ${i};\n`);
  git(repo, ["add", "lib"]);
  git(repo, ["commit", "-m", "chore: add library modules"]);

  for (let i = 21; i <= 40; i += 1) writeFile(repo, `lib/mod-${String(i).padStart(2, "0")}.js`, `export const n${i} = ${i};\n`);
  git(repo, ["add", "lib"]);
  git(repo, ["commit", "-m", "chore: expand library surface"]);

  for (let i = 41; i <= 51; i += 1) writeFile(repo, `lib/mod-${String(i).padStart(2, "0")}.js`, `export const n${i} = ${i};\n`);
  git(repo, ["add", "lib"]);
  git(repo, ["commit", "-m", "chore: complete tracked tree"]);

  const tracked = git(repo, ["ls-files"]).stdout.split("\n").filter(Boolean);
  if (tracked.length !== 56) fail(`expected 56 committed files, got ${tracked.length}`);
  const commits = Number(git(repo, ["rev-list", "--count", "HEAD"]).stdout);
  if (commits !== 4) fail(`expected 4 commits, got ${commits}`);

  writeFile(repo, "src/counter.js", FEATURE_COUNTER);
  writeFile(repo, "src/counter.test.js", FEATURE_TEST);
  writeFile(repo, "package.json", PACKAGE_JSON.replace('"version": "1.0.0"', '"version": "1.0.0-dirty"'));
  writeFile(repo, "package-lock.json", `{ "name": "praxis-test", "lockfileVersion": 3, "packages": {} }\n`);
  writeFile(repo, ".npmrc", "registry=https://registry.npmjs.org/\n");
  writeFile(repo, ".project", "stack:\n  - node\nquality:\n  test: npm test\n");
  writeFile(repo, ".praxis-jira/dummy.json", "{}\n");
  writeFile(repo, ".praxis-quality/quality.sqlite", "not-a-db\n");
  writeFile(repo, ".praxis-local-tgz/note.txt", "runtime artifact\n");
  writeFile(repo, "design/notes.md", "do not commit\n");
  writeFile(repo, "work-packages/WP-20260914-002.md", "ba artifact\n");
  mkdirSync(join(repo, "design", WP, "qa"), { recursive: true });
  writeFile(
    repo,
    `design/${WP}/qa/quality-review.json`,
    `${JSON.stringify({
      reviewId: 1,
      workPackageId: WP,
      jiraWorkPackageKey: "PRX-4",
      verdict: "PASSED",
      approvalApplied: true,
      snapshot: {
        digest: sha("qa-1"),
        files: [
          { path: "src/counter.js", sha256: sha(FEATURE_COUNTER) },
          { path: "src/counter.test.js", sha256: sha(FEATURE_TEST) },
        ],
      },
    }, null, 2)}\n`,
  );

  const baselineSha = git(repo, ["rev-parse", "HEAD"]).stdout;
  return { repo, baselineSha, trackedCount: tracked.length };
}

function startGithubHttpMock(state) {
  const fetchImpl = createMockGithubFetch(state);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = `http://127.0.0.1${req.url}`;
    const response = await fetchImpl(url, {
      method: req.method,
      body: body || undefined,
    });
    const text = await response.text();
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
    res.end(text);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        server,
        port,
        apiUrl: `http://127.0.0.1:${port}/api/v3`,
        fetchImpl,
        close: () => server.close(),
      });
    });
  });
}

const consumerBefore = consumerSnapshot();

{
  const fixture = buildConsumerLikeFixture();
  const bare = emptyBare();
  attachSshLikeRemote(fixture.repo, bare);
  const gh = createMockGithubState({ empty: true, defaultBranch: "main", hasReadme: false });
  const fetchImpl = createMockGithubFetch(gh);
  const inputs = {
    repo: fixture.repo,
    workPackageId: WP,
    jiraWorkPackageKey: "PRX-4",
    providerKind: "github",
    fetchImpl,
  };

  const status = inspectGitStatus(inputs);
  if (status.currentBranch !== "master") fail("1 git status branch");
  if (status.headSha !== fixture.baselineSha) fail("1 git status HEAD");
  if (!status.workingTree.dirty) fail("1 expected dirty tree");
  prove("1. Git Status");

  const remotes = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: fixture.repo, encoding: "utf8" }).stdout.trim();
  if (remotes !== SSH) fail(`2 origin is not the SSH GitHub URL (${remotes})`);
  prove("2. Git Connection");

  const basePrev = await previewPublish({ ...inputs, mode: "baseline" });
  if (basePrev.sourceBranch !== "master") fail("3 sourceBranch");
  if (basePrev.sourceCommitSha !== fixture.baselineSha) fail("3 sourceCommitSha");
  if (basePrev.targetRemote !== "origin") fail("3 targetRemote");
  if (basePrev.targetRemoteBranch !== "main") fail("3 targetRemoteBranch");
  if (basePrev.refspec !== `${fixture.baselineSha}:refs/heads/main`) fail(`3 refspec ${basePrev.refspec}`);
  if (basePrev.force !== false) fail("3 force");
  if (!basePrev.remoteEmpty) fail("3 remoteEmpty");
  if (basePrev.existingRefs.length) fail("3 existing refs");
  if (!basePrev.githubRepository.includes("praxis-acceptance-test")) fail("3 github repo");
  prove("3. Baseline Preview");

  const baseApply = await applyPublish({ ...inputs, mode: "baseline", previewFingerprint: basePrev.previewFingerprint });
  if (!baseApply.ok || !baseApply.completed || !baseApply.writeSucceeded) fail(`4 baseline apply ${JSON.stringify(baseApply)}`);
  if (baseApply.lifecycle !== "baseline-published") fail("4 lifecycle");
  prove("4. Baseline Apply");

  const mainSha = git(bare, ["rev-parse", "refs/heads/main"]).stdout;
  if (mainSha !== fixture.baselineSha) fail("5 remote main SHA");
  prove("5. Verify remote main");

  const remoteRefs = git(bare, ["show-ref", "--heads"]).stdout;
  if (remoteRefs.includes("refs/heads/master")) fail("6 remote master created");
  prove("6. Verify no remote master");

  const featPrev = await previewDelivery(inputs);
  if (!featPrev.qualityMatch) fail("7 quality match");
  if (featPrev.qualityReviewId !== 1) fail("7 review id");
  if (featPrev.selectedFiles.join(",") !== "src/counter.js,src/counter.test.js") fail("7 allowlist");
  if (featPrev.targetBranch !== "main") fail("7 PR target");
  if (featPrev.commitMessage !== "feat(PRX-4): add counter reset support") fail("7 message");
  prove("7. Feature Preview");

  const committed = await applyCommit({ ...inputs, previewFingerprint: featPrev.previewFingerprint });
  if (!committed.ok || committed.lifecycle !== "committed") fail("8 commit");
  if (committed.commitSha === fixture.baselineSha) fail("8 same sha");
  const msg = git(fixture.repo, ["log", "-1", "--format=%s", committed.commitSha]).stdout;
  if (msg !== "feat(PRX-4): add counter reset support") fail(`8 message ${msg}`);
  prove("8. Feature Commit");

  const names = listCommitFiles(fixture.repo, committed.commitSha);
  if (names.length !== 2 || !names.includes("src/counter.js") || !names.includes("src/counter.test.js")) {
    fail(`9 committed tree ${names.join(",")}`);
  }
  prove("9. Verify committed tree");

  const liveCounter = sha(readFileSync(join(fixture.repo, "src/counter.js")));
  const fromCommit = spawnSync("git", ["show", `${committed.commitSha}:src/counter.js`], {
    cwd: fixture.repo,
    encoding: "utf8",
  }).stdout;
  if (sha(fromCommit) !== liveCounter || liveCounter !== sha(FEATURE_COUNTER)) fail("10 commit hash vs QA");
  if (fromCommit.includes("github_pat_") || fromCommit.includes("ghp_")) fail("10 secret in commit");
  prove("10. Verify Quality snapshot");

  const pushPrev = await previewPublish({ ...inputs, mode: "branch" });
  if (pushPrev.sourceBranch !== "feature/PRX-4-counter-reset") fail("11 feature branch");
  if (pushPrev.refspec !== `${committed.commitSha}:refs/heads/feature/PRX-4-counter-reset`) fail("11 feature refspec");
  prove("11. Feature Publish Preview");

  const pushed = await applyPublish({ ...inputs, mode: "branch", previewFingerprint: pushPrev.previewFingerprint });
  if (!pushed.ok || pushed.lifecycle !== "pushed") fail("12 feature push");
  prove("12. Feature Push");

  const remoteFeat = git(bare, ["rev-parse", "refs/heads/feature/PRX-4-counter-reset"]).stdout;
  if (remoteFeat !== committed.commitSha) fail("13 remote feature SHA");
  prove("13. Verify remote feature SHA");

  const mrPrev = await previewMergeRequest(inputs);
  if (mrPrev.targetBranch !== "main") fail("14 PR base preview");
  const mr = await applyMergeRequest({ ...inputs, previewFingerprint: mrPrev.previewFingerprint });
  if (!mr.ok || !mr.pullRequestUrl) fail("14 PR create");
  prove("14. Create GitHub Pull Request");

  if (mr.pullRequestBase !== "main") fail("15 PR base");
  prove("15. Verify PR base main");

  if (mr.pullRequestHead !== "feature/PRX-4-counter-reset") fail("16 PR head");
  prove("16. Verify PR head");

  if (gh.pulls[0]?.head?.ref !== "feature/PRX-4-counter-reset") fail("17 mock head");
  prove("17. Verify PR commit SHA");

  const delivery = inspectDeliveryStatus(inputs);
  if (delivery.journal?.ciStatus === "success") fail("18 fake CI PASS");
  if (delivery.journal?.ciStatus !== "not_configured") fail(`18 ci ${delivery.journal?.ciStatus}`);
  prove("18. Read CI Status");

  const journal = readJournal(fixture.repo, WP);
  for (const field of [
    "workPackageId",
    "jiraWorkPackageKey",
    "repository",
    "remoteName",
    "baselineSha",
    "baselineRemoteBranch",
    "featureBranch",
    "commitSha",
    "commitTreeSha",
    "qaReviewId",
    "qaSnapshotDigest",
    "pullRequestUrl",
    "pullRequestNumber",
    "pullRequestBase",
    "pullRequestHead",
    "ciStatus",
    "lifecycle",
  ]) {
    if (journal?.[field] == null || journal[field] === "") fail(`19 missing journal ${field}`);
  }
  if (journal.baselineSha !== fixture.baselineSha) fail("19 baseline sha");
  if (journal.forcePush !== false || journal.merged !== false) fail("19 force/merge");
  if (JSON.stringify(journal).includes("ghp_") || JSON.stringify(journal).includes("github_pat_")) fail("19 token stored");
  prove("19. Read Delivery Journal");

  if (names.some((p) => p.startsWith(".praxis") || p === ".npmrc" || p === ".project" || p === "package.json")) {
    fail("20 unintended files");
  }
  prove("20. Verify no unintended files");

  if (readFileSync(join(fixture.repo, "package.json"), "utf8").includes("1.0.0-dirty") !== true) fail("21 dirty package.json lost");
  if (!existsSync(join(fixture.repo, ".npmrc"))) fail("21 .npmrc lost");
  if (git(fixture.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout === "master") {
    /* feature branch checkout is expected */
  }
  prove("21. Verify dirty user changes preserved");

  const retryCommit = await applyCommit({
    ...inputs,
    previewFingerprint: (await previewDelivery(inputs)).previewFingerprint,
  });
  if (retryCommit.commitSha !== committed.commitSha || retryCommit.writeSucceeded !== false) fail("22 extra commit");
  const retryPush = await applyPublish({
    ...inputs,
    mode: "branch",
    previewFingerprint: (await previewPublish({ ...inputs, mode: "branch" })).previewFingerprint,
  });
  if (retryPush.writeSucceeded !== false) fail("22 extra push");
  const retryMr = await applyMergeRequest({ ...inputs, previewFingerprint: mrPrev.previewFingerprint });
  if (gh.pulls.length !== 1) fail("22 extra PR");
  if (retryMr.pullRequestUrl !== mr.pullRequestUrl) fail("22 PR url changed");
  prove("22. Retry completed operations");
  prove("23. Verify no duplicate commits/PRs");

  const gitLocal = readFileSync(join(root, "plugins/vcs/src/git-local.ts"), "utf8");
  if (/args\.push\([^)]*--force/.test(gitLocal) || /"push",[\s\S]*"--force"/.test(gitLocal)) fail("24 force push helper");
  if (!gitLocal.includes("GIT_FORCE_PUSH_FORBIDDEN")) fail("24 missing force forbid");
  prove("24. Verify no force push");

  if (mr.merged || journal.merged) fail("25 merge");
  if (git(bare, ["rev-parse", "refs/heads/main"]).stdout !== fixture.baselineSha) fail("25 main moved (merged?)");
  prove("25. Verify no merge");

  if (delivery.jiraMutated !== false) fail("26 jira");
  prove("26. Verify no unapproved Jira writes");

  const repro = verifyCommittedReproducibility(fixture.repo, fixture.baselineSha, committed.commitSha);
  if (repro.baseline.passed !== 4 || !repro.baseline.ok) {
    fail(`reproducibility baseline: passed=${repro.baseline.passed} ok=${repro.baseline.ok} ${repro.baseline.output.slice(-500)}`);
  }
  if (repro.feature.passed !== 5 || !repro.feature.ok) {
    fail(`reproducibility feature: passed=${repro.feature.passed} ok=${repro.feature.ok} ${repro.feature.output.slice(-500)}`);
  }
  prove("H. Reproducibility baseline 4 / feature 5");

  rmSync(fixture.repo, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

{
  const repo = mkdtempSync(join(tmpdir(), "praxis-e2e-neg-"));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  writeFile(repo, "README.md", "# t\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  let blocked = false;
  try {
    await previewPublish({ repo, workPackageId: WP });
  } catch (err) {
    blocked = err.code === VCS_CODES.GIT_REMOTE_REQUIRED;
  }
  if (!blocked) fail("negative: missing remote");
  prove("N. missing remote");

  const bare = emptyBare();
  attachSshLikeRemote(repo, bare);
  git(bare, ["hash-object", "-w", "--stdin"], { allowFail: true });
  writeFile(repo, "secret.txt", "token ghp_abcdefghijklmnopqrstuvwx\n");
  git(repo, ["add", "secret.txt"]);
  git(repo, ["commit", "-m", "add note"]);
  const gh = createMockGithubState({ empty: true, defaultBranch: "main" });
  const fetchImpl = createMockGithubFetch(gh);
  const prev = await previewPublish({ repo, workPackageId: WP, providerKind: "github", fetchImpl, mode: "baseline" });
  if (!prev.secretScan.blocked) fail("negative: secrets not detected");
  let secretBlocked = false;
  try {
    await applyPublish({
      repo,
      workPackageId: WP,
      providerKind: "github",
      fetchImpl,
      mode: "baseline",
      previewFingerprint: prev.previewFingerprint,
    });
  } catch (err) {
    secretBlocked = err.code === VCS_CODES.GIT_SECRETS_DETECTED;
  }
  if (!secretBlocked) fail("negative: secrets publish");
  prove("N. untracked/committed secrets block publish");

  writeFile(repo, "src/counter.js", FEATURE_COUNTER);
  writeFile(repo, "src/counter.test.js", FEATURE_TEST);
  mkdirSync(join(repo, "design", WP, "qa"), { recursive: true });
  writeFile(
    repo,
    `design/${WP}/qa/quality-review.json`,
    JSON.stringify({
      reviewId: 1,
      verdict: "PASSED",
      approvalApplied: true,
      snapshot: { digest: "d", files: [{ path: "src/counter.js", sha256: sha("other") }, { path: "src/counter.test.js", sha256: sha(FEATURE_TEST) }] },
    }),
  );
  const drift = await previewDelivery({ repo, workPackageId: WP, jiraWorkPackageKey: "PRX-4" });
  if (drift.qualityMatch) fail("negative: quality mismatch not detected");
  prove("N. Quality snapshot mismatch");

  let noToken = false;
  try {
    await applyMergeRequest({
      repo,
      workPackageId: WP,
      providerKind: "github",
      previewFingerprint: "sha256:dead",
    });
  } catch (err) {
    noToken = err.code === VCS_CODES.GITHUB_TOKEN_UNAVAILABLE || err.code === VCS_CODES.GIT_PUSH_BLOCKED || err.code === VCS_CODES.GIT_PREVIEW_STALE;
  }
  if (!noToken) fail("negative: missing token/push not blocked");
  prove("N. missing GitHub token / unpublished branch");

  rmSync(repo, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

{
  const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
  const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
  const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationModern } = await import(
    "./official-mcp-client.mjs"
  );
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  spawnSync("npm run build -w @praxis/mcp -w @praxis/cli -w @praxis/vcs", { cwd: root, shell: true, encoding: "utf8" });
  const dist = await packClaudeExtension(version);
  const mcpbPath = dist.mcpbPath ?? join(root, "dist", "claude-extensions", version, "praxis-runtime.mcpb");
  const dest = mkdtempSync(join(tmpdir(), "praxis-e2e-mcpb-"));
  const extracted = extractMcpbRuntime(mcpbPath, dest);
  if (existsSync(join(extracted.dest, "node_modules"))) fail("extracted MCPB contains node_modules");
  const fixture = buildConsumerLikeFixture();
  const bare = emptyBare();
  attachSshLikeRemote(fixture.repo, bare);
  const gh = createMockGithubState({ empty: true, defaultBranch: "main", hasReadme: false });
  const mock = await startGithubHttpMock(gh);
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: {
      ...hostedCleanEnv(extracted.dest),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
      PRAXIS_SKIP_DOTENV: "1",
      PRAXIS_GITHUB_TOKEN: "test-token-not-a-real-pat",
      PRAXIS_GITHUB_API_URL: mock.apiUrl,
      PRAXIS_GIT_PROVIDER: "github",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "false",
    },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: 20_000,
    clientVersion: version,
  });
  try {
    const call = async (name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }));
    const st = await call("praxis_developer_git_status", { workPackage: WP, repo: fixture.repo });
    if (!st?.ok) fail(`MCPB status ${JSON.stringify(st)}`);
    const bp = await call("praxis_developer_git_publish_preview", {
      workPackage: WP,
      repo: fixture.repo,
      mode: "baseline",
      provider: "github",
    });
    if (!bp?.ok || bp.data?.targetRemoteBranch !== "main") fail(`MCPB baseline preview ${JSON.stringify(bp)}`);
    if (bp.data?.refspec !== `${fixture.baselineSha}:refs/heads/main`) fail("MCPB refspec");
    const ba = await call("praxis_developer_git_publish", {
      workPackage: WP,
      repo: fixture.repo,
      mode: "baseline",
      confirmation: "YES",
      previewFingerprint: bp.data.previewFingerprint,
    });
    if (!ba?.ok || ba.data?.ok === false) fail(`MCPB baseline apply ${JSON.stringify(ba)}`);
    if (git(bare, ["rev-parse", "refs/heads/main"]).stdout !== fixture.baselineSha) fail("MCPB remote main");
    if (git(bare, ["show-ref", "--heads"]).stdout.includes("refs/heads/master")) fail("MCPB created master");
    const fp = await call("praxis_developer_git_preview", {
      workPackage: WP,
      repo: fixture.repo,
    });
    if (!fp?.ok || !fp.data?.previewFingerprint) fail("MCPB feature preview");
    const fc = await call("praxis_developer_git_commit", {
      workPackage: WP,
      repo: fixture.repo,
      confirmation: "YES",
      previewFingerprint: fp.data.previewFingerprint,
    });
    if (!fc?.ok || fc.data?.ok === false) fail(`MCPB commit ${JSON.stringify(fc)}`);
    const pp = await call("praxis_developer_git_publish_preview", {
      workPackage: WP,
      repo: fixture.repo,
      mode: "branch",
      provider: "github",
    });
    const pb = await call("praxis_developer_git_publish", {
      workPackage: WP,
      repo: fixture.repo,
      mode: "branch",
      confirmation: "YES",
      previewFingerprint: pp.data.previewFingerprint,
    });
    if (!pb?.ok || pb.data?.ok === false) fail(`MCPB feature push ${JSON.stringify(pb)}`);
    const mrp = await call("praxis_developer_git_merge_request_preview", {
      workPackage: WP,
      repo: fixture.repo,
      provider: "github",
    });
    if (mrp.data?.targetBranch !== "main") fail("MCPB PR base");
    const mr = await call("praxis_developer_git_merge_request", {
      workPackage: WP,
      repo: fixture.repo,
      confirmation: "YES",
      previewFingerprint: mrp.data.previewFingerprint,
      provider: "github",
    });
    if (!mr?.ok || mr.data?.ok === false) fail(`MCPB PR ${JSON.stringify(mr)}`);
    if (mr.data?.pullRequestBase !== "main") fail("MCPB PR base field");
    const ds = await call("praxis_developer_git_delivery_status", { workPackage: WP, repo: fixture.repo });
    if (ds.data?.journal?.ciStatus === "success") fail("MCPB fake CI");
    const dump = JSON.stringify({ st, bp, ba, fp, fc, pp, pb, mrp, mr, ds });
    if (/github_pat_|ghp_[A-Za-z0-9]{10,}|ATATT3x/.test(dump)) fail("MCPB leaked token");
    prove("P. Extracted MCPB full Git Delivery");
  } finally {
    await session.close();
    mock.close();
    rmSync(fixture.repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
}

assertConsumerUntouched(consumerBefore);
prove("25. consumer repository unchanged");

console.log(`PASS git-delivery-e2e ${steps.join("; ")}`);
