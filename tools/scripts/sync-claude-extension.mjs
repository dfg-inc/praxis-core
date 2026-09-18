#!/usr/bin/env node
/**
 * Copy validated Praxis Runtime MCPB into the repository distribution folder.
 *
 *   node tools/scripts/sync-claude-extension.mjs --version 0.1.0-alpha.31
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  EXTENSION_FILE,
  distClaudeExtensionsDir,
  repoClaudeExtensionsDir,
} from "./claude-extensions-shared.mjs";
import { packClaudeExtension } from "./pack-claude-extension.mjs";
import { verifyClaudeExtension } from "./verify-claude-extension.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`sync-claude-extension: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function claudeExtensionReadme() {
  return `# Praxis Runtime

Install this Claude Desktop Extension once. Role plugins use its tools.

## Install (no terminal)

1. Claude Desktop → **Settings** → **Extensions** → **Advanced settings** → **Install extension**
2. Select \`praxis-runtime.mcpb\` from this folder
3. Configure:
   - Jira Base URL
   - Jira Email
   - Jira Project Key
   - Jira API Token (sensitive; stored in OS Keychain / Credential Manager)
4. Install the four role plugins from \`claude-plugins/\`
5. Open Cowork, select the product folder, invoke a Skill

Do not use \`launchctl setenv\`, \`source .env\`, or paste tokens into chat.

To update Jira later: **Settings → Extensions → Praxis Runtime → Settings**. No reinstall required.

Organization owners may upload this custom desktop extension where Team/Enterprise deployment is supported. Public directory publishing is not required.

Claude Desktop installation remains a manual check after each release.
`;
}

export async function syncClaudeExtension(version) {
  if (!version) fail("version required");
  const distDir = distClaudeExtensionsDir(root, version);
  await packClaudeExtension(version);
  const distReport = await verifyClaudeExtension(version, distDir);
  if (!distReport.ok) fail("dist validation failed");

  const repoDir = repoClaudeExtensionsDir(root);
  mkdirSync(repoDir, { recursive: true });
  const src = join(distDir, EXTENSION_FILE);
  const dest = join(repoDir, EXTENSION_FILE);
  rmSync(dest, { force: true });
  cpSync(src, dest);
  const a = sha256File(src);
  const b = sha256File(dest);
  if (a !== b) fail(`copy SHA mismatch for ${EXTENSION_FILE}`);
  const distManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
  writeFileSync(join(repoDir, "manifest.json"), `${JSON.stringify(distManifest, null, 2)}\n`);
  writeFileSync(join(repoDir, "README.md"), claudeExtensionReadme());

  const repoReport = await verifyClaudeExtension(version, repoDir);
  if (!repoReport.ok) fail("repository distribution validation failed");
  console.log(`claude-extensions synced -> ${repoDir}`);
  return { distDir, repoDir, manifest: distManifest };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  syncClaudeExtension(version).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
