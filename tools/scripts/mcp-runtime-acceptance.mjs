#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PLUGINS, distClaudePluginsDir } from "./claude-plugins-shared.mjs";
import { packClaudePlugins } from "./pack-claude-plugins.mjs";
import { extractZip } from "./claude-zip.mjs";
import { parsePluginMcpConfig, resolvePluginPath } from "./hosted-plugin-policy.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  listAndDoctor,
  MCP_STARTUP_BUDGET_MS,
  mcpSdkReport,
  MODERN_PROTOCOL,
  versionNegotiationLegacy,
  versionNegotiationModern,
} from "./official-mcp-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const tests = spawnSync("npm test -w @praxis/mcp", {
  cwd: root,
  shell: true,
  encoding: "utf8",
  env: { ...process.env, PRAXIS_SKIP_DOTENV: "1" },
});
if ((tests.status ?? 1) !== 0) {
  fail(`@praxis/mcp tests failed\n${tests.stdout}\n${tests.stderr}`);
}

const distDir = distClaudePluginsDir(root, version);
if (!existsSync(join(distDir, "praxis-architect.zip"))) {
  await packClaudePlugins(version);
}

const expectedByRole = {
  ba: "praxis_ba_preview",
  architect: "praxis_architect_preview",
  developer: "praxis_developer_claim",
  quality: "praxis_quality_review",
};

const outside = mkdtempSync(join(tmpdir(), "praxis-mcp-extract-"));
const sdk = mcpSdkReport();
const proven = [
  "official MCP SDK client",
  "StdioClientTransport",
  "final extracted ZIP runtime",
  "modern protocol negotiation",
  "legacy initialize compatibility",
  "tools/list",
  "typed schemas",
  "praxis_doctor",
  "stdout protocol-only",
];
const negotiated = { modern: {}, legacy: {} };
const startupMs = {};

try {
  for (const plugin of PLUGINS) {
    const zipPath = join(distDir, `${plugin.id}.zip`);
    if (!existsSync(zipPath)) fail(`missing ${zipPath}`);
    const unpack = join(outside, plugin.id);
    mkdirSync(unpack, { recursive: true });
    extractZip(readFileSync(zipPath), unpack);
    const mcp = parsePluginMcpConfig(JSON.parse(readFileSync(join(unpack, ".mcp.json"), "utf8")));
    const args = mcp.args.map((a) => resolvePluginPath(a, unpack));
    const runtime = args.find((a) => a.endsWith("praxis-mcp.cjs"));
    if (!runtime || !existsSync(runtime) || !lstatSync(runtime).isFile()) {
      fail(`${plugin.id} runtime path did not resolve to a regular file: ${runtime}`);
    }
    const spawnSpec = {
      command: process.execPath,
      args,
      cwd: unpack,
      env: hostedCleanEnv(unpack),
      clientVersion: version,
    };

    const modern = await connectOfficialMcp({
      ...spawnSpec,
      versionNegotiation: versionNegotiationModern(),
      timeoutMs: MCP_STARTUP_BUDGET_MS,
    });
    try {
      if (modern.startupMs > MCP_STARTUP_BUDGET_MS) {
        fail(`${plugin.id} modern connect ${modern.startupMs}ms exceeds ${MCP_STARTUP_BUDGET_MS}ms`);
      }
      if (modern.era !== "modern" || modern.protocolVersion !== MODERN_PROTOCOL) {
        fail(
          `${plugin.id} modern negotiation failed era=${modern.era} protocol=${modern.protocolVersion}`,
        );
      }
      const { tools, envelope } = await listAndDoctor(modern, unpack);
      if (!tools.length) fail(`${plugin.id} empty tools/list`);
      if (!tools.every((t) => t.inputSchema)) fail(`${plugin.id} missing typed schemas`);
      if (!tools.some((t) => t.name === "praxis_doctor")) {
        fail(`${plugin.id} missing praxis_doctor`);
      }
      if (!tools.some((t) => t.name === expectedByRole[plugin.role])) {
        fail(`${plugin.id} missing ${expectedByRole[plugin.role]}`);
      }
      if (!envelope?.ok) fail(`${plugin.id} doctor fixture failed`);
      if (JSON.stringify(envelope).includes("PRAXIS_JIRA_TOKEN=")) {
        fail(`${plugin.id} doctor leaked token`);
      }
      const stderr = modern.stderr();
      if (!stderr.includes("[praxis-mcp] ready")) fail(`${plugin.id} missing stderr ready`);
      if (stderr.includes("PRAXIS_JIRA_TOKEN=")) fail(`${plugin.id} stderr leaked token`);
      negotiated.modern[plugin.role] = modern.protocolVersion;
      startupMs[plugin.role] = modern.startupMs;
    } finally {
      await modern.close();
    }

    const legacy = await connectOfficialMcp({
      ...spawnSpec,
      versionNegotiation: versionNegotiationLegacy(),
      timeoutMs: MCP_STARTUP_BUDGET_MS,
    });
    try {
      if (legacy.era !== "legacy" || !legacy.protocolVersion) {
        fail(`${plugin.id} legacy initialize failed era=${legacy.era} protocol=${legacy.protocolVersion}`);
      }
      const { tools, envelope } = await listAndDoctor(legacy, unpack);
      if (!tools.some((t) => t.name === "praxis_doctor")) {
        fail(`${plugin.id} legacy tools/list missing praxis_doctor`);
      }
      if (!envelope?.ok) fail(`${plugin.id} legacy doctor failed`);
      negotiated.legacy[plugin.role] = legacy.protocolVersion;
    } finally {
      await legacy.close();
    }
  }
} finally {
  rmSync(outside, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      protocol: "mcp",
      transport: "stdio",
      client: "official MCP SDK",
      sdk,
      negotiated,
      startupMs,
      proven,
      pending: ["manual Claude Desktop MCP connection"],
    },
    null,
    2,
  ),
);
