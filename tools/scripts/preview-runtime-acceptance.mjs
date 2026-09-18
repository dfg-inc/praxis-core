#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ensurePackedExtension, extractMcpbRuntime } from "./mcpb-runtime.mjs";
import { packClaudeExtension } from "./pack-claude-extension.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  parseDoctorEnvelope,
  MCP_STARTUP_BUDGET_MS,
  mcpSdkReport,
  versionNegotiationModern,
} from "./official-mcp-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const HOST_LIKE_TIMEOUT_MS = 15_000;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

const built = spawnSync(
  "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli -w @praxis/mcp",
  { cwd: root, shell: true, encoding: "utf8" },
);
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);
await packClaudeExtension(version);

const {
  createCanonicalMock,
  seedCanonicalJira,
  startMockJiraHttp,
  writeCanonicalRepo,
} = await import("./preview-fixture.mjs");

const { fetchImpl } = createCanonicalMock();
const seeded = await seedCanonicalJira(fetchImpl);
const httpd = await startMockJiraHttp(fetchImpl);
const repo = mkdtempSync(join(tmpdir(), "praxis-accept-preview-runtime-"));
writeCanonicalRepo(repo);

const { mcpbPath } = await ensurePackedExtension(root, version);
const outside = mkdtempSync(join(tmpdir(), "praxis-preview-mcpb-"));
const unpack = join(outside, "praxis-runtime");
mkdirSync(unpack, { recursive: true });
const extracted = extractMcpbRuntime(mcpbPath, unpack);
if (!existsSync(extracted.runtime)) fail(`runtime missing ${extracted.runtime}`);

const env = {
  ...hostedCleanEnv(extracted.dest),
  PRAXIS_JIRA_MODE: "cloud",
  PRAXIS_JIRA_BASE_URL: httpd.baseUrl,
  PRAXIS_JIRA_EMAIL: "test@example.com",
  PRAXIS_JIRA_PROJECT_KEY: "PRX",
  PRAXIS_JIRA_TOKEN: "tok",
  PRAXIS_SKIP_DOTENV: "1",
};

let session;
const report = {
  ok: false,
  version,
  sdk: mcpSdkReport(),
  extractedRuntime: extracted.runtime,
  mockJira: httpd.baseUrl,
  ba: {},
  architect: {},
  cancellation: {},
};
try {
  session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env,
    clientVersion: version,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
  });

  const baStarted = Date.now();
  const baRaw = await Promise.race([
    session.client.callTool({
      name: "praxis_ba_preview",
      arguments: { epic: seeded.epicKey, repo },
    }),
    timeout(HOST_LIKE_TIMEOUT_MS, "praxis_ba_preview"),
  ]);
  const baEnvelope = parseDoctorEnvelope(baRaw);
  const baMs = Date.now() - baStarted;
  if (!baEnvelope?.ok) fail(`praxis_ba_preview failed: ${JSON.stringify(baEnvelope)}`);
  if (baMs > HOST_LIKE_TIMEOUT_MS) fail(`praxis_ba_preview ${baMs}ms`);
  report.ba = {
    ok: true,
    durationMs: baEnvelope.data?.durationMs ?? baMs,
    stages: baEnvelope.data?.stages,
    canonicalStories: baEnvelope.data?.handoff?.canonicalStoryKeys,
    readyForArchitecture: baEnvelope.data?.handoff?.readyForArchitecture,
  };

  const archStarted = Date.now();
  const archRaw = await Promise.race([
    session.client.callTool({
      name: "praxis_architect_preview",
      arguments: { epic: seeded.epicKey, repo, workPackageId: "WP-20260914-002" },
    }),
    timeout(HOST_LIKE_TIMEOUT_MS, "praxis_architect_preview"),
  ]);
  const archEnvelope = parseDoctorEnvelope(archRaw);
  const archMs = Date.now() - archStarted;
  if (!archEnvelope?.ok) fail(`praxis_architect_preview failed: ${JSON.stringify(archEnvelope)}`);
  if (archMs > HOST_LIKE_TIMEOUT_MS) fail(`praxis_architect_preview ${archMs}ms`);
  const plan = archEnvelope.data?.plan ?? [];
  report.architect = {
    ok: true,
    durationMs: archEnvelope.data?.durationMs ?? archMs,
    stages: archEnvelope.data?.stages,
    create: plan.filter((p) => p.action === "CREATE" && p.kind === "work-package").length,
    link: plan.filter((p) => p.action === "LINK").length,
    previewFingerprint: archEnvelope.data?.previewFingerprint,
  };

  await session.close();
  session = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env,
    clientVersion: version,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
  });
  const doctor = await session.client.callTool({
    name: "praxis_doctor",
    arguments: { repo },
  });
  const doctorEnv = parseDoctorEnvelope(doctor);
  if (!doctorEnv?.ok) fail("next tool call after preview restart failed");
  report.cancellation = {
    nextToolCall: "praxis_doctor",
    ok: true,
    hostWarning: "HOST_WARNING_NON_BLOCKING",
    roots: "not advertised by Praxis Runtime",
  };
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  try {
    await session?.close();
  } catch {
    /* ignore */
  }
  await httpd.close();
}
