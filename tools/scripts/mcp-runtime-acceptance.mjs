#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ensurePackedExtension, extractMcpbRuntime } from "./mcpb-runtime.mjs";
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

const { mcpbPath } = await ensurePackedExtension(root, version);
const expectedTools = [
  "praxis_doctor",
  "praxis_ba_preview",
  "praxis_architect_preview",
  "praxis_developer_claim",
  "praxis_quality_review",
];

const outside = mkdtempSync(join(tmpdir(), "praxis-mcp-extract-"));
const sdk = mcpSdkReport();
const proven = [
  "official MCP SDK client",
  "StdioClientTransport",
  "final extracted MCPB runtime",
  "modern protocol negotiation",
  "legacy initialize compatibility",
  "tools/list",
  "typed schemas",
  "praxis_doctor",
  "shared runtime role catalog",
  "stdout protocol-only",
];
const negotiated = { modern: {}, legacy: {} };
const startupMs = {};

try {
  const unpack = join(outside, "praxis-runtime");
  mkdirSync(unpack, { recursive: true });
  const extracted = extractMcpbRuntime(mcpbPath, unpack);
  if (!existsSync(extracted.runtime)) fail(`runtime missing ${extracted.runtime}`);
  const spawnSpec = {
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: hostedCleanEnv(extracted.dest),
    clientVersion: version,
  };

  const modern = await connectOfficialMcp({
    ...spawnSpec,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
  });
  try {
    if (modern.startupMs > MCP_STARTUP_BUDGET_MS) {
      fail(`runtime modern connect ${modern.startupMs}ms exceeds ${MCP_STARTUP_BUDGET_MS}ms`);
    }
    if (modern.era !== "modern" || modern.protocolVersion !== MODERN_PROTOCOL) {
      fail(`runtime modern negotiation failed era=${modern.era} protocol=${modern.protocolVersion}`);
    }
    const { tools, envelope } = await listAndDoctor(modern, unpack);
    if (!tools.length) fail("runtime empty tools/list");
    if (!tools.every((t) => t.inputSchema)) fail("runtime missing typed schemas");
    for (const name of expectedTools) {
      if (!tools.some((t) => t.name === name)) fail(`runtime missing ${name}`);
    }
    if (!envelope?.ok) fail("runtime doctor fixture failed");
    if (JSON.stringify(envelope).includes("PRAXIS_JIRA_TOKEN=")) {
      fail("runtime doctor leaked token");
    }
    const stderr = modern.stderr();
    if (!stderr.includes("[praxis-mcp] ready")) fail("runtime missing stderr ready");
    if (!stderr.includes("role=runtime")) fail("runtime missing role=runtime");
    if (stderr.includes("PRAXIS_JIRA_TOKEN=")) fail("runtime stderr leaked token");
    negotiated.modern.runtime = modern.protocolVersion;
    startupMs.runtime = modern.startupMs;
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
      fail(`runtime legacy initialize failed era=${legacy.era} protocol=${legacy.protocolVersion}`);
    }
    const { tools, envelope } = await listAndDoctor(legacy, unpack);
    if (!tools.some((t) => t.name === "praxis_doctor")) {
      fail("runtime legacy tools/list missing praxis_doctor");
    }
    if (!envelope?.ok) fail("runtime legacy doctor failed");
    negotiated.legacy.runtime = legacy.protocolVersion;
  } finally {
    await legacy.close();
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
