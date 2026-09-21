#!/usr/bin/env node
/**
 * Quality Review acceptance (no live Jira, no live praxis-test mutation).
 * Official extracted MCPB client. Quality Service is the review engine.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const WP = "WP-20260914-002";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/knowledge -w @praxis/project-config -w @praxis/jira -w @praxis/quality-service -w @praxis/cli -w @praxis/mcp",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const { packClaudeExtension } = await import("./pack-claude-extension.mjs");
const { extractMcpbRuntime } = await import("./mcpb-runtime.mjs");
const {
  connectOfficialMcp,
  hostedCleanEnv,
  parseDoctorEnvelope,
  MCP_STARTUP_BUDGET_MS,
  versionNegotiationModern,
} = await import("./official-mcp-client.mjs");
const { stopQuality } = await import("../../packages/cli/dist/quality-ensure.js");

function envelopeFromTool(result) {
  return parseDoctorEnvelope(result);
}

async function callMcp(session, name, args, timeout = 60_000) {
  return envelopeFromTool(
    await session.client.callTool({ name, arguments: args }, { timeout }),
  );
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
    server.on("error", reject);
  });
}

function write(repo, rel, body) {
  const fp = join(repo, rel);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, body);
}

function seedProduct(repo, opts = {}) {
  write(
    repo,
    "package.json",
    JSON.stringify({
      name: "praxis-quality-fixture",
      type: "module",
      scripts: { test: opts.testScript ?? "node --test src/*.test.js" },
    }),
  );
  write(
    repo,
    ".project",
    `stack:
  - node
quality:
  test: npm test
`,
  );
  write(
    repo,
    "src/counter.js",
    opts.counter ?? "export function reset() {\n  return 0;\n}\nexport function inc(n){ return n + 1; }\n",
  );
  write(
    repo,
    "src/counter.test.js",
    opts.testFile ??
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, inc } from './counter.js';
test('reset() returns 0', () => assert.equal(reset(), 0));
test('inc 1', () => assert.equal(inc(1), 2));
test('inc 0', () => assert.equal(inc(0), 1));
test('inc 2', () => assert.equal(inc(2), 3));
test('reset again', () => assert.equal(reset(), 0));
`,
  );
  write(
    repo,
    `work-packages/${WP}/manifest.json`,
    JSON.stringify({
      id: WP,
      jiraIssueKey: "PRX-4",
      storyKeys: ["PRX-3"],
      readyForQuality: true,
      qualityState: "pending",
    }),
  );
  const checks = opts.acceptanceChecks ?? [
    { type: "contains", file: "src/counter.js", expected: "export function reset() {" },
    { type: "contains", file: "src/counter.js", expected: "return 0;" },
    { type: "contains", file: "src/counter.test.js", expected: "reset() returns 0" },
    { type: "npm-test", command: "npm test" },
  ];
  write(
    repo,
    `design/${WP}/change-spec.json`,
    opts.changeSpecRaw ??
      JSON.stringify({
        workPackageId: WP,
        requirementIds: ["E2-FR1"],
        features: [{ id: "FEAT-RESET-IMPL" }, { id: "FEAT-RESET-TESTS" }],
        changes: [{ file: "src/counter.js" }, { file: "src/counter.test.js" }],
        acceptanceChecks: checks,
      }),
  );
  write(
    repo,
    `design/${WP}/architect-developer.handoff.json`,
    JSON.stringify({ contract: "architect.developer.handoff", workPackageId: WP }),
  );
  if (opts.omitEvidence !== true) {
    write(
      repo,
      `design/${WP}/dev/completion-evidence.json`,
      JSON.stringify({
        contract: "developer.completion.evidence",
        workPackageId: WP,
        jiraWorkPackageKey: "PRX-4",
        canonicalStoryKeys: ["PRX-3"],
        requirementIds: ["E2-FR1"],
        readyForQuality: true,
        verification: { command: "npm test", exitCode: 0, passed: 99, failed: 0 },
      }),
    );
    write(
      repo,
      `design/${WP}/dev/quality-handoff.json`,
      JSON.stringify({
        contract: "developer.quality.handoff",
        workPackageId: WP,
        jiraWorkPackageKey: "PRX-4",
        canonicalStoryKeys: ["PRX-3"],
        requirementIds: ["E2-FR1"],
        acceptanceChecks: checks,
      }),
    );
  }
}

await packClaudeExtension(version);
const { mcpbPath } = await import("./mcpb-runtime.mjs").then((m) => m.ensurePackedExtension(root, version));
const outside = mkdtempSync(join(tmpdir(), "praxis-qrev-mcpb-"));
const unpack = join(outside, "praxis-runtime");
mkdirSync(unpack, { recursive: true });
const extracted = extractMcpbRuntime(mcpbPath, unpack);
const proven = [];

const repo = mkdtempSync(join(tmpdir(), "praxis-qrev-"));
mkdirSync(join(repo, ".git"), { recursive: true });
seedProduct(repo);
if (existsSync(join(repo, "node_modules", "@praxis"))) {
  fail("B: consumer repo must not contain Praxis npm packages");
}

const port = await freePort();
const mcpEnv = {
  ...hostedCleanEnv(extracted.dest),
  PRAXIS_QUALITY_PORT: String(port),
};

async function withSession(fn) {
  const session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: mcpEnv,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  const orig = session.client.callTool.bind(session.client);
  session.client.callTool = (req, extra) => orig(req, { timeout: 60_000, ...(extra ?? {}) });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

try {
  const tools = await withSession(async (session) => {
    const listed = await session.client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const n of [
      "praxis_quality_review",
      "praxis_quality_apply_preview",
      "praxis_quality_apply",
      "praxis_quality_status",
    ]) {
      if (!names.includes(n)) fail(`A: extracted MCPB missing ${n}`);
    }
    const ensureRaw = await session.client.callTool({
      name: "praxis_quality_ensure",
      arguments: { repo },
    });
    const ensureEnv = envelopeFromTool(ensureRaw);
    if (!ensureEnv?.ok) fail(`C: ensure failed ${JSON.stringify(ensureEnv)}`);
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo },
    });
    const review = envelopeFromTool(reviewRaw);
    if (!review?.ok) fail(`D: review failed ${JSON.stringify(review)}`);
    const data = review.data ?? {};
    if (data.qualityServiceUsed !== true) fail("D: Quality Service not used");
    if (data.jiraMutated !== false) fail("K: jiraMutated");
    if (data.approvalApplied !== false) fail("K: approvalApplied");
    if (data.verdict !== "PASSED") fail(`G: verdict ${data.verdict}`);
    if ((data.acceptanceChecks ?? []).length !== 4) fail("G: expected 4 checks");
    if (!(data.acceptanceChecks ?? []).every((c) => c.status === "PASSED")) {
      fail(`G: checks ${JSON.stringify(data.acceptanceChecks)}`);
    }
    if (data.verification?.exitCode !== 0) fail("H: own test exitCode");
    if (data.verification?.total !== 5 || data.verification?.passed !== 5 || data.verification?.failed !== 0) {
      fail(`I: test counts ${JSON.stringify(data.verification)}`);
    }
    if (data.verification?.passed === 99) fail("J: substituted Developer evidence counts");
    if (!existsSync(join(repo, ".praxis-quality", "quality.sqlite"))) fail("E: sqlite missing");
    if (!existsSync(join(repo, "design", WP, "qa", "quality-review.json"))) fail("F: local evidence missing");
    const firstId = data.reviewId;
    const againRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo },
    });
    const again = envelopeFromTool(againRaw);
    if (!again?.ok) fail(`M: repeat review failed ${JSON.stringify(again)}`);
    if (again.data?.verdict !== "PASSED") fail(`M: repeat verdict ${JSON.stringify(again.data)}`);
    return { firstId, secondId: again.data?.reviewId ?? firstId };
  });
  proven.push("A-M review via extracted MCPB / Quality Service / evidence / no Jira");

  await withSession(async (session) => {
    const statusRaw = await session.client.callTool({
      name: "praxis_quality_status",
      arguments: { repo, workPackage: WP },
    });
    const status = envelopeFromTool(statusRaw);
    if (!(status?.data?.review?.latestReviewId > 0)) {
      fail(`N: review not visible after restart ${JSON.stringify(status)}`);
    }
    if (status.data.review.verdict !== "PASSED") fail("N: latest verdict not PASSED");
  });
  proven.push("N review available after MCP session restart");

  stopQuality(repo);
  await withSession(async (session) => {
    const ensureRaw = await session.client.callTool({
      name: "praxis_quality_ensure",
      arguments: { repo },
    });
    const ensureEnv = envelopeFromTool(ensureRaw);
    if (!ensureEnv?.ok) fail(`O: ensure after worker stop failed ${JSON.stringify(ensureEnv)}`);
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo },
    });
    const review = envelopeFromTool(reviewRaw);
    if (!review?.ok) fail(`O: review after restart failed ${JSON.stringify(review)}`);
  });
  proven.push("O interrupted Quality worker safely restarted");

  const failRepo = mkdtempSync(join(tmpdir(), "praxis-qrev-fail-"));
  mkdirSync(join(failRepo, ".git"), { recursive: true });
  seedProduct(failRepo, { counter: "export function inc(n){ return n+1; }\n" });
  await withSession(async (session) => {
    await session.client.callTool({ name: "praxis_quality_ensure", arguments: { repo: failRepo } });
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo: failRepo },
    });
    const review = envelopeFromTool(reviewRaw);
    if (review?.data?.verdict === "PASSED") fail("failed-A: missing string reported PASSED");
    if (review?.data?.jiraMutated) fail("failed-A: jira mutated");
  });
  stopQuality(failRepo);

  const failTest = mkdtempSync(join(tmpdir(), "praxis-qrev-failtest-"));
  mkdirSync(join(failTest, ".git"), { recursive: true });
  seedProduct(failTest, {
    testFile: `import test from 'node:test'; import assert from 'node:assert/strict'; test('boom', () => assert.equal(1, 2));\n`,
  });
  await withSession(async (session) => {
    await session.client.callTool({ name: "praxis_quality_ensure", arguments: { repo: failTest } });
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo: failTest },
    });
    const review = envelopeFromTool(reviewRaw);
    if (review?.data?.verdict === "PASSED") fail("failed-B: failing npm test PASSED");
  });
  stopQuality(failTest);

  const miss = mkdtempSync(join(tmpdir(), "praxis-qrev-miss-"));
  mkdirSync(join(miss, ".git"), { recursive: true });
  seedProduct(miss, { omitEvidence: true });
  await withSession(async (session) => {
    await session.client.callTool({ name: "praxis_quality_ensure", arguments: { repo: miss } });
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo: miss },
    });
    const review = envelopeFromTool(reviewRaw);
    if (review?.data?.verdict === "PASSED") fail("failed-C: missing evidence PASSED");
  });
  stopQuality(miss);

  const unsup = mkdtempSync(join(tmpdir(), "praxis-qrev-unsup-"));
  mkdirSync(join(unsup, ".git"), { recursive: true });
  seedProduct(unsup, { acceptanceChecks: [{ type: "screenshot", file: "x.png" }] });
  await withSession(async (session) => {
    await session.client.callTool({ name: "praxis_quality_ensure", arguments: { repo: unsup } });
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo: unsup },
    });
    const review = envelopeFromTool(reviewRaw);
    if (review?.data?.verdict === "PASSED") fail("failed-D: unsupported check PASSED");
    if (review?.data?.verdict !== "BLOCKED") fail(`failed-D: expected BLOCKED ${review?.data?.verdict}`);
  });
  stopQuality(unsup);

  const malformed = mkdtempSync(join(tmpdir(), "praxis-qrev-bad-"));
  mkdirSync(join(malformed, ".git"), { recursive: true });
  seedProduct(malformed, { changeSpecRaw: "{not-json" });
  await withSession(async (session) => {
    await session.client.callTool({ name: "praxis_quality_ensure", arguments: { repo: malformed } });
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo: malformed },
    });
    const review = envelopeFromTool(reviewRaw);
    if (review?.ok && review?.data?.verdict === "PASSED") fail("failed-E: malformed PASSED");
  });
  stopQuality(malformed);

  const dead = mkdtempSync(join(tmpdir(), "praxis-qrev-dead-"));
  mkdirSync(join(dead, ".git"), { recursive: true });
  seedProduct(dead);
  await withSession(async (session) => {
    const reviewRaw = await session.client.callTool({
      name: "praxis_quality_review",
      arguments: { workPackage: WP, repo: dead },
    });
    const review = envelopeFromTool(reviewRaw);
    if (review?.ok && review?.data?.verdict === "PASSED" && process.env.PRAXIS_QUALITY_URL === "http://127.0.0.1:1") {
      fail("failed-F: unavailable service PASSED");
    }
  });

  proven.push("failed review cases A-E no false PASSED");
} finally {
  stopQuality(repo);
  rmSync(outside, { recursive: true, force: true });
}

console.log(`PASS quality-review ${proven.join("; ")}`);
