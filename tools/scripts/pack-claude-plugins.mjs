#!/usr/bin/env node
/**
 * Build installable Claude UI plugin ZIPs with a bundled Praxis runtime.
 *
 *   node tools/scripts/pack-claude-plugins.mjs --version 0.1.0-alpha.26
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ALL_WORKSPACES,
  localPackagesDir,
  packReleaseLocal,
  tarballFileName,
} from "./local-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PLUGINS = [
  {
    id: "praxis-ba",
    title: "Praxis BA",
    src: "plugins/ba",
    requiredSkills: [
      "jira-epic-analysis",
      "resume-ba-work",
      "ba-jira-status",
    ],
  },
  {
    id: "praxis-architect",
    title: "Praxis Architect",
    src: "plugins/architect",
    requiredSkills: [
      "plan-jira-epic",
      "resume-architecture",
      "materialize-work-package",
      "architecture-status",
    ],
  },
  {
    id: "praxis-developer",
    title: "Praxis Developer",
    src: "plugins/developer",
    requiredSkills: [
      "implement-work-package",
      "resume-work-package",
      "developer-status",
    ],
  },
  {
    id: "praxis-quality",
    title: "Praxis Quality",
    src: "plugins/quality",
    requiredSkills: ["review-work-package", "resume-qa", "quality-status"],
  },
];

function fail(msg) {
  console.error(`claude-plugins: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd = root) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`${cmd}\n${r.stderr || r.stdout}`);
  return r;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function copyTree(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export function claudePluginsDir(version) {
  return join(root, "dist", "claude-plugins", version);
}

function writeLauncher(dest) {
  const binDir = join(dest, "bin");
  mkdirSync(binDir, { recursive: true });
  const sh = `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
NODE="\${PRAXIS_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
  echo "LOCAL_RUNTIME_UNAVAILABLE: Node.js not found on PATH" >&2
  exit 7
fi
CLI="$ROOT/runtime/node_modules/@praxis/cli/dist/main.js"
if [[ ! -f "$CLI" ]]; then
  echo "LOCAL_RUNTIME_UNAVAILABLE: bundled Praxis runtime missing" >&2
  exit 7
fi
exec "$NODE" "$CLI" "$@"
`;
  const path = join(binDir, "praxis");
  writeFileSync(path, sh);
  chmodSync(path, 0o755);
}

function installRuntime(stage, version) {
  const runtime = join(stage, "runtime");
  mkdirSync(runtime, { recursive: true });
  const tgzDir = localPackagesDir(root, version);
  const deps = {};
  for (const ws of ALL_WORKSPACES) {
    const name = tarballFileName(ws, version);
    const src = join(tgzDir, name);
    if (!existsSync(src)) fail(`missing ${src}`);
    cpSync(src, join(runtime, name));
    deps[ws] = `file:./${name}`;
  }
  writeFileSync(
    join(runtime, "package.json"),
    `${JSON.stringify(
      {
        name: "praxis-plugin-runtime",
        private: true,
        type: "module",
        dependencies: deps,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(runtime, ".npmrc"), "@praxis:registry=https://npm.praxis.invalid\n");
  const env = { ...process.env };
  delete env.PRAXIS_JIRA_TOKEN;
  delete env.PRAXIS_JIRA_EMAIL;
  run("npm install --omit=dev --no-fund --no-audit", runtime);
}

function stagePlugin(plugin, version, stagingRoot) {
  const dest = join(stagingRoot, plugin.id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const src = join(root, plugin.src);
  copyTree(join(src, ".claude-plugin"), join(dest, ".claude-plugin"));
  copyTree(join(src, "skills"), join(dest, "skills"));
  copyTree(join(src, "prompts"), join(dest, "prompts"));
  copyTree(join(src, "hooks"), join(dest, "hooks"));
  const pluginJsonPath = join(dest, ".claude-plugin", "plugin.json");
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  pluginJson.version = version;
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
  writeFileSync(join(dest, "VERSION"), `${version}\n`);
  writeFileSync(
    join(dest, "README.md"),
    `# ${plugin.title}

Claude UI / Cowork plugin. Import this ZIP (manifest at archive root).

Primary human workflow: invoke a skill and speak naturally.
Machine runtime: \`bin/praxis\` (bundled @praxis/cli ${version}).
`,
  );
  writeLauncher(dest);
  mkdirSync(join(dest, "hooks"), { recursive: true });
  installRuntime(dest, version);
  return dest;
}

export function packClaudePlugins(version) {
  if (!version) fail("version required");
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (version !== pkgVersion) {
    fail(`VERSION ${version} must match package.json ${pkgVersion}`);
  }
  packReleaseLocal(root, version);
  const outDir = claudePluginsDir(version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const staging = join(root, "dist", "claude-plugins-staging", version);
  rmSync(staging, { recursive: true, force: true });
  const zips = [];
  for (const plugin of PLUGINS) {
    const dest = stagePlugin(plugin, version, staging);
    const zipPath = join(outDir, `${plugin.id}.zip`);
    run(`zip -r -X ${JSON.stringify(zipPath)} .`, dest);
    zips.push({
      id: plugin.id,
      title: plugin.title,
      file: `${plugin.id}.zip`,
      sha256: sha256(zipPath),
      requiredSkills: plugin.requiredSkills,
    });
  }
  const manifest = {
    version,
    plugins: zips,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`claude-plugins packed -> ${outDir}`);
  return { outDir, manifest };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  packClaudePlugins(version);
}

export { PLUGINS };
