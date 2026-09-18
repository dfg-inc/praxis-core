#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ensurePackedExtension, extractMcpbRuntime } from "./mcpb-runtime.mjs";
import { extractZip } from "./claude-zip.mjs";
import { parsePluginMcpConfig, resolvePluginPath } from "./hosted-plugin-policy.mjs";
import { mcpInitializeAndList, spawnMcpServer } from "./mcp-stdio-client.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  listAndDoctor,
  MCP_STARTUP_BUDGET_MS,
  mcpSdkReport,
  versionNegotiationAuto,
  versionNegotiationLegacy,
  versionNegotiationModern,
} from "./official-mcp-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const ALPHA29 = "v0.1.0-alpha.29";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnCaptured(command, args, { cwd, env, timeoutMs = 2000 }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout = Buffer.concat([stdout, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise({ code: null, stdout, stderr, timedOut: true, child });
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut: false, child });
    });
  });
}

function parsedMcp(dest) {
  const mcp = parsePluginMcpConfig(JSON.parse(readFileSync(join(dest, ".mcp.json"), "utf8")));
  if (!mcp) fail(`invalid .mcp.json in ${dest}`);
  const args = mcp.args.map((a) => resolvePluginPath(a, dest));
  const runtime = args.find((a) => String(a).endsWith("praxis-mcp.cjs"));
  return { mcp, args, runtime };
}

const { mcpbPath } = await ensurePackedExtension(root, version);
const sdk = mcpSdkReport();
const outside = mkdtempSync(join(tmpdir(), "praxis-desktop-mcp-"));
const proven = [
  "final extracted MCPB runtime",
  "process spawn",
  "modern protocol negotiation",
  "legacy initialize compatibility",
  "connect under startup budget",
  "tools/list",
  "praxis_doctor",
  "shared runtime catalog",
  "clean shutdown",
  "stdout protocol-only",
  "stderr diagnostics only",
  "no monorepo dependency",
  "concurrent shared-runtime startup",
  "alpha.29 official-client regression",
  "expected Desktop process count is one shared Runtime MCP",
];
const startupMs = {};
const negotiated = { modern: {}, legacy: {} };

let alpha29 = { attempted: false };

