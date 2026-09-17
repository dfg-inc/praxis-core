#!/usr/bin/env node
/**
 * Official MCP TypeScript SDK v2 client helper.
 * Tests must spawn extracted ZIP runtime, never a custom JSON-RPC harness.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const MCP_STARTUP_BUDGET_MS = 3000;
export const MODERN_PROTOCOL = "2026-07-28";
export const LEGACY_PROTOCOL = "2025-11-25";

function dependencyVersion(spec) {
  const resolved = require.resolve(spec);
  let dir = dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) return JSON.parse(readFileSync(pkg, "utf8")).version;
    dir = dirname(dir);
  }
  return "unknown";
}

export function mcpSdkReport() {
  return {
    server: dependencyVersion("@modelcontextprotocol/server"),
    client: dependencyVersion("@modelcontextprotocol/client"),
    packages: {
      server: "@modelcontextprotocol/server",
      client: "@modelcontextprotocol/client",
    },
    stdioApi: "serveStdio",
    modernRevision: MODERN_PROTOCOL,
    legacyRevisions: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"],
    clientDefaultNegotiation: "legacy",
  };
}

export function hostedCleanEnv(home) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    PRAXIS_SKIP_DOTENV: "1",
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    NODE_ENV: "test",
  };
}

export function versionNegotiationModern() {
  return { mode: { pin: MODERN_PROTOCOL } };
}

export function versionNegotiationAuto() {
  return { mode: "auto" };
}

export function versionNegotiationLegacy() {
  return { mode: "legacy" };
}

function timeout(ms, label, stderr) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms\nstderr: ${stderr()}`));
    }, ms);
  });
}

export async function connectOfficialMcp({
  command,
  args,
  cwd,
  env,
  versionNegotiation,
  timeoutMs = MCP_STARTUP_BUDGET_MS,
  clientName = "praxis-acceptance",
  clientVersion = "0.0.0",
}) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: clientName, version: clientVersion },
    { versionNegotiation },
  );
  const started = Date.now();
  const stderrOf = () => stderr;
  try {
    await Promise.race([
      client.connect(transport, { timeout: timeoutMs }),
      timeout(timeoutMs + 500, "official MCP connect", stderrOf),
    ]);
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    const error = err instanceof Error ? err : new Error(String(err));
    error.message = `${error.message}\nstderr: ${stderr}`;
    error.stderr = stderr;
    error.startupMs = Date.now() - started;
    throw error;
  }
  const session = {
    client,
    transport,
    stderr: stderrOf,
    startupMs: Date.now() - started,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    era: client.getProtocolEra(),
    async close() {
      await client.close();
    },
  };
  return session;
}

export function parseDoctorEnvelope(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (typeof text === "string" && text.trim().startsWith("{")) {
    return JSON.parse(text);
  }
  return null;
}

export async function listAndDoctor(session, repo) {
  const listed = await session.client.listTools();
  const tools = listed.tools ?? [];
  const doctor = await session.client.callTool({
    name: "praxis_doctor",
    arguments: { repo },
  });
  return {
    tools,
    doctor,
    envelope: parseDoctorEnvelope(doctor),
  };
}
