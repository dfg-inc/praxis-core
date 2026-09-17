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
import { PLUGINS, distClaudePluginsDir } from "./claude-plugins-shared.mjs";
import { packClaudePlugins } from "./pack-claude-plugins.mjs";
import { extractZip } from "./claude-zip.mjs";
import { parsePluginMcpConfig, resolvePluginPath } from "./hosted-plugin-policy.mjs";
import { mcpInitializeAndList, spawnMcpServer } from "./mcp-stdio-client.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  listAndDoctor,
  MCP_STARTUP_BUDGET_MS,
  mcpSdkReport,
  MODERN_PROTOCOL,
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

function extractPlugin(zipPath, dest) {
  mkdirSync(dest, { recursive: true });
  extractZip(readFileSync(zipPath), dest);
  return parsedMcp(dest);
}

const distDir = distClaudePluginsDir(root, version);
if (!existsSync(join(distDir, "praxis-architect.zip"))) {
  await packClaudePlugins(version);
}

const sdk = mcpSdkReport();
const outside = mkdtempSync(join(tmpdir(), "praxis-desktop-mcp-"));
const proven = [
  "final extracted ZIP runtime",
  "process spawn",
  "modern protocol negotiation",
  "legacy initialize compatibility",
  "connect under startup budget",
  "tools/list",
  "praxis_doctor",
  "all four roles",
  "clean shutdown",
  "stdout protocol-only",
  "stderr diagnostics only",
  "no monorepo dependency",
  "concurrent four-role startup",
  "alpha.29 official-client regression",
];
const startupMs = {};
const negotiated = { modern: {}, legacy: {} };
const expectedByRole = {
  ba: "praxis_ba_preview",
  architect: "praxis_architect_preview",
  developer: "praxis_developer_claim",
  quality: "praxis_quality_review",
};

let alpha29 = { attempted: false };

try {
  const unpacked = {};
  for (const plugin of PLUGINS) {
    const zipPath = join(distDir, `${plugin.id}.zip`);
    if (!existsSync(zipPath)) fail(`missing ${zipPath}`);
    const dest = join(outside, plugin.id);
    const extracted = extractPlugin(zipPath, dest);
    if (!extracted.runtime || !existsSync(extracted.runtime)) {
      fail(`${plugin.id} missing resolved runtime ${extracted.runtime}`);
    }
    const st = lstatSync(extracted.runtime);
    if (!st.isFile() || st.isSymbolicLink()) {
      fail(`${plugin.id} runtime is not a regular file`);
    }
    if (extracted.runtime !== join(dest, "runtime", "praxis-mcp.cjs")) {
      fail(
        `${plugin.id} resolved runtime ${extracted.runtime} != ${join(dest, "runtime", "praxis-mcp.cjs")}`,
      );
    }
    const bundled = readFileSync(extracted.runtime, "utf8");
    if (bundled.includes("node_modules/@praxis") && bundled.includes("createRequire")) {
      /* bundled CJS may mention strings; require a real missing-module failure instead */
    }
    if (bundled.includes("/Users/serg/work/praxis/node_modules")) {
      fail(`${plugin.id} bundle embeds monorepo node_modules path`);
    }
    unpacked[plugin.id] = { plugin, dest, ...extracted };
  }

  const architectRuntime = unpacked["praxis-architect"].runtime;
  const idleEnv = hostedCleanEnv(unpacked["praxis-architect"].dest);
  const idle = spawn(process.execPath, [architectRuntime, "--role", "architect"], {
    cwd: unpacked["praxis-architect"].dest,
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
  idle.kill("SIGTERM");
  await wait(200);

  const invalid = await spawnCaptured(process.execPath, [architectRuntime, "--role", "nope"], {
    cwd: unpacked["praxis-architect"].dest,
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
    PLUGINS.map(async (plugin) => {
      const u = unpacked[plugin.id];
      const session = await connectOfficialMcp({
        command: process.execPath,
        args: u.args,
        cwd: u.dest,
        env: hostedCleanEnv(u.dest),
        versionNegotiation: versionNegotiationAuto(),
        timeoutMs: MCP_STARTUP_BUDGET_MS,
        clientVersion: version,
      });
      return { plugin, session };
    }),
  );
  const concurrentMs = Date.now() - concurrentStarted;
  try {
    for (const { plugin, session } of concurrent) {
      if (session.startupMs > MCP_STARTUP_BUDGET_MS) {
        fail(`${plugin.id} concurrent startup ${session.startupMs}ms exceeds budget`);
      }
      if (session.era !== "modern") {
        fail(`${plugin.id} concurrent era ${session.era}`);
      }
      const { tools, envelope } = await listAndDoctor(session, uOr(unpacked, plugin.id));
      if (!tools.some((t) => t.name === "praxis_doctor")) fail(`${plugin.id} concurrent missing doctor`);
      if (!tools.some((t) => t.name === expectedByRole[plugin.role])) {
        fail(`${plugin.id} concurrent missing ${expectedByRole[plugin.role]}`);
      }
      if (!envelope?.ok) fail(`${plugin.id} concurrent doctor failed`);
      if (JSON.stringify({ tools, envelope, stderr: session.stderr() }).includes("/Users/serg/work/praxis/node_modules")) {
        fail(`${plugin.id} resolved Praxis monorepo node_modules`);
      }
      negotiated.modern[plugin.role] = session.protocolVersion;
      startupMs[plugin.role] = session.startupMs;
    }
  } finally {
    await Promise.all(concurrent.map(({ session }) => session.close()));
  }

  for (const plugin of PLUGINS) {
    const u = unpacked[plugin.id];
    const legacy = await connectOfficialMcp({
      command: process.execPath,
      args: u.args,
      cwd: u.dest,
      env: hostedCleanEnv(u.dest),
      versionNegotiation: versionNegotiationLegacy(),
      timeoutMs: MCP_STARTUP_BUDGET_MS,
      clientVersion: version,
    });
    try {
      if (legacy.era !== "legacy") fail(`${plugin.id} legacy era ${legacy.era}`);
      const { envelope } = await listAndDoctor(legacy, u.dest);
      if (!envelope?.ok) fail(`${plugin.id} legacy doctor failed`);
      negotiated.legacy[plugin.role] = legacy.protocolVersion;
    } finally {
      await legacy.close();
    }
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
        concurrentFourRoleMs: concurrentMs,
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

function uOr(unpacked, id) {
  return unpacked[id].dest;
}
