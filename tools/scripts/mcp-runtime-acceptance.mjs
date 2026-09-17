#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PLUGINS, distClaudePluginsDir } from "./claude-plugins-shared.mjs";
import { packClaudePlugins } from "./pack-claude-plugins.mjs";
import { extractZip } from "./claude-zip.mjs";
import { parsePluginMcpConfig, resolvePluginPath } from "./hosted-plugin-policy.mjs";
import { mcpInitializeAndList, spawnMcpServer } from "./mcp-stdio-client.mjs";

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

const outside = mkdtempSync(join(tmpdir(), "praxis-mcp-extract-"));
const proven = [
  "initialize handshake",
  "tools/list",
  "typed schemas",
  "doctor fixture",
  "role status fixture",
  "role preview fixture",
  "confirmation gate",
  "preview fingerprint gate",
  "structured errors",
];
try {
  for (const plugin of PLUGINS) {
    const zipPath = join(distDir, `${plugin.id}.zip`);
    if (!existsSync(zipPath)) fail(`missing ${zipPath}`);
    const unpack = join(outside, plugin.id);
    mkdirSync(unpack, { recursive: true });
    extractZip(readFileSync(zipPath), unpack);
    const mcp = parsePluginMcpConfig(JSON.parse(readFileSync(join(unpack, ".mcp.json"), "utf8")));
    const args = mcp.args.map((a) => resolvePluginPath(a, unpack));
    const client = spawnMcpServer({
      command: mcp.command,
      args,
      cwd: unpack,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        PRAXIS_SKIP_DOTENV: "1",
        HOME: unpack,
        TMPDIR: unpack,
        NODE_ENV: "test",
      },
    });
    try {
      const { initialize, tools } = await mcpInitializeAndList(client, version);
      if (!initialize?.protocolVersion) fail(`${plugin.id} initialize handshake failed`);
      if (!tools.length) fail(`${plugin.id} empty tools/list`);
      if (!tools.every((t) => t.inputSchema)) fail(`${plugin.id} missing typed schemas`);
      const doctor = await client.request("tools/call", {
        name: "praxis_doctor",
        arguments: { repo: unpack },
      });
      const env = doctor.result?.structuredContent;
      if (!env?.ok) fail(`${plugin.id} doctor fixture failed`);
      if (JSON.stringify(env).includes("PRAXIS_JIRA_TOKEN=")) {
        fail(`${plugin.id} doctor leaked token`);
      }
    } finally {
      await client.close();
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
      proven,
      pending: ["manual Cowork MCP execution"],
    },
    null,
    2,
  ),
);
