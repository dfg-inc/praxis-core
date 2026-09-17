#!/usr/bin/env node
/**
 * Build Claude UI plugin ZIPs with a single bundled Praxis runtime.
 *
 *   node tools/scripts/pack-claude-plugins.mjs --version 0.1.0-alpha.28
 *
 * Layout (archive root):
 *   .claude-plugin/plugin.json
 *   skills/  prompts/  hooks/
 *   bin/praxis
 *   runtime/praxis-runtime.cjs
 *   README.md
 *   VERSION
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";
import {
  PLUGINS,
  MANIFEST_CONTRACT,
  distClaudePluginsDir,
  repoClaudePluginsDir as repoDirFor,
} from "./claude-plugins-shared.mjs";
import {
  checkSafeArchivePath,
  directoryEntriesFor,
  invalidPathError,
  writeZip,
} from "./claude-zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`claude-plugins: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd = root) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`${cmd}\n${r.stderr || r.stdout}`);
  return r;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function claudePluginsDir(version) {
  return distClaudePluginsDir(root, version);
}

export function repoClaudePluginsDir() {
  return repoDirFor(root);
}

function isJunkName(name) {
  return (
    name === ".DS_Store" ||
    name === "__MACOSX" ||
    name === "Thumbs.db" ||
    name.startsWith("._")
  );
}

function copyTreeFiltered(from, to) {
  if (!existsSync(from)) return;
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    fail(`CLAUDE_PLUGIN_SYMLINK: ${from}`);
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) {
      if (isJunkName(name)) continue;
      if (name === "node_modules") continue;
      copyTreeFiltered(join(from, name), join(to, name));
    }
    return;
  }
  if (!st.isFile()) fail(`CLAUDE_PLUGIN_SPECIAL_FILE: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function writeLauncher(dest) {
  const binDir = join(dest, "bin");
  mkdirSync(binDir, { recursive: true });
  const sh = `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  ROOT="\${CLAUDE_PLUGIN_ROOT}"
else
  ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
fi
NODE="\${PRAXIS_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
  echo "LOCAL_RUNTIME_UNAVAILABLE: Node.js not found on PATH" >&2
  exit 7
fi
RUNTIME="$ROOT/runtime/praxis-runtime.cjs"
if [[ ! -f "$RUNTIME" ]]; then
  echo "LOCAL_RUNTIME_UNAVAILABLE: bundled Praxis runtime missing" >&2
  exit 7
fi
exec "$NODE" "$RUNTIME" "$@"
`;
  const path = join(binDir, "praxis");
  writeFileSync(path, sh);
  chmodSync(path, 0o755);
}

async function bundlePraxisRuntime(outfile, version) {
  const entry = join(root, "packages/cli/dist/main.js");
  if (!existsSync(entry)) {
    run(
      "npm run build -w @praxis/contracts -w @praxis/project-config -w @praxis/jira -w @praxis/cli",
    );
  }
  if (!existsSync(entry)) fail(`missing CLI build ${entry}`);
  mkdirSync(dirname(outfile), { recursive: true });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    legalComments: "none",
    minify: false,
    sourcemap: false,
    logLevel: "silent",
    define: {
      "process.env.PRAXIS_BUNDLE_VERSION": JSON.stringify(version),
    },
    external: ["@praxis/quality-service"],
  });
  if (!existsSync(outfile)) fail(`esbuild did not write ${outfile}`);
}

function collectZipEntries(dest) {
  const files = [];
  function walk(rel) {
    const abs = rel ? join(dest, rel) : dest;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) fail(`CLAUDE_PLUGIN_SYMLINK: ${rel || "."}`);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (isJunkName(name)) continue;
        const child = rel ? `${rel}/${name}` : name;
        walk(child.replace(/\\/g, "/"));
      }
      return;
    }
    if (!st.isFile()) fail(`CLAUDE_PLUGIN_SPECIAL_FILE: ${rel}`);
    const name = rel.replace(/\\/g, "/");
    const check = checkSafeArchivePath(name);
    if (!check.ok) fail(invalidPathError(name, check.reason));
    if (name.includes("node_modules")) {
      fail(`CLAUDE_PLUGIN_NODE_MODULES: ${name}`);
    }
    if (/\.tgz$/i.test(name)) fail(`CLAUDE_PLUGIN_TGZ: ${name}`);
    files.push({
      name,
      abs,
      mode: name === "bin/praxis" ? 0o755 : 0o644,
    });
  }
  walk("");
  files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
  );
  const dirs = directoryEntriesFor(files.map((f) => f.name));
  const entries = [
    ...dirs.map((name) => ({ name, isDir: true, mode: 0o755 })),
    ...files.map((f) => ({
      name: f.name,
      data: readFileSync(f.abs),
      mode: f.mode,
    })),
  ];
  return entries;
}

function stagePlugin(plugin, version, stagingRoot, runtimeSrc) {
  const dest = join(stagingRoot, plugin.id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const src = join(root, plugin.src);
  copyTreeFiltered(join(src, ".claude-plugin"), join(dest, ".claude-plugin"));
  copyTreeFiltered(join(src, "skills"), join(dest, "skills"));
  copyTreeFiltered(join(src, "prompts"), join(dest, "prompts"));
  copyTreeFiltered(join(src, "hooks"), join(dest, "hooks"));
  mkdirSync(join(dest, "hooks"), { recursive: true });
  const pluginJsonPath = join(dest, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJsonPath)) fail(`missing ${pluginJsonPath}`);
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  pluginJson.version = version;
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
  writeFileSync(join(dest, "VERSION"), `${version}\n`);
  writeFileSync(
    join(dest, "README.md"),
    `# ${plugin.title}

Claude UI plugin. Import this ZIP (manifest at archive root).

Primary human workflow: invoke a skill and speak naturally.
Machine runtime: \`bin/praxis\` (bundled Praxis CLI ${version}).
`,
  );
  writeLauncher(dest);
  mkdirSync(join(dest, "runtime"), { recursive: true });
  cpSync(runtimeSrc, join(dest, "runtime", "praxis-runtime.cjs"));
  chmodSync(join(dest, "runtime", "praxis-runtime.cjs"), 0o644);
  return dest;
}

function buildManifest(version, zips) {
  return {
    contract: MANIFEST_CONTRACT,
    version,
    plugins: zips.map((z) => ({
      name: z.title,
      file: z.file,
      sha256: z.sha256,
      version,
    })),
  };
}

export async function packClaudePlugins(version) {
  if (!version) fail("version required");
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (version !== pkgVersion) {
    fail(`VERSION ${version} must match package.json ${pkgVersion}`);
  }
  const outDir = claudePluginsDir(version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const staging = join(root, "dist", "claude-plugins-staging", version);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const runtimeSrc = join(staging, "_runtime", "praxis-runtime.cjs");
  await bundlePraxisRuntime(runtimeSrc, version);
  const zips = [];
  for (const plugin of PLUGINS) {
    const dest = stagePlugin(plugin, version, staging, runtimeSrc);
    const entries = collectZipEntries(dest);
    const zipBuf = writeZip(entries, { enforcePolicy: true });
    const zipPath = join(outDir, `${plugin.id}.zip`);
    writeFileSync(zipPath, zipBuf);
    zips.push({
      id: plugin.id,
      title: plugin.title,
      file: `${plugin.id}.zip`,
      sha256: sha256(zipBuf),
      bytes: zipBuf.length,
      requiredSkills: plugin.requiredSkills,
    });
  }
  const manifest = buildManifest(version, zips);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`claude-plugins packed -> ${outDir}`);
  return { outDir, manifest };
}

export { PLUGINS, buildManifest };

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  packClaudePlugins(version).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
