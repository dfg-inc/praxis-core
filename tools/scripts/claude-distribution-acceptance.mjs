#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { PLUGIN_ZIP_FILES } from "./claude-plugins-shared.mjs";
import {
  claudePluginsDir,
  packClaudePlugins,
  repoClaudePluginsDir,
} from "./pack-claude-plugins.mjs";
import { verifyClaudePlugins } from "./verify-claude-plugins.mjs";
import { EXTENSION_FILE, distClaudeExtensionsDir, repoClaudeExtensionsDir } from "./claude-extensions-shared.mjs";
import { packClaudeExtension } from "./pack-claude-extension.mjs";
import { verifyClaudeExtension } from "./verify-claude-extension.mjs";
import { mcpbPayloadFingerprint } from "./mcpb-runtime.mjs";

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

await packClaudeExtension(version);
const extDist = distClaudeExtensionsDir(root, version);
const extRepo = repoClaudeExtensionsDir(root);
const extDistReport = await verifyClaudeExtension(version, extDist);
if (!extDistReport.ok) fail("dist verify-claude-extension failed");
if (!existsSync(join(extRepo, EXTENSION_FILE))) {
  fail(`committed artifact missing: claude-extensions/${EXTENSION_FILE}`);
}
if (!existsSync(join(extRepo, "README.md"))) fail("missing claude-extensions/README.md");
const tmp = mkdtempSync(join(tmpdir(), "praxis-mcpb-dist-"));
try {
  const distFp = mcpbPayloadFingerprint(join(extDist, EXTENSION_FILE), join(tmp, "dist"));
  const repoFp = mcpbPayloadFingerprint(join(extRepo, EXTENSION_FILE), join(tmp, "repo"));
  if (distFp.sha256 !== repoFp.sha256) {
    fail(`MCPB payload mismatch dist=${distFp.sha256} repo=${repoFp.sha256}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const extRepoReport = await verifyClaudeExtension(version, extRepo);
if (!extRepoReport.ok) fail("repository verify-claude-extension failed");

const report = {
  ok: true,
  version,
  distribution: "repository",
  directories: ["claude-plugins", "claude-extensions"],
  plugins: PLUGIN_ZIP_FILES,
  extension: EXTENSION_FILE,
  proven: [
    "skills-only role plugins",
    "no bundled MCP runtime",
    "no top-level bin directory",
    "no runtime node_modules",
    "no symlink entries",
    "safe archive paths",
    "deterministic archive structure",
    "valid Claude plugin manifest",
    "repository artifacts match dist hashes",
    "Praxis Runtime MCPB committed",
    "no secrets",
    "no absolute paths",
  ],
  pending: [
    "manual Claude UI upload",
    "manual MCPB installation",
    "manual Cowork local-workspace E2E",
  ],
};

console.log(JSON.stringify(report, null, 2));
