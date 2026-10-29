#!/usr/bin/env node
/**
 * External Quality acceptance against praxis-test (colocated src/*.test.js).
 *
 * Usage:
 *   node tools/scripts/quality-praxis-test-acceptance.mjs
 *
 * Env:
 *   PRAXIS_TEST_ROOT  default ~/praxis-acceptance/praxis-test
 *   PRAXIS_ACCEPTANCE_ROOT default ~/praxis-acceptance
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createQualityApp, QualityStore } from "../../apps/quality-service/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const praxisTest =
  process.env.PRAXIS_TEST_ROOT ??
  join(homedir(), "praxis-acceptance", "praxis-test");
const allowedRoot =
  process.env.PRAXIS_ACCEPTANCE_ROOT ??
  join(homedir(), "praxis-acceptance");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(praxisTest)) fail(`praxis-test missing: ${praxisTest}`);
const handoffPath = join(
  praxisTest,
  "design/WP-20260901-001/dev/quality-handoff.json",
);
if (!existsSync(handoffPath)) fail(`handoff missing: ${handoffPath}`);
const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));

const dbDir = mkdtempSync(join(tmpdir(), "praxis-q-ext-"));
const dbPath = join(dbDir, "quality.sqlite");
const qualityBin = join(root, "apps/quality-service/bin/praxis-quality.mjs");

// --- CLI ---
const cli = spawnSync(
  process.execPath,
  [
    qualityBin,
    "review-path",
    "--path",
    praxisTest,
    "--handoff",
    handoffPath,
    "--project",
    "praxis-test",
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      PRAXIS_QUALITY_DB: dbPath,
      PRAXIS_QUALITY_ALLOWED_ROOT: allowedRoot,
    },
  },
);
if (cli.status !== 0 && !cli.stdout) {
  fail(`CLI failed:\n${cli.stderr}\n${cli.stdout}`);
}
let cliOut;
try {
  cliOut = JSON.parse(cli.stdout);
} catch {
  fail(`CLI non-JSON:\n${cli.stdout}\n${cli.stderr}`);
}
if (cliOut.verdict !== "pass") {
  fail(`CLI verdict=${cliOut.verdict}\n${JSON.stringify(cliOut.findings, null, 2)}`);
}
const hasTests = (cliOut.findings ?? []).find((f) => f.id === "has-tests");
if (!hasTests?.ok) fail(`CLI has-tests not ok: ${hasTests?.detail}`);
const rerun = (cliOut.findings ?? []).find((f) => f.id === "rerun-tests");
if (!rerun?.ok) fail(`CLI rerun-tests not ok: ${rerun?.detail}`);
if (cliOut.testExecution?.executedCount !== 4) {
  fail(`CLI expected 4 tests executed, got ${cliOut.testExecution?.executedCount}`);
}

// --- HTTP ---
process.env.PRAXIS_QUALITY_ALLOWED_ROOT = allowedRoot;
const store = new QualityStore(dbPath);
const server = createQualityApp(store);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const post = await fetch(`${base}/reviews/path`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    projectId: "praxis-test",
    path: praxisTest,
    handoff,
  }),
});
const postBody = await post.json();
if (post.status !== 200) fail(`HTTP POST ${post.status}: ${JSON.stringify(postBody)}`);
if (postBody.verdict !== "pass") {
  fail(`HTTP verdict=${postBody.verdict}\n${JSON.stringify(postBody.findings, null, 2)}`);
}
if (postBody.workPackageId !== handoff.workPackageId) {
  fail("HTTP workPackageId mismatch");
}
const get = await fetch(`${base}/reviews/${postBody.reviewId}`);
const getBody = await get.json();
if (get.status !== 200) fail(`GET review failed: ${get.status}`);
if (getBody.verdict !== "pass") fail("GET review verdict not pass");

await new Promise((r, j) => server.close((e) => (e ? j(e) : r())));
store.close();

// Restart persistence
const store2 = new QualityStore(dbPath);
const server2 = createQualityApp(store2);
await new Promise((r) => server2.listen(0, "127.0.0.1", r));
const port2 = server2.address().port;
const get2 = await fetch(`http://127.0.0.1:${port2}/reviews/${postBody.reviewId}`);
const get2Body = await get2.json();
if (get2.status !== 200 || get2Body.verdict !== "pass") {
  fail("persisted review missing after restart");
}
await new Promise((r, j) => server2.close((e) => (e ? j(e) : r())));
store2.close();

console.log(
  JSON.stringify(
    {
      ok: true,
      cli: {
        verdict: cliOut.verdict,
        hasTests: hasTests.detail,
        rerun: rerun.detail,
        executedCount: cliOut.testExecution?.executedCount,
      },
      http: {
        reviewId: postBody.reviewId,
        verdict: postBody.verdict,
        workPackageId: postBody.workPackageId,
        persistedAfterRestart: true,
      },
    },
    null,
    2,
  ),
);

rmSync(dbDir, { recursive: true, force: true });
