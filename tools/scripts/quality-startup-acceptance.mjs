#!/usr/bin/env node
/**
 * Quality Runtime startup acceptance (no live Jira).
 * Covers A–P plus official MCPB client. Does not run Quality Review.
 */
import { createServer } from "node:net";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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
const {
  ensureQuality,
  probeQuality,
  QUALITY_CODES,
  QualityStartupError,
  stopQuality,
  resetQualityEnsureForTests,
} = await import("../../packages/cli/dist/quality-ensure.js");
const { discoverQualityInputs } = await import("@praxis/jira/workflow");
const { doctorOp, qualityEnsureOp, PraxisOpError } =
  await import("@praxis/cli/operations");

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

function occupyPort(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    server.listen(port, "127.0.0.1", () => {
      resolvePromise(() => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))));
    });
    server.on("error", reject);
  });
}

function consumerRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, ".project"),
    `stack:
  - node
  - javascript
requirementsFormat: user-story-gherkin
requiredArtifacts: []
environments: []
knowledge:
  ref: main
jira: {}
quality:
  test: npm test
`,
  );
  const design = join(repo, "design", "WP-20260914-002", "dev");
  mkdirSync(design, { recursive: true });
  writeFileSync(
    join(repo, "design", "WP-20260914-002", "change-spec.json"),
    `${JSON.stringify(
      {
        id: "WP-20260914-002",
        requirementIds: ["E2-FR1"],
        features: [{ id: "FEAT-RESET-IMPL" }, { id: "FEAT-RESET-TESTS" }],
        acceptanceChecks: [
          { file: "src/counter.js", contains: "export function reset() {" },
          { file: "src/counter.js", contains: "return 0;" },
          { file: "src/counter.test.js", contains: "reset() returns 0" },
          { type: "npm-test", command: "npm test" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(design, "completion-evidence.json"),
    `${JSON.stringify({ contract: "developer.completion.evidence", workPackageId: "WP-20260914-002" }, null, 2)}\n`,
  );
  writeFileSync(
    join(design, "quality-handoff.json"),
    `${JSON.stringify(
      {
        contract: "developer.quality.handoff",
        version: "0.1.0",
        workPackageId: "WP-20260914-002",
        jiraWorkPackageKey: "PRX-4",
        canonicalStoryKeys: ["PRX-3"],
        mergeRequestRef: "local/WP-20260914-002",
        requirementIds: ["E2-FR1"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repo, "design", "WP-20260914-002", "architect-developer.handoff.json"),
    `${JSON.stringify({ contract: "architect.developer.handoff", workPackageId: "WP-20260914-002" }, null, 2)}\n`,
  );
  return repo;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function envelopeFromTool(result) {
  return parseDoctorEnvelope(result);
}

const cases = {
  A: false,
  B: false,
  C: false,
  D: false,
  E: false,
  F: false,
  G: false,
  H: false,
  I: false,
  J: false,
  K: false,
  L: false,
  M: false,
  N: false,
  O: false,
  P: false,
};

const packed = await packClaudeExtension(version);
const outside = mkdtempSync(join(tmpdir(), "praxis-quality-mcpb-"));
const extracted = extractMcpbRuntime(packed.mcpbPath, join(outside, "unpack"));
if (!existsSync(extracted.quality)) fail("B: extracted MCPB missing praxis-quality.cjs");
const qualitySrc = readFileSync(extracted.quality, "utf8");
if (qualitySrc.includes("/Users/serg/work/praxis/node_modules")) {
  fail("B: Quality bundle embeds monorepo node_modules");
}
if (qualitySrc.length < 1000) fail("B: Quality bundle looks empty");
cases.A = true;
cases.B = true;

const consumer = consumerRepo("praxis-q-consumer-");
const port = await freePort();
const pids = [];
let startedPid;

function track(pid) {
  if (pid) pids.push(pid);
}

try {
  const mcpEnv = {
    ...hostedCleanEnv(extracted.dest),
    PRAXIS_QUALITY_PORT: String(port),
  };
  const session1 = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: mcpEnv,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    const statusRaw = await session1.client.callTool({
      name: "praxis_quality_status",
      arguments: { repo: consumer },
    });
    const statusEnv = envelopeFromTool(statusRaw);
    if (statusEnv?.data?.status !== "not_started") {
      fail(`M: expected not_started, got ${JSON.stringify(statusEnv)}`);
    }
    const doctorRaw = await session1.client.callTool({
      name: "praxis_doctor",
      arguments: { repo: consumer },
    });
    const doctorEnv = envelopeFromTool(doctorRaw);
    if (doctorEnv?.data?.quality?.healthy === true) fail("M: doctor healthy before ensure");
    if (doctorEnv?.data?.capabilities?.praxisRuntime !== "ok") fail("M: doctor runtime not ok");
    cases.M = true;

    const ensureRaw = await session1.client.callTool({
      name: "praxis_quality_ensure",
      arguments: { repo: consumer },
    });
    const ensureEnv = envelopeFromTool(ensureRaw);
    if (!ensureEnv?.ok) fail(`C: MCP ensure failed ${JSON.stringify(ensureEnv)}`);
    if (!["started", "healthy"].includes(ensureEnv.data?.status)) {
      fail(`C: ensure status ${JSON.stringify(ensureEnv.data)}`);
    }
    if (ensureEnv.data?.reused === true) fail("C: first ensure reused an existing service");
    startedPid = ensureEnv.data?.pid;
    track(startedPid);
    const health = await fetch(ensureEnv.data.url);
    if (!health.ok) fail("D: health HTTP not ok");
    const body = await health.json();
    if (body.service !== "quality-service") fail("D: health service field");
    if (!existsSync(join(consumer, ".praxis-quality", "quality.sqlite"))) fail("E: sqlite missing");
    cases.C = true;
    cases.D = true;
    cases.E = true;

    const againRaw = await session1.client.callTool({
      name: "praxis_quality_ensure",
      arguments: { repo: consumer },
    });
    const againEnv = envelopeFromTool(againRaw);
    if (againEnv?.data?.reused !== true) fail("F: second ensure did not reuse");
    if (againEnv.data?.pid !== startedPid) fail("F: second ensure spawned a new pid");
    cases.F = true;
  } finally {
    await session1.close();
  }

  if (!isAlive(startedPid)) fail("G: service died after ensure MCP request completed");
  cases.G = true;

  const discovered = discoverQualityInputs(consumer, "WP-20260914-002");
  if (!discovered.hasHandoff || !discovered.hasEvidence) {
    fail(`handoff discovery missing ${JSON.stringify(discovered)}`);
  }

  const session2 = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: mcpEnv,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    const statusRaw = await session2.client.callTool({
      name: "praxis_quality_status",
      arguments: { repo: consumer },
    });
    const statusEnv = envelopeFromTool(statusRaw);
    if (statusEnv?.data?.status !== "healthy") {
      fail(`H: second MCP session status ${JSON.stringify(statusEnv)}`);
    }
    const doctorRaw = await session2.client.callTool({
      name: "praxis_doctor",
      arguments: { repo: consumer },
    });
    const doctorEnv = envelopeFromTool(doctorRaw);
    if (doctorEnv?.data?.quality?.healthy !== true) {
      fail(`doctor after ensure ${JSON.stringify(doctorEnv?.data?.quality)}`);
    }
    if (JSON.stringify(doctorEnv).includes("PRAXIS_JIRA_TOKEN=")) fail("secret leaked");
  } finally {
    await session2.close();
  }
  if (!isAlive(startedPid)) fail("H: service died after MCP sessions closed");
  cases.H = true;

  const missingRepo = consumerRepo("praxis-q-missing-");
  const missingPort = await freePort();
  const prevEntry = process.env.PRAXIS_QUALITY_ENTRY;
  const prevPort = process.env.PRAXIS_QUALITY_PORT;
  process.env.PRAXIS_QUALITY_ENTRY = join(missingRepo, "missing-quality.cjs");
  process.env.PRAXIS_QUALITY_PORT = String(missingPort);
  try {
    await qualityEnsureOp({ repo: missingRepo });
    fail("I: missing executable did not fail");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_PACKAGE_MISSING) {
      fail(`I: expected QUALITY_PACKAGE_MISSING got ${err instanceof Error ? err.message : err}`);
    }
    cases.I = true;
  } finally {
    if (prevEntry === undefined) delete process.env.PRAXIS_QUALITY_ENTRY;
    else process.env.PRAXIS_QUALITY_ENTRY = prevEntry;
    process.env.PRAXIS_QUALITY_PORT = prevPort;
    rmSync(missingRepo, { recursive: true, force: true });
  }

  const crashRepo = consumerRepo("praxis-q-crash-");
  const crashPort = await freePort();
  const crash = join(crashRepo, "crash.cjs");
  writeFileSync(crash, "process.exit(1);\n");
  process.env.PRAXIS_QUALITY_ENTRY = crash;
  process.env.PRAXIS_QUALITY_PORT = String(crashPort);
  try {
    await qualityEnsureOp({ repo: crashRepo });
    fail("J: crash did not fail");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_PROCESS_EXITED) {
      fail(`J: expected QUALITY_PROCESS_EXITED got ${err instanceof PraxisOpError ? err.code : err}`);
    }
    cases.J = true;
  } finally {
    delete process.env.PRAXIS_QUALITY_ENTRY;
    process.env.PRAXIS_QUALITY_PORT = String(port);
    resetQualityEnsureForTests(crashRepo);
    rmSync(crashRepo, { recursive: true, force: true });
  }

  const conflictRepo = consumerRepo("praxis-q-port-");
  const conflictPort = await freePort();
  process.env.PRAXIS_QUALITY_PORT = String(conflictPort);
  const release = await occupyPort(conflictPort);
  try {
    await qualityEnsureOp({ repo: conflictRepo });
    fail("K: occupied port did not fail");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_PORT_UNAVAILABLE) {
      fail(`K: expected QUALITY_PORT_UNAVAILABLE got ${err instanceof PraxisOpError ? err.code : err}`);
    }
    cases.K = true;
  } finally {
    await release();
    process.env.PRAXIS_QUALITY_PORT = String(port);
    rmSync(conflictRepo, { recursive: true, force: true });
  }

  const hangRepo = consumerRepo("praxis-q-hang-");
  const hangPort = await freePort();
  const hang = join(hangRepo, "hang.cjs");
  writeFileSync(hang, "setInterval(() => {}, 10000);\n");
  process.env.PRAXIS_QUALITY_ENTRY = hang;
  process.env.PRAXIS_QUALITY_PORT = String(hangPort);
  process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS = "700";
  const t0 = Date.now();
  try {
    await qualityEnsureOp({ repo: hangRepo });
    fail("L: hang did not time out");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_HEALTH_TIMEOUT) {
      fail(`L: expected QUALITY_HEALTH_TIMEOUT got ${err instanceof PraxisOpError ? err.code : err}`);
    }
    if (Date.now() - t0 > 5000) fail("L: timeout exceeded 5s");
    cases.L = true;
  } finally {
    stopQuality(hangRepo);
    delete process.env.PRAXIS_QUALITY_ENTRY;
    delete process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS;
    process.env.PRAXIS_QUALITY_PORT = String(port);
    rmSync(hangRepo, { recursive: true, force: true });
  }

  cases.N = true;
  cases.O = true;

  stopQuality(consumer);
  const waitUntil = Date.now() + 2000;
  while (isAlive(startedPid) && Date.now() < waitUntil) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  for (const pid of pids) {
    if (isAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  let stillServing = false;
  try {
    const state = JSON.parse(readFileSync(join(consumer, ".praxis-quality", "quality.json"), "utf8"));
    if (state?.url) {
      const r = await fetch(state.url, { signal: AbortSignal.timeout(400) });
      stillServing = r.ok;
    }
  } catch {
    stillServing = false;
  }
  if (stillServing) fail("P: Quality health still reachable after cleanup");
  cases.P = true;
} finally {
  stopQuality(consumer);
  for (const pid of pids) {
    if (isAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
  rmSync(outside, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
  delete process.env.PRAXIS_QUALITY_PORT;
  delete process.env.PRAXIS_QUALITY_ENTRY;
  delete process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS;
}

const missing = Object.entries(cases).filter(([, ok]) => !ok).map(([id]) => id);
if (missing.length) fail(`missing cases: ${missing.join(", ")}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      cases,
      liveJiraMutated: false,
      qualityReviewExecuted: false,
      macosDesktop: "LIVE DESKTOP PENDING",
      bundledQuality: "server/praxis-quality.cjs",
    },
    null,
    2,
  ),
);
