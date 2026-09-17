#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
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
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const distDir = claudePluginsDir(version);
const repoDir = repoClaudePluginsDir();

await packClaudePlugins(version);
const distReport = await verifyClaudePlugins(version, distDir);
if (!distReport.ok) fail("dist verify-claude-plugins failed");

if (!existsSync(join(repoDir, "README.md"))) {
  fail("missing claude-plugins/README.md");
}
if (!existsSync(join(repoDir, "manifest.json"))) {
  fail("missing claude-plugins/manifest.json");
}
if (existsSync(join(repoDir, "praxis-all.zip"))) {
  fail("praxis-all.zip must not be shipped");
}

const repoManifest = JSON.parse(readFileSync(join(repoDir, "manifest.json"), "utf8"));
if (repoManifest.version !== version) {
  fail(`committed claude-plugins/manifest.json version ${repoManifest.version} != ${version}`);
}

for (const file of PLUGIN_ZIP_FILES) {
  const distZip = join(distDir, file);
  const repoZip = join(repoDir, file);
  if (!existsSync(repoZip)) fail(`committed artifact missing: claude-plugins/${file}`);
  const distSha = sha256File(distZip);
  const repoSha = sha256File(repoZip);
  if (distSha !== repoSha) {
    fail(`SHA mismatch ${file}: dist=${distSha} repo=${repoSha}`);
  }
}

const stale = PLUGIN_ZIP_FILES.filter((file) => {
  const listed = (repoManifest.plugins || []).find((p) => p.file === file);
  return listed && listed.version && listed.version !== version;
});
if (stale.length) fail(`stale previous-version archives: ${stale.join(", ")}`);

const repoReport = await verifyClaudePlugins(version, repoDir);
if (!repoReport.ok) fail("repository verify-claude-plugins failed");

const report = {
  ok: true,
  version,
  distribution: "repository",
  directory: "claude-plugins",
  plugins: PLUGIN_ZIP_FILES,
  proven: [
    "MCP runtime bundled",
    "no top-level bin directory",
    "no runtime node_modules",
    "no symlink entries",
    "safe archive paths",
    "deterministic archive structure",
    "valid Claude plugin manifest",
    "skills packaged",
    "MCP server initializes from extracted ZIP",
    "repository artifacts match dist hashes",
    "no secrets",
    "no absolute paths",
  ],
  pending: ["manual Claude UI upload", "manual Cowork local-workspace E2E"],
};

console.log(JSON.stringify(report, null, 2));
