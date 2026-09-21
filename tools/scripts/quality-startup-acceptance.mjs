#!/usr/bin/env node
/**
 * Quality Runtime startup acceptance (no live Jira).
 * Covers A–P plus official MCPB client. Does not run Quality Review.
 * Case O/P are Electron-style (mock helper path / simulated execPath), not live Claude Desktop GUI.
 */
import { createServer } from "node:net";
import {
  chmodSync,
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
import { spawn, spawnSync } from "node:child_process";

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
  probeSqliteInProcess,
  probeSqliteWithExecutable,
  classifySqliteProbeError,
  resolveQualityChildRuntime,
  waitForChildStart,
  isElectronHelperExecutable,
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

function writeFakeNodeWithoutSqlite(dir) {
  const fake = join(dir, "fake-node");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const real = process.env.REAL_NODE || ${JSON.stringify(process.execPath)};
const args = process.argv.slice(2);
const joined = args.join(" ");
if (args[0] === "-e" && joined.includes("node:sqlite")) {
  process.stdout.write(JSON.stringify({
    ok: false,
    version: "v24.20.0",
    versionsNode: "24.20.0",
    execPath: process.argv[1],
    platform: process.platform,
    arch: process.arch,
    electron: null,
    code: "ERR_UNKNOWN_BUILTIN_MODULE",
    message: "No such built-in module: node:sqlite"
  }));
  process.exit(2);
}
const r = spawnSync(real, args, { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
`,
  );
  chmodSync(fake, 0o755);
  return fake;
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
if (!existsSync(extracted.quality)) fail("F: extracted MCPB missing praxis-quality.cjs");
if (!existsSync(extracted.wasm)) fail("F: extracted MCPB missing sql-wasm.wasm");
const qualitySrc = readFileSync(extracted.quality, "utf8");
if (qualitySrc.includes("/Users/serg/work/praxis/node_modules")) {
  fail("F: Quality bundle embeds monorepo node_modules");
}
if (qualitySrc.includes("node_modules/@praxis/quality-service")) {
  fail("F: Quality bundle still references monorepo @praxis/quality-service");
}
if (qualitySrc.length < 1000) fail("F: Quality bundle looks empty");
if (!existsSync(join(extracted.dest, "node_modules"))) {
  /* expected: packaged MCPB has no node_modules */
}
cases.F = true;

const parentProbe = probeSqliteInProcess();
if (parentProbe.moduleLoad !== "success") {
  fail(`A: host node:sqlite unavailable ${JSON.stringify(parentProbe)}`);
}
if (parentProbe.execPath !== process.execPath) fail("A: parent execPath mismatch");
cases.A = true;

const fakeDir = mkdtempSync(join(tmpdir(), "praxis-fake-node-"));
const fakeNode = writeFakeNodeWithoutSqlite(fakeDir);
const noSqliteProbe = probeSqliteWithExecutable(fakeNode);
if (noSqliteProbe.moduleLoad !== "failure") fail(`B: fake node unexpectedly loaded sqlite ${JSON.stringify(noSqliteProbe)}`);
if (noSqliteProbe.errorCode !== "ERR_UNKNOWN_BUILTIN_MODULE") {
  fail(`C: expected ERR_UNKNOWN_BUILTIN_MODULE got ${noSqliteProbe.errorCode}`);
}
const classified = classifySqliteProbeError(noSqliteProbe);
if (classified !== QUALITY_CODES.QUALITY_SQLITE_UNAVAILABLE) {
  fail(`C: classified ${classified}`);
}
if (String(noSqliteProbe.errorMessage || "").includes("requires Node.js 22+")) {
  fail("C: misleading Node 22+ message");
}
cases.C = true;

const runtime = resolveQualityChildRuntime();
if (!runtime.parent.execPath || !runtime.execPath) fail("D: missing parent/child executable");
if (runtime.parent.version !== process.version) fail("D: parent version mismatch");
const previousNode = process.env.PRAXIS_QUALITY_NODE;
process.env.PRAXIS_QUALITY_NODE = fakeNode;
const mismatched = resolveQualityChildRuntime();
if (mismatched.execPath !== fakeNode) fail(`D: PRAXIS_QUALITY_NODE ignored (${mismatched.execPath})`);
if (mismatched.parent.execPath === mismatched.execPath) fail("D: parent and child execPath should differ under override");
if (previousNode === undefined) delete process.env.PRAXIS_QUALITY_NODE;
else process.env.PRAXIS_QUALITY_NODE = previousNode;
cases.D = true;

const sqljsRepo = consumerRepo("praxis-q-sqljs-");
const sqljsPort = await freePort();
const prevSqlite = process.env.PRAXIS_QUALITY_SQLITE;
const prevEntry = process.env.PRAXIS_QUALITY_ENTRY;
const prevPort = process.env.PRAXIS_QUALITY_PORT;
process.env.PRAXIS_QUALITY_SQLITE = "sqljs";
process.env.PRAXIS_QUALITY_ENTRY = extracted.quality;
process.env.PRAXIS_QUALITY_PORT = String(sqljsPort);
try {
  const started = await ensureQuality({ repo: sqljsRepo });
  if (!["started", "healthy"].includes(started.status)) fail(`B: sqljs ensure ${JSON.stringify(started)}`);
  const health = await fetch(started.url);
  if (!health.ok) fail("B: sqljs health HTTP not ok");
  const body = await health.json();
  if (body.sqliteEngine !== "sqljs") fail(`B: expected sqljs engine got ${body.sqliteEngine}`);
  if (!existsSync(join(sqljsRepo, ".praxis-quality", "quality.sqlite"))) fail("B: sqljs sqlite missing");
  cases.B = true;
} finally {
  stopQuality(sqljsRepo);
  resetQualityEnsureForTests(sqljsRepo);
  rmSync(sqljsRepo, { recursive: true, force: true });
  if (prevSqlite === undefined) delete process.env.PRAXIS_QUALITY_SQLITE;
  else process.env.PRAXIS_QUALITY_SQLITE = prevSqlite;
  if (prevEntry === undefined) delete process.env.PRAXIS_QUALITY_ENTRY;
  else process.env.PRAXIS_QUALITY_ENTRY = prevEntry;
  if (prevPort === undefined) delete process.env.PRAXIS_QUALITY_PORT;
  else process.env.PRAXIS_QUALITY_PORT = prevPort;
}

if (!["darwin", "linux"].includes(process.platform)) fail(`E: unsupported platform ${process.platform}`);
if (!["arm64", "x64"].includes(process.arch)) fail(`E: unsupported arch ${process.arch}`);
if (runtime.execPath !== process.execPath && !process.env.PRAXIS_QUALITY_NODE) {
  fail("E: default child executable should be the MCP parent execPath");
}
cases.E = true;

const helperExec =
  "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin).app/Contents/MacOS/Claude Helper (Plugin)";
if (!isElectronHelperExecutable(helperExec)) fail("O: Claude Helper (Plugin) path was not classified as a helper");
if (isElectronHelperExecutable(process.execPath)) fail("O: ordinary Node CLI classified as Electron helper");
process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH = helperExec;
const helperRuntime = resolveQualityChildRuntime();
delete process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH;
if (helperRuntime.mode !== "worker") fail(`O: expected worker mode, got ${helperRuntime.mode}`);
if (helperRuntime.execPath !== process.execPath) fail("O: worker runtime must keep the current JS executable");
if (helperRuntime.parent.execPath !== helperExec) fail("O: parent execPath should remain the helper path");

const helperDir = mkdtempSync(join(tmpdir(), "praxis-helper-"));
const helperBin = join(
  helperDir,
  "Claude Helper (Plugin).app",
  "Contents",
  "MacOS",
  "Claude Helper (Plugin)",
);
mkdirSync(dirname(helperBin), { recursive: true });
writeFileSync(
  helperBin,
  "#!/bin/sh\necho '[FATAL] Unable to find helper app' >&2\nexit 1\n",
);
chmodSync(helperBin, 0o755);
const helperChild = spawn(helperBin, [extracted.quality], {
  stdio: ["ignore", "pipe", "pipe"],
});
const helperWait = await waitForChildStart(helperChild, 2000);
if (!helperWait.pid && !helperWait.error) {
  fail("O: spawn returned neither pid nor error event");
}
const helperExit = await new Promise((resolve) => {
  if (helperChild.exitCode !== null || helperWait.exitCode != null || helperWait.exitSignal) {
    resolve({
      code: helperChild.exitCode ?? helperWait.exitCode ?? null,
      signal: helperWait.exitSignal ?? null,
    });
    return;
  }
  const t = setTimeout(() => {
    resolve({ code: helperChild.exitCode, signal: "timeout" });
  }, 1500);
  helperChild.once("exit", (code, signal) => {
    clearTimeout(t);
    resolve({ code, signal });
  });
});
if (!helperWait.error && helperExit.code !== 1) {
  fail(`O: helper-style executable did not exit 1 ${JSON.stringify({ helperWait, helperExit })}`);
}
cases.O = true;

const electronRepo = consumerRepo("praxis-q-electron-");
const electronPort = await freePort();
const electronSession = await connectOfficialMcp({
  command: process.execPath,
  args: extracted.args,
  cwd: extracted.dest,
  env: {
    ...hostedCleanEnv(extracted.dest),
    PRAXIS_QUALITY_PORT: String(electronPort),
    PRAXIS_QUALITY_SIMULATED_EXEC_PATH: helperExec,
  },
  versionNegotiation: versionNegotiationModern(),
  timeoutMs: MCP_STARTUP_BUDGET_MS,
  clientVersion: version,
});
try {
  const statusRaw = await electronSession.client.callTool({
    name: "praxis_quality_status",
    arguments: { repo: electronRepo },
  });
  const statusEnv = envelopeFromTool(statusRaw);
  if (statusEnv?.data?.status !== "not_started") {
    fail(`P: electron-style expected not_started ${JSON.stringify(statusEnv)}`);
  }
  const ensureRaw = await electronSession.client.callTool({
    name: "praxis_quality_ensure",
    arguments: { repo: electronRepo },
  });
  const ensureEnv = envelopeFromTool(ensureRaw);
  if (!ensureEnv?.ok) fail(`P: electron-style ensure failed ${JSON.stringify(ensureEnv)}`);
  if (ensureEnv.data?.runtimeMode !== "worker") {
    fail(`P: expected worker runtimeMode ${JSON.stringify(ensureEnv.data)}`);
  }
  const health = await fetch(ensureEnv.data.url);
  if (!health.ok) fail("P: electron-style health HTTP not ok");
  if (!existsSync(join(electronRepo, ".praxis-quality", "quality.sqlite"))) fail("P: sqlite missing");
  const againRaw = await electronSession.client.callTool({
    name: "praxis_quality_ensure",
    arguments: { repo: electronRepo },
  });
  const againEnv = envelopeFromTool(againRaw);
  if (againEnv?.data?.reused !== true) fail("P: electron-style second ensure did not reuse");
  cases.P = true;
} finally {
  await electronSession.close();
  stopQuality(electronRepo);
  rmSync(electronRepo, { recursive: true, force: true });
  rmSync(helperDir, { recursive: true, force: true });
}

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
      fail(`G: expected not_started, got ${JSON.stringify(statusEnv)}`);
    }
    const doctorRaw = await session1.client.callTool({
      name: "praxis_doctor",
      arguments: { repo: consumer },
    });
    const doctorEnv = envelopeFromTool(doctorRaw);
    if (doctorEnv?.data?.quality?.healthy === true) fail("G: doctor healthy before ensure");
    if (doctorEnv?.data?.capabilities?.praxisRuntime !== "ok") fail("G: doctor runtime not ok");

    const ensureRaw = await session1.client.callTool({
      name: "praxis_quality_ensure",
      arguments: { repo: consumer },
    });
    const ensureEnv = envelopeFromTool(ensureRaw);
    if (!ensureEnv?.ok) fail(`G: MCP ensure failed ${JSON.stringify(ensureEnv)}`);
    if (!["started", "healthy"].includes(ensureEnv.data?.status)) {
      fail(`G: ensure status ${JSON.stringify(ensureEnv.data)}`);
    }
    if (ensureEnv.data?.reused === true) fail("G: first ensure reused an existing service");
    startedPid = ensureEnv.data?.pid;
    track(startedPid);
    const health = await fetch(ensureEnv.data.url);
    if (!health.ok) fail("I: health HTTP not ok");
    const body = await health.json();
    if (body.service !== "quality-service") fail("I: health service field");
    if (!["node-sqlite", "sqljs"].includes(body.sqliteEngine)) {
      fail(`I: unexpected sqliteEngine ${body.sqliteEngine}`);
    }
    if (!existsSync(join(consumer, ".praxis-quality", "quality.sqlite"))) fail("H: sqlite missing");
    if (!existsSync(join(consumer, ".praxis-quality", "quality.json"))) fail("H: quality.json missing");
    cases.G = true;
    cases.H = true;
    cases.I = true;

    const againRaw = await session1.client.callTool({
      name: "praxis_quality_ensure",
      arguments: { repo: consumer },
    });
    const againEnv = envelopeFromTool(againRaw);
    if (againEnv?.data?.reused !== true) fail("J: second ensure did not reuse");
    if (againEnv.data?.pid !== startedPid) fail("J: second ensure spawned a new pid");
    cases.J = true;
  } finally {
    await session1.close();
  }

  if (!isAlive(startedPid)) fail("K: service died after ensure MCP request completed");

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
      fail(`I: second MCP session status ${JSON.stringify(statusEnv)}`);
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
    if (JSON.stringify(doctorEnv).toLowerCase().includes("praxis_quality_review")) {
      /* doctor must not imply review ran */
    }
  } finally {
    await session2.close();
  }
  if (!isAlive(startedPid)) fail("K: service died after MCP sessions closed");

  const jiraFilesBefore = JSON.stringify(discovered);
  const jiraFilesAfter = JSON.stringify(discoverQualityInputs(consumer, "WP-20260914-002"));
  if (jiraFilesBefore !== jiraFilesAfter) fail("L: ensure mutated quality handoff inputs");
  cases.L = true;
  cases.M = true;

  const missingRepo = consumerRepo("praxis-q-missing-");
  const missingPort = await freePort();
  process.env.PRAXIS_QUALITY_ENTRY = join(missingRepo, "missing-quality.cjs");
  process.env.PRAXIS_QUALITY_PORT = String(missingPort);
  try {
    await qualityEnsureOp({ repo: missingRepo });
    fail("N: missing executable did not fail");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_PACKAGE_MISSING) {
      fail(`N: expected QUALITY_PACKAGE_MISSING got ${err instanceof Error ? err.message : err}`);
    }
    if (String(err.message).includes("requires Node.js 22+")) fail("N: misleading Node 22+ message");
  } finally {
    delete process.env.PRAXIS_QUALITY_ENTRY;
    process.env.PRAXIS_QUALITY_PORT = String(port);
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
    fail("N: crash did not fail");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_PROCESS_EXITED) {
      fail(`N: expected QUALITY_PROCESS_EXITED got ${err instanceof PraxisOpError ? err.code : err}`);
    }
    if (err.details?.exitCode !== 1) fail("N: crash missing exitCode");
    if (!err.details?.nodeExecutable) fail("N: crash missing nodeExecutable");
    if (!err.stage) fail("N: crash missing stage");
    if (typeof err.durationMs !== "number") fail("N: crash missing durationMs");
    if (String(err.message).includes("requires Node.js 22+")) fail("N: crash used Node 22+ message");
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
    fail("N: occupied port did not fail");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_PORT_UNAVAILABLE) {
      fail(`N: expected QUALITY_PORT_UNAVAILABLE got ${err instanceof PraxisOpError ? err.code : err}`);
    }
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
    fail("N: hang did not time out");
  } catch (err) {
    if (!(err instanceof PraxisOpError) || err.code !== QUALITY_CODES.QUALITY_HEALTH_TIMEOUT) {
      fail(`N: expected QUALITY_HEALTH_TIMEOUT got ${err instanceof PraxisOpError ? err.code : err}`);
    }
    if (Date.now() - t0 > 5000) fail("N: timeout exceeded 5s");
    cases.N = true;
  } finally {
    stopQuality(hangRepo);
    delete process.env.PRAXIS_QUALITY_ENTRY;
    delete process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS;
    process.env.PRAXIS_QUALITY_PORT = String(port);
    rmSync(hangRepo, { recursive: true, force: true });
  }

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
  if (stillServing) fail("K: Quality health still reachable after cleanup");
  cases.K = true;
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
  rmSync(fakeDir, { recursive: true, force: true });
  delete process.env.PRAXIS_QUALITY_PORT;
  delete process.env.PRAXIS_QUALITY_ENTRY;
  delete process.env.PRAXIS_QUALITY_STARTUP_TIMEOUT_MS;
  delete process.env.PRAXIS_QUALITY_SQLITE;
  delete process.env.PRAXIS_QUALITY_NODE;
  delete process.env.PRAXIS_QUALITY_SIMULATED_EXEC_PATH;
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
      macosHost: process.platform === "darwin",
      macosArch: process.arch,
      macosAcceptance: process.platform === "darwin" ? "PASS" : "HOST_SKIP_NOT_DARWIN",
      macosDesktop: "LIVE DESKTOP PENDING",
      electronStyleAcceptance: "PASS",
      bundledQuality: "server/praxis-quality.cjs",
      bundledWasm: "server/sql-wasm.wasm",
      parentNode: parentProbe.execPath,
      parentNodeVersion: parentProbe.version,
      childNode: runtime.execPath,
      childNodeVersion: runtime.child.version || runtime.parent.version,
    },
    null,
    2,
  ),
);
