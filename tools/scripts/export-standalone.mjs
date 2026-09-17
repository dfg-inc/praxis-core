#!/usr/bin/env node
/**
 * Deterministic standalone source export for praxis-ba / praxis-developer.
 * Canonical source remains the monorepo. Shared @praxis packages are vendored
 * as release tgzs (not source forks) so install works without workspaces.
 *
 *   node tools/scripts/export-standalone.mjs ba <outdir>
 *   node tools/scripts/export-standalone.mjs developer <outdir>
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const STANDALONE_SCHEMA_VERSION = "1.0.0";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".DS_Store",
]);

const SHARED_PACKAGES = [
  { npmName: "@praxis/contracts", dir: "packages/contracts", files: ["dist"] },
  {
    npmName: "@praxis/project-config",
    dir: "packages/project-config",
    files: ["dist"],
  },
  {
    npmName: "@praxis/knowledge",
    dir: "packages/knowledge",
    files: ["dist", "bin"],
  },
  {
    npmName: "@praxis/plugin-sdk",
    dir: "packages/plugin-sdk",
    files: ["dist", "bin"],
  },
];

function readJson(abs) {
  return JSON.parse(readFileSync(abs, "utf8"));
}

function writeJson(abs, data) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
}

function run(cmd, cwd = root) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function sourceCommit(repoRoot = root) {
  const fromEnv = process.env.PRAXIS_SOURCE_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if ((r.status ?? 1) !== 0) return "unknown";
  return (r.stdout ?? "").trim();
}

export function praxisVersion(repoRoot = root) {
  return readJson(join(repoRoot, "package.json")).version;
}

function shouldCopy(srcRoot, abs) {
  const rel = relative(srcRoot, abs);
  if (!rel || rel.startsWith("..")) return true;
  const segs = rel.split(/[/\\]/);
  return !segs.some((s) => SKIP_SEGMENTS.has(s));
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => shouldCopy(src, p),
  });
}

function pinPraxisDeps(pkg, version) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (!pkg[section]) continue;
    for (const name of Object.keys(pkg[section])) {
      if (name.startsWith("@praxis/")) pkg[section][name] = version;
    }
  }
  delete pkg.private;
  return pkg;
}

function tgzBasename(npmName, version) {
  return `${npmName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function packSharedPackages(version, vendorDir) {
  mkdirSync(vendorDir, { recursive: true });
  const listed = [];
  const stageBase = mkdtempSync(join(tmpdir(), "praxis-shared-pack-"));
  try {
    for (const spec of SHARED_PACKAGES) {
      const src = join(root, spec.dir);
      const stage = join(stageBase, spec.npmName.replace(/[/@]/g, "-"));
      mkdirSync(stage, { recursive: true });
      const pkg = pinPraxisDeps(structuredClone(readJson(join(src, "package.json"))), version);
      pkg.files = spec.files;
      writeJson(join(stage, "package.json"), pkg);
      for (const f of ["README.md", "LICENSE"]) {
        if (existsSync(join(src, f))) {
          cpSync(join(src, f), join(stage, f));
        }
      }
      for (const rel of spec.files) {
        const from = join(src, rel);
        if (!existsSync(from)) {
          throw new Error(`missing ${spec.npmName} ${rel} — run npm run build`);
        }
        cpSync(from, join(stage, rel), { recursive: true });
      }
      const pack = run("npm pack --pack-destination .", stage);
      if (!pack.ok) {
        throw new Error(`npm pack ${spec.npmName}: ${pack.stderr || pack.stdout}`);
      }
      const tgz = readdirSync(stage).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error(`no tgz for ${spec.npmName}`);
      const destName = tgzBasename(spec.npmName, version);
      cpSync(join(stage, tgz), join(vendorDir, destName));
      listed.push({ npmName: spec.npmName, tgz: destName, version });
    }
  } finally {
    rmSync(stageBase, { recursive: true, force: true });
  }
  return listed;
}

function fileDep(tgzName) {
  return `file:./vendor/${tgzName}`;
}

function vendorDeps(version, extra = []) {
  const deps = {
    "@praxis/plugin-sdk": fileDep(tgzBasename("@praxis/plugin-sdk", version)),
    "@praxis/knowledge": fileDep(tgzBasename("@praxis/knowledge", version)),
    "@praxis/project-config": fileDep(tgzBasename("@praxis/project-config", version)),
  };
  if (extra.includes("contracts")) {
    deps["@praxis/contracts"] = fileDep(tgzBasename("@praxis/contracts", version));
  }
  return deps;
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

export function scanStandaloneLeaks(tree, monorepoRoot = root) {
  const leaks = [];
  const rootPosix = resolve(monorepoRoot).split(sep).join("/");
  const needles = [
    rootPosix,
    "../../packages/",
    "../../../packages/",
    "../../../plugins/",
    "../../plugins/",
    "..\\..\\packages\\",
    "..\\..\\..\\packages\\",
    "..\\..\\..\\plugins\\",
    "..\\..\\plugins\\",
  ];
  for (const file of walkFiles(tree)) {
    const rel = relative(tree, file).split(sep).join("/");
    if (rel.startsWith("vendor/") && rel.endsWith(".tgz")) continue;
    if (!/\.(mjs|cjs|js|ts|tsx|json|md)$/i.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const n of needles) {
      if (text.includes(n)) {
        leaks.push({ file: rel, needle: n });
      }
    }
  }
  const pkgFiles = walkFiles(tree).filter((f) => f.endsWith("package.json"));
  for (const pf of pkgFiles) {
    const rel = relative(tree, pf).split(sep).join("/");
    if (rel.startsWith("vendor/")) continue;
    const pkg = readJson(pf);
    for (const section of ["dependencies", "devDependencies"]) {
      for (const [name, range] of Object.entries(pkg[section] ?? {})) {
        if (name.startsWith("@praxis/") && range === "*") {
          leaks.push({ file: rel, needle: `${name}@*` });
        }
      }
    }
  }
  return leaks;
}

function writeStandaloneReadme(dest, component, version) {
  writeFileSync(
    join(dest, "STANDALONE.md"),
    `# Standalone ${component} (${version})

This tree is generated from the Praxis monorepo by \`npm run export:standalone\`.
Do not treat it as a second source of truth — change the monorepo and re-export.

Shared \`@praxis/*\` packages are vendored as version-pinned tgz files under \`vendor/\`
(not workspace \`*\` links). Public npm packages (vitest, zod, …) install from the registry.

`,
  );
}

function finalizeManifest(dest, component, version, vendor, extra = {}) {
  const files = walkFiles(dest).map((f) => relative(dest, f).split(sep).join("/")).sort();
  const manifest = {
    schemaVersion: STANDALONE_SCHEMA_VERSION,
    component,
    version,
    sourceCommit: sourceCommit(),
    generatedFrom: "praxis-monorepo",
    sharedDependencies: Object.fromEntries(
      vendor.map((v) => [v.npmName, v.version]),
    ),
    vendorPackages: vendor.map((v) => v.tgz).sort(),
    files: { count: files.length },
    ...extra,
  };
  writeJson(join(dest, "praxis-standalone-manifest.json"), manifest);
  return manifest;
}

function rewriteBaPackage(dest, version) {
  const pkg = readJson(join(dest, "package.json"));
  pkg.private = false;
  pkg.version = version;
  pkg.workspaces = ["canon-graph"];
  pkg.scripts = {
    build: "npm run build -w @praxis/ba-canon-graph",
    test: "npm run test -w @praxis/ba-canon-graph",
    typecheck: "npm run typecheck -w @praxis/ba-canon-graph",
    "session-bootstrap": "node ./tools/session-bootstrap.mjs",
  };
  pkg.bin = { "praxis-ba": "./canon-graph/bin/praxis-ba.mjs" };
  pkg.dependencies = vendorDeps(version);
  pkg.devDependencies = {
    vitest: "^3.2.4",
    typescript: "~5.8.3",
    "@types/node": "^22.20.0",
  };
  pkg.files = [
    ".claude-plugin",
    "hooks",
    "rules",
    "skills",
    "templates",
    "tools",
    "canon-graph/bin",
    "canon-graph/dist",
    "canon-graph/package.json",
    "vendor",
    "LICENSE",
    "README.md",
    "STANDALONE.md",
    "praxis-standalone-manifest.json",
  ];
  writeJson(join(dest, "package.json"), pkg);
  const cg = readJson(join(dest, "canon-graph/package.json"));
  cg.version = version;
  delete cg.private;
  writeJson(join(dest, "canon-graph/package.json"), cg);
}

function rewriteDeveloperPackage(dest, version) {
  const pkg = readJson(join(dest, "package.json"));
  pkg.private = false;
  pkg.version = version;
  pkg.scripts = {
    ...pkg.scripts,
    build: "node -e \"console.log('developer: no compile step')\"",
    "session-bootstrap": "node ./tools/session-bootstrap.mjs",
  };
  pkg.dependencies = vendorDeps(version, ["contracts"]);
  pkg.files = [
    ".claude-plugin",
    "agents",
    "hooks",
    "skills",
    "tools",
    "test",
    "vendor",
    "LICENSE",
    "README.md",
    "STANDALONE.md",
    "praxis-standalone-manifest.json",
  ];
  writeJson(join(dest, "package.json"), pkg);
}

/**
 * @param {"ba"|"developer"} component
 * @param {string} outDir
 */
