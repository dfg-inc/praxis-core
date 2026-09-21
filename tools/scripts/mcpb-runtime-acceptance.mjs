#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  EXTENSION_FILE,
  JIRA_ENV_MAP,
  JIRA_USER_CONFIG,
  MCPB_MANIFEST_VERSION,
  mcpbCliPath,
} from "./claude-extensions-shared.mjs";
import {
  SECRET_FIXTURE_VALUE,
  ensurePackedExtension,
  extractMcpbRuntime,
  fixtureJiraEnv,
} from "./mcpb-runtime.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  listAndDoctor,
  MCP_STARTUP_BUDGET_MS,
  mcpSdkReport,
  MODERN_PROTOCOL,
  versionNegotiationModern,
} from "./official-mcp-client.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function mcpbBin() {
  return mcpbCliPath(require);
}

function assertNoSecret(label, text) {
  if (String(text).includes(SECRET_FIXTURE_VALUE)) {
    fail(`${label} leaked ${SECRET_FIXTURE_VALUE}`);
  }
}

function doctorData(envelope) {
  return envelope?.data ?? {};
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
const outside = mkdtempSync(join(tmpdir(), "praxis-mcpb-accept-"));
const sdk = mcpSdkReport();
const proven = [];

try {
  const extracted = extractMcpbRuntime(mcpbPath, join(outside, "unpack"));
  if (!extracted.quality || !existsSync(extracted.quality)) {
    fail("MCPB missing bundled Quality service server/praxis-quality.cjs");
  }
  const manifest = extracted.manifest;
  if (manifest.manifest_version !== MCPB_MANIFEST_VERSION) {
    fail(`manifest_version ${manifest.manifest_version} != ${MCPB_MANIFEST_VERSION}`);
  }
  if (manifest.name !== "praxis-runtime") fail(`name ${manifest.name}`);
  if (manifest.display_name !== "Praxis Runtime") fail(`display_name ${manifest.display_name}`);
  if (manifest.version !== version) fail(`version ${manifest.version}`);
  if (manifest.server?.type !== "node") fail("server.type must be node");
  if (manifest.server?.entry_point !== "server/praxis-mcp.cjs") {
    fail(`entry_point ${manifest.server?.entry_point}`);
  }
  if (manifest.user_config?.jira_token?.sensitive !== true) {
    fail("jira_token.sensitive !== true");
  }
  for (const [key, spec] of Object.entries(JIRA_USER_CONFIG)) {
    const field = manifest.user_config?.[key];
    if (!field) fail(`missing user_config.${key}`);
    if (field.type !== spec.type) fail(`${key}.type ${field.type}`);
    if (field.title !== spec.title) fail(`${key}.title ${field.title}`);
    if (field.required !== true) fail(`${key}.required !== true`);
  }
  for (const [envName, subst] of Object.entries(JIRA_ENV_MAP)) {
    if (manifest.server.mcp_config.env[envName] !== subst) {
      fail(`env ${envName} != ${subst}`);
    }
  }
  const fileValidate = spawnSync(
    process.execPath,
    [mcpbBin(), "validate", join(extracted.dest, "manifest.json")],
    { cwd: root, encoding: "utf8" },
  );
  if ((fileValidate.status ?? 1) !== 0) {
    fail(`mcpb validate failed\n${fileValidate.stdout}\n${fileValidate.stderr}`);
  }
  proven.push("manifest schema", "user_config schema", "sensitive Jira token", "mcp_config substitutions");
  assertNoSecret("packed manifest", JSON.stringify(manifest));

  const missing = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: hostedCleanEnv(extracted.dest),
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    if (missing.era !== "modern" || missing.protocolVersion !== MODERN_PROTOCOL) {
      fail(`missing-config modern negotiation failed era=${missing.era}`);
    }
    const { tools, envelope } = await listAndDoctor(missing, extracted.dest);
    if (!tools.some((t) => t.name === "praxis_doctor")) fail("missing praxis_doctor");
    if (!envelope?.ok) fail("doctor failed with no user_config");
    const data = doctorData(envelope);
    const jira = data.jira || {};
    if (jira.baseUrlConfigured || jira.emailConfigured || jira.projectKeyConfigured || jira.tokenConfigured) {
      fail(`missing-config flags not false: ${JSON.stringify(jira)}`);
    }
    if (data.codes?.jira !== "JIRA_CONFIG_UNAVAILABLE") {
      fail(`expected JIRA_CONFIG_UNAVAILABLE, got ${data.codes?.jira}`);
    }
    const jiraOp = await missing.client.callTool({
      name: "praxis_jira_status",
      arguments: { epic: "PRX-1", repo: extracted.dest },
    });
    const jiraText = jiraOp.content?.map((c) => c.text).join("\n") ?? JSON.stringify(jiraOp);
    if (!jiraText.includes("JIRA_CONFIG_UNAVAILABLE")) {
      fail(`jira op missing JIRA_CONFIG_UNAVAILABLE: ${jiraText.slice(0, 400)}`);
    }
    assertNoSecret("missing-config stdout/stderr", `${JSON.stringify(envelope)}\n${missing.stderr()}\n${jiraText}`);
    proven.push("missing config", "doctor without network");
  } finally {
    await missing.close();
  }

  const partialEnv = {
    ...hostedCleanEnv(extracted.dest),
    PRAXIS_JIRA_BASE_URL: "https://example.invalid",
    PRAXIS_JIRA_EMAIL: "test@example.com",
    PRAXIS_JIRA_PROJECT_KEY: "PRX",
  };
  const partial = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: partialEnv,
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    const started = Date.now();
    const jiraOp = await partial.client.callTool({
      name: "praxis_jira_status",
      arguments: { epic: "PRX-1", repo: extracted.dest },
    });
    const elapsed = Date.now() - started;
    if (elapsed > 2500) fail(`partial-config jira op took ${elapsed}ms (likely networked)`);
    const jiraText = jiraOp.content?.map((c) => c.text).join("\n") ?? JSON.stringify(jiraOp);
    if (!jiraText.includes("JIRA_CONFIG_UNAVAILABLE") || !jiraText.includes("jira_token")) {
      fail(`partial-config must identify missing token: ${jiraText.slice(0, 500)}`);
    }
    if (jiraText.includes("HTTP") && /atlassian|example\.invalid/.test(jiraText)) {
      fail("partial-config performed a Jira network request");
    }
    proven.push("partial config token missing");
  } finally {
    await partial.close();
  }

  const configured = await connectOfficialMcp({
    command: process.execPath,
    args: extracted.args,
    cwd: extracted.dest,
    env: { ...hostedCleanEnv(extracted.dest), ...fixtureJiraEnv() },
    versionNegotiation: versionNegotiationModern(),
    timeoutMs: MCP_STARTUP_BUDGET_MS,
    clientVersion: version,
  });
  try {
    const { envelope } = await listAndDoctor(configured, extracted.dest);
    if (!envelope?.ok) fail("configured doctor failed");
    const jira = doctorData(envelope).jira || {};
    for (const flag of ["baseUrlConfigured", "emailConfigured", "projectKeyConfigured", "tokenConfigured"]) {
      if (jira[flag] !== true) fail(`configured ${flag} !== true: ${JSON.stringify(jira)}`);
    }
    const dump = `${JSON.stringify(envelope)}\n${configured.stderr()}`;
    assertNoSecret("configured doctor", dump);
    if (/Authorization/i.test(dump)) fail("doctor leaked Authorization");
    proven.push("config injection fixture", "token leakage tests");
  } finally {
    await configured.close();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version,
        file: EXTENSION_FILE,
        manifest_version: MCPB_MANIFEST_VERSION,
        sdk,
        proven,
        pending: [
          "manual MCPB installation",
          "manual secure user_config",
          "manual Claude Desktop Jira read",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(outside, { recursive: true, force: true });
}
