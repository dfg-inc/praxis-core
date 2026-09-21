#!/usr/bin/env node
/**
 * Pack the Praxis Runtime Claude Desktop Extension (.mcpb).
 *
 *   node tools/scripts/pack-claude-extension.mjs --version 0.1.0-alpha.31
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { bundlePraxisMcp, bundlePraxisQuality } from "./mcp-bundle.mjs";
import {
  EXTENSION_CONTRACT,
  EXTENSION_FILE,
  distClaudeExtensionsDir,
  mcpbCliPath,
  praxisRuntimeManifest,
} from "./claude-extensions-shared.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`claude-extension: ${msg}`);
  process.exit(1);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function mcpbBin() {
  return mcpbCliPath(require);
}

export async function packClaudeExtension(version) {
  if (!version) fail("version required");
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (version !== pkgVersion) {
    fail(`VERSION ${version} must match package.json ${pkgVersion}`);
  }
  const outDir = distClaudeExtensionsDir(root, version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const staging = join(root, "dist", "claude-extension-staging", version);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "server"), { recursive: true });
  const runtime = join(staging, "server", "praxis-mcp.cjs");
  await bundlePraxisMcp(runtime, version);
  chmodSync(runtime, 0o644);
  const quality = join(staging, "server", "praxis-quality.cjs");
  await bundlePraxisQuality(quality, version);
  chmodSync(quality, 0o644);
  const manifest = praxisRuntimeManifest(version);
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const validate = spawnSync(process.execPath, [mcpbBin(), "validate", join(staging, "manifest.json")], {
    cwd: root,
    encoding: "utf8",
  });
  if ((validate.status ?? 1) !== 0) {
    fail(`mcpb validate failed\n${validate.stdout || ""}\n${validate.stderr || ""}`);
  }
  const mcpbPath = join(outDir, EXTENSION_FILE);
  const packed = spawnSync(process.execPath, [mcpbBin(), "pack", staging, mcpbPath], {
    cwd: root,
    encoding: "utf8",
  });
  if ((packed.status ?? 1) !== 0) {
    fail(`mcpb pack failed\n${packed.stdout || ""}\n${packed.stderr || ""}`);
  }
  if (!existsSync(mcpbPath)) fail(`mcpb pack did not write ${mcpbPath}`);
  const buf = readFileSync(mcpbPath);
  const report = {
    contract: EXTENSION_CONTRACT,
    version,
    file: EXTENSION_FILE,
    sha256: sha256(buf),
    bytes: buf.length,
    manifest_version: manifest.manifest_version,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`claude-extension packed -> ${mcpbPath}`);
  return { outDir, mcpbPath, report, staging };
}

export { praxisRuntimeManifest };

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  packClaudeExtension(version).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
