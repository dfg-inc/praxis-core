#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  EXTENSION_CONTRACT,
  EXTENSION_FILE,
  JIRA_ENV_MAP,
  MCPB_MANIFEST_VERSION,
  distClaudeExtensionsDir,
  mcpbCliPath,
} from "./claude-extensions-shared.mjs";
import { extractMcpbRuntime } from "./mcpb-runtime.mjs";
import {
  connectOfficialMcp,
  hostedCleanEnv,
  listAndDoctor,
  MCP_STARTUP_BUDGET_MS,
  versionNegotiationModern,
} from "./official-mcp-client.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`verify-claude-extension: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function mcpbBin() {
  return mcpbCliPath(require);
}

export async function verifyClaudeExtension(version, dir = distClaudeExtensionsDir(root, version)) {
  const mcpbPath = join(dir, EXTENSION_FILE);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(mcpbPath)) fail(`missing ${mcpbPath}`);
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
  const report = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (report.version !== version) fail(`manifest version ${report.version} != ${version}`);
  if (report.contract && report.contract !== EXTENSION_CONTRACT) {
    fail(`unexpected contract ${report.contract}`);
  }
  if (report.file !== EXTENSION_FILE) fail(`unexpected file ${report.file}`);
  const sha = sha256File(mcpbPath);
  if (report.sha256 && report.sha256 !== sha) fail("MCPB sha256 mismatch vs manifest");
  const tmp = mkdtempSync(join(tmpdir(), "praxis-mcpb-verify-"));
  try {
    const extracted = extractMcpbRuntime(mcpbPath, join(tmp, "unpack"));
    const packedManifest = extracted.manifest;
    if (packedManifest.manifest_version !== MCPB_MANIFEST_VERSION) {
      fail(`packed manifest_version ${packedManifest.manifest_version}`);
    }
    if (packedManifest.user_config?.jira_token?.sensitive !== true) {
      fail("packed jira_token.sensitive !== true");
    }
    for (const [envName, subst] of Object.entries(JIRA_ENV_MAP)) {
      if (packedManifest.server?.mcp_config?.env?.[envName] !== subst) {
        fail(`packed mcp_config.env.${envName} must be ${subst}`);
      }
    }
    if (JSON.stringify(packedManifest).includes("SECRET_FIXTURE_VALUE")) {
      fail("packed manifest leaked fixture token");
    }
    const fileValidate = spawnSync(
      process.execPath,
      [mcpbBin(), "validate", join(extracted.dest, "manifest.json")],
      { cwd: root, encoding: "utf8" },
    );
    if ((fileValidate.status ?? 1) !== 0) {
      fail(`mcpb validate packed manifest failed\n${fileValidate.stdout}\n${fileValidate.stderr}`);
    }
    const session = await connectOfficialMcp({
      command: process.execPath,
      args: extracted.args,
      cwd: extracted.dest,
      env: hostedCleanEnv(extracted.dest),
      versionNegotiation: versionNegotiationModern(),
      timeoutMs: MCP_STARTUP_BUDGET_MS,
      clientVersion: version,
    });
    try {
      if (session.era !== "modern") fail(`expected modern era, got ${session.era}`);
      const { tools, envelope } = await listAndDoctor(session, extracted.dest);
      const names = tools.map((t) => t.name);
      if (!names.includes("praxis_doctor")) fail("runtime tools/list missing praxis_doctor");
      if (!names.includes("praxis_architect_status")) fail("runtime missing praxis_architect_status");
      if (!names.includes("praxis_ba_preview")) fail("runtime missing praxis_ba_preview");
      if (!envelope?.ok) fail("praxis_doctor failed");
      const combined = `${JSON.stringify(envelope)}\n${session.stderr()}`;
      if (combined.includes("SECRET_FIXTURE_VALUE")) fail("doctor leaked fixture token");
      return {
        ok: true,
        version,
        file: EXTENSION_FILE,
        sha256: sha,
        bytes: readFileSync(mcpbPath).length,
        toolCount: names.length,
        protocol: { era: session.era, version: session.protocolVersion },
      };
    } finally {
      await session.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  verifyClaudeExtension(version)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
