#!/usr/bin/env node
/**
 * Copy validated dist Claude plugin ZIPs into the repository distribution folder.
 *
 *   node tools/scripts/sync-claude-plugins.mjs --version 0.1.0-alpha.28
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
import { PLUGINS, PLUGIN_ZIP_FILES } from "./claude-plugins-shared.mjs";
import {
  claudePluginsDir,
  packClaudePlugins,
  repoClaudePluginsDir,
} from "./pack-claude-plugins.mjs";
import { verifyClaudePlugins } from "./verify-claude-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`sync-claude-plugins: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function claudePluginsReadme() {
  return `# Praxis Claude plugins

Praxis Claude plugins are ready to import.

In Claude:

1. Customize
2. Plugins
3. Add
4. Upload plugins

Upload these files from this folder:

- \`praxis-ba.zip\`
- \`praxis-architect.zip\`
- \`praxis-developer.zip\`
- \`praxis-quality.zip\`

Then open your product workspace and invoke the matching Praxis skill.

You do not need \`make\`, \`npm\`, or a terminal to install the plugins.

Claude UI upload remains a manual check after each release.
`;
}

export async function syncClaudePlugins(version) {
  if (!version) fail("version required");
  const distDir = claudePluginsDir(version);
  await packClaudePlugins(version);
  const distReport = verifyClaudePlugins(version, distDir);
  if (!distReport.ok) fail("dist validation failed");

  const repoDir = repoClaudePluginsDir();
  mkdirSync(repoDir, { recursive: true });
  for (const file of PLUGIN_ZIP_FILES) {
    const src = join(distDir, file);
    if (!existsSync(src)) fail(`refusing to copy missing validated archive ${src}`);
    const dest = join(repoDir, file);
    rmSync(dest, { force: true });
    cpSync(src, dest);
    const a = sha256File(src);
    const b = sha256File(dest);
    if (a !== b) fail(`copy SHA mismatch for ${file}`);
  }
  const distManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
  writeFileSync(
    join(repoDir, "manifest.json"),
    `${JSON.stringify(distManifest, null, 2)}\n`,
  );
  writeFileSync(join(repoDir, "README.md"), claudePluginsReadme());

  const repoReport = verifyClaudePlugins(version, repoDir);
  if (!repoReport.ok) fail("repository distribution validation failed");
  console.log(`claude-plugins synced -> ${repoDir}`);
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
  syncClaudePlugins(version).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { PLUGINS };