export function exportStandalone(component, outDir) {
  if (component !== "ba" && component !== "developer") {
    throw new Error(`unknown component ${component}`);
  }
  const version = praxisVersion();
  const dest = resolve(outDir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const build = run(
    "npm run build -w @praxis/contracts -w @praxis/knowledge -w @praxis/project-config -w @praxis/plugin-sdk -w @praxis/ba-canon-graph",
  );
  if (!build.ok) {
    throw new Error(`prerequisite build failed:\n${build.stderr || build.stdout}`);
  }

  copyTree(join(root, "plugins", component), dest);
  const vendor = packSharedPackages(version, join(dest, "vendor"));

  if (component === "ba") {
    rewriteBaPackage(dest, version);
  } else {
    rewriteDeveloperPackage(dest, version);
  }

  writeStandaloneReadme(dest, component, version);
  writeFileSync(
    join(dest, ".gitignore"),
    "node_modules/\ncanon-graph/dist/\n*.log\n",
  );
  writeFileSync(
    join(dest, "PUBLICATION.md"),
    `# Remote publication (dry-run first)

Canonical name: praxis-${component}
Version: ${version} (unified with Praxis release)
Source of truth: Praxis monorepo \`npm run export:standalone -- ${component} <dir>\`

Do not create GitLab/GitHub repositories from this file automatically.

Dry-run from the monorepo:

\`\`\`bash
npm run publish:standalone-remote -- --component ${component} --dry-run
\`\`\`

Required before a real push (operator-owned):

1. Create empty remote \`praxis-${component}\` (explicit human permission).
2. Re-export this tree.
3. \`git remote add origin <url>\` && \`git push -u origin HEAD:main\`
4. Tag \`v${version}\` to match the monorepo release.

CI in this tree runs \`npm ci && npm test && npm pack\` only.
`,
  );
  mkdirSync(join(dest, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(dest, ".github/workflows/ci.yml"),
    `name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm pack
`,
  );

  const pluginJson = join(dest, ".claude-plugin/plugin.json");
  if (existsSync(pluginJson)) {
    const pj = readJson(pluginJson);
    pj.version = version;
    writeJson(pluginJson, pj);
  }

  const manifest = finalizeManifest(dest, component, version, vendor, {
    requiredAssets:
      component === "ba"
        ? ["tools/session-bootstrap.mjs", "canon-graph/bin/praxis-ba.mjs", "skills"]
        : ["tools/session-bootstrap.mjs", "tools/developer-governance.mjs", "skills"],
  });

  const leaks = scanStandaloneLeaks(dest);
  if (leaks.length) {
    throw new Error(
      `standalone leak scan failed:\n${leaks.map((l) => `${l.file}: ${l.needle}`).join("\n")}`,
    );
  }
  return { dest, manifest };
}

export { root };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const component = process.argv[2];
  const out = process.argv[3];
  if (!component || !out) {
    console.error("usage: export-standalone.mjs <ba|developer> <outdir>");
    process.exit(2);
  }
  const r = exportStandalone(component, out);
  console.log(JSON.stringify({ ok: true, dest: r.dest, manifest: r.manifest }, null, 2));
}