try {
  const dest = join(outside, "praxis-runtime");
  mkdirSync(dest, { recursive: true });
  const extracted = extractMcpbRuntime(mcpbPath, dest);
  if (!extracted.runtime || !existsSync(extracted.runtime)) {
    fail(`missing resolved runtime ${extracted.runtime}`);
  }
  const st = lstatSync(extracted.runtime);
  if (!st.isFile() || st.isSymbolicLink()) fail("runtime is not a regular file");
  const bundled = readFileSync(extracted.runtime, "utf8");
  if (bundled.includes("/Users/serg/work/praxis/node_modules")) {
    fail("bundle embeds monorepo node_modules path");
  }

  const idleEnv = hostedCleanEnv(extracted.dest);
  const idle = spawn(process.execPath, extracted.args, {
    cwd: extracted.dest,
    env: idleEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let idleStdout = Buffer.alloc(0);
  let idleStderr = "";
  idle.stdout.on("data", (d) => {
    idleStdout = Buffer.concat([idleStdout, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
  });
  idle.stderr.on("data", (d) => {
    idleStderr += d.toString();
  });
  await wait(400);
  if (idleStdout.length > 0) {
    idle.kill("SIGTERM");
    fail(`stdout was not empty before protocol: ${idleStdout.toString("utf8").slice(0, 200)}`);
  }
  if (!idleStderr.includes("[praxis-mcp] ready")) {
    idle.kill("SIGTERM");
    fail(`idle stderr missing ready:\n${idleStderr}`);
  }
  if (!idleStderr.includes(`version=${version}`)) {
    idle.kill("SIGTERM");
    fail(`idle stderr missing version:\n${idleStderr}`);
  }
  if (!idleStderr.includes("role=runtime")) {
    idle.kill("SIGTERM");
    fail(`idle stderr missing role=runtime:\n${idleStderr}`);
  }
  idle.kill("SIGTERM");
  await wait(200);

  const invalid = await spawnCaptured(process.execPath, [extracted.runtime, "--role", "nope"], {
    cwd: extracted.dest,
    env: idleEnv,
    timeoutMs: 2000,
  });
  if (invalid.timedOut) fail("invalid role hung instead of exiting");
  if (invalid.code === 0) fail("invalid role exited 0");
  if (!invalid.stderr.includes("PRAXIS_MCP_ROLE_INVALID")) {
    fail(`invalid role stderr missing PRAXIS_MCP_ROLE_INVALID:\n${invalid.stderr}`);
  }
  if (invalid.stdout.length > 0) {
    fail(`invalid role wrote stdout: ${invalid.stdout.toString("utf8")}`);
  }

  const git29 = spawnSync("git", ["show", `${ALPHA29}:claude-plugins/praxis-architect.zip`], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 12 * 1024 * 1024,
  });
  if ((git29.status ?? 1) === 0 && git29.stdout && git29.stdout.length > 100) {
    alpha29.attempted = true;
    const dest29 = join(outside, "alpha29-architect");
    mkdirSync(dest29, { recursive: true });
    extractZip(git29.stdout, dest29);
    const extracted29 = parsedMcp(dest29);
    const args29 = extracted29.args;
    const custom = spawnMcpServer({
      command: process.execPath,
      args: args29,
      cwd: dest29,
      env: hostedCleanEnv(dest29),
      timeoutMs: 4000,
    });
    try {
      const { initialize, tools } = await mcpInitializeAndList(custom, "0.1.0-alpha.29");
      if (!initialize?.protocolVersion || !tools.length) {
        fail("alpha.29 custom initialize harness unexpectedly failed");
      }
      alpha29.customInitialize = "PASS";
    } finally {
      await custom.close();
    }
    let modernFailed = false;
    try {
      const session = await connectOfficialMcp({
        command: process.execPath,
        args: args29,
        cwd: dest29,
        env: hostedCleanEnv(dest29),
        versionNegotiation: versionNegotiationModern(),
        timeoutMs: 2500,
        clientVersion: "0.1.0-alpha.29",
      });
      await session.close();
    } catch (err) {
      modernFailed = true;
      alpha29.officialModern = "FAIL";
      alpha29.officialModernError = err instanceof Error ? err.message.slice(0, 500) : String(err);
    }
    if (!modernFailed) {
      fail("alpha.29 official modern pin unexpectedly succeeded — regression proof is missing");
    }
  } else {
    alpha29.attempted = false;
    alpha29.reason = "alpha.29 zip not available from git";
  }

  const concurrentStarted = Date.now();
  const concurrent = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const session = await connectOfficialMcp({
        command: process.execPath,
        args: extracted.args,
        cwd: extracted.dest,
        env: hostedCleanEnv(extracted.dest),
        versionNegotiation: versionNegotiationAuto(),
        timeoutMs: MCP_STARTUP_BUDGET_MS,
        clientVersion: version,
      });
      return { i, session };
    }),
  );
  const concurrentMs = Date.now() - concurrentStarted;
  try {
    for (const { i, session } of concurrent) {
      if (session.startupMs > MCP_STARTUP_BUDGET_MS) {
        fail(`runtime[${i}] concurrent startup ${session.startupMs}ms exceeds budget`);
      }
      if (session.era !== "modern") fail(`runtime[${i}] concurrent era ${session.era}`);
      const { tools, envelope } = await listAndDoctor(session, extracted.dest);
      if (!tools.some((t) => t.name === "praxis_doctor")) fail(`runtime[${i}] concurrent missing doctor`);
      if (!tools.some((t) => t.name === "praxis_architect_preview")) {
        fail(`runtime[${i}] concurrent missing architect preview`);
      }
      if (!envelope?.ok) fail(`runtime[${i}] concurrent doctor failed`);
      if (
        JSON.stringify({ tools, envelope, stderr: session.stderr() }).includes(
          "/Users/serg/work/praxis/node_modules",
        )
      ) {
        fail(`runtime[${i}] resolved Praxis monorepo node_modules`);
      }
      negotiated.modern[`runtime-${i}`] = session.protocolVersion;
      startupMs[`runtime-${i}`] = session.startupMs;
    }
  } finally {
    await Promise.all(concurrent.map(({ session }) => session.close()));
  }

  const legacy = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: hostedCleanEnv(extracted.dest),
    versionNegotiation: versionNegotiationLegacy(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    if (legacy.era !== "legacy") fail(`runtime legacy era ${legacy.era}`);
    const { envelope } = await listAndDoctor(legacy, extracted.dest);
    if (!envelope?.ok) fail("runtime legacy doctor failed");
    negotiated.legacy.runtime = legacy.protocolVersion;
  } finally {
    await legacy.close();
  }

  const nodeLabel = process.version;
  if (Number(nodeLabel.slice(1).split(".")[0]) < 20) {
    fail(`Node ${nodeLabel} below documented minimum >= 20`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        transport: "stdio",
        client: "official MCP SDK",
        sdk,
        node: { executable: process.execPath, version: nodeLabel, minimum: ">=20" },
        negotiated,
        startupMs,
        concurrentSharedRuntimeMs: concurrentMs,
        expectedDesktopMcpProcesses: 1,
        alpha29,
        proven,
        pending: ["manual Claude Desktop MCP connection"],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(outside, { recursive: true, force: true });
}
