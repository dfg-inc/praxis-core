import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  EXTENSION_FILE,
  distClaudeExtensionsDir,
  praxisRuntimeManifest,
} from "./claude-extensions-shared.mjs";
import { packClaudeExtension } from "./pack-claude-extension.mjs";
import { extractZip } from "./claude-zip.mjs";

export const SECRET_FIXTURE_VALUE = "SECRET_FIXTURE_VALUE";

export const FIXTURE_USER_CONFIG = {
  jira_base_url: "https://example.invalid",
  jira_email: "test@example.com",
  jira_project_key: "PRX",
  jira_token: SECRET_FIXTURE_VALUE,
};

export function fixtureJiraEnv() {
  return {
    PRAXIS_JIRA_BASE_URL: FIXTURE_USER_CONFIG.jira_base_url,
    PRAXIS_JIRA_EMAIL: FIXTURE_USER_CONFIG.jira_email,
    PRAXIS_JIRA_PROJECT_KEY: FIXTURE_USER_CONFIG.jira_project_key,
    PRAXIS_JIRA_TOKEN: FIXTURE_USER_CONFIG.jira_token,
  };
}

export async function ensurePackedExtension(root, version) {
  const distDir = distClaudeExtensionsDir(root, version);
  const mcpbPath = join(distDir, EXTENSION_FILE);
  if (!existsSync(mcpbPath)) {
    await packClaudeExtension(version);
  }
  if (!existsSync(mcpbPath)) {
    throw new Error(`missing packed MCPB ${mcpbPath}`);
  }
  return { distDir, mcpbPath };
}

export function extractMcpbRuntime(mcpbPath, dest) {
  mkdirSync(dest, { recursive: true });
  extractZip(readFileSync(mcpbPath), dest);
  const runtime = join(dest, "server", "praxis-mcp.cjs");
  const quality = join(dest, "server", "praxis-quality.cjs");
  const manifestPath = join(dest, "manifest.json");
  if (!existsSync(runtime)) throw new Error(`MCPB missing ${runtime}`);
  if (!existsSync(quality)) throw new Error(`MCPB missing ${quality}`);
  if (!existsSync(manifestPath)) throw new Error(`MCPB missing ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return {
    dest,
    runtime,
    quality,
    manifest,
    args: [runtime, "--role", "runtime"],
  };
}

export function expectedRuntimeManifest(version) {
  return praxisRuntimeManifest(version);
}

export function mcpbPayloadFingerprint(mcpbPath, dest) {
  const extracted = extractMcpbRuntime(mcpbPath, dest);
  const files = [];
  function walk(rel) {
    const abs = rel ? join(extracted.dest, rel) : extracted.dest;
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
      return;
    }
    files.push({
      name: rel.replace(/\\/g, "/"),
      sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"),
    });
  }
  walk("");
  files.sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.name}:${f.sha256}\n`);
  return { files, sha256: hash.digest("hex"), extracted };
}
