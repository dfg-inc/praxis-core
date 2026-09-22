#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const dest = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist", "vendor", version);

const PACKAGES = [
  { npmName: "@praxis/contracts", dir: "packages/contracts", files: ["dist"] },
  { npmName: "@praxis/project-config", dir: "packages/project-config", files: ["dist"] },
  { npmName: "@praxis/knowledge", dir: "packages/knowledge", files: ["dist", "bin", "dataset"] },
  { npmName: "@praxis/catalog", dir: "packages/catalog", files: ["dist", "catalog.json"] },
  { npmName: "@praxis/testing", dir: "packages/testing", files: ["dist"] },
  { npmName: "@praxis/jira", dir: "plugins/jira", files: ["dist", "tools", "skills", ".claude-plugin", "README.md"] },
  { npmName: "@praxis/vcs", dir: "plugins/vcs", files: ["dist", "README.md"] },
  { npmName: "@praxis/cli", dir: "packages/cli", files: ["dist", "bin", "README.md"] },
  { npmName: "@praxis/plugin-sdk", dir: "packages/plugin-sdk", files: ["dist", "bin"] },
];

function fail(msg) {
  console.error(`pack-core-vendor: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) fail(`${cmd}\n${r.stderr || r.stdout}`);
}

function tgzBasename(npmName) {
  return `${npmName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function pinPraxisDeps(pkg) {
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!pkg[section]) continue;
    for (const name of Object.keys(pkg[section])) {
      if (name.startsWith("@praxis/")) pkg[section][name] = version;
    }
  }
  delete pkg.private;
  return pkg;
}

mkdirSync(dest, { recursive: true });
const stageBase = mkdtempSync(join(tmpdir(), "praxis-core-pack-"));
const listed = [];
for (const spec of PACKAGES) {
  const src = join(root, spec.dir);
  const stage = join(stageBase, spec.npmName.replace(/[/@]/g, "-"));
  mkdirSync(stage, { recursive: true });
  const pkg = pinPraxisDeps(
    structuredClone(JSON.parse(readFileSync(join(src, "package.json"), "utf8"))),
  );
  pkg.files = spec.files;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const f of ["README.md", "LICENSE"]) {
    if (existsSync(join(src, f))) cpSync(join(src, f), join(stage, f));
  }
  for (const rel of spec.files) {
    const from = join(src, rel);
    if (!existsSync(from)) fail(`missing ${spec.npmName} ${rel} — run npm run build`);
    cpSync(from, join(stage, rel), { recursive: true });
  }
  run("npm pack --pack-destination .", stage);
  const tgz = tgzBasename(spec.npmName);
  if (!existsSync(join(stage, tgz))) fail(`pack did not write ${tgz}`);
  cpSync(join(stage, tgz), join(dest, tgz));
  listed.push({ npmName: spec.npmName, file: tgz });
}
writeFileSync(join(dest, "manifest.json"), `${JSON.stringify({ version, packages: listed }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, dest, packages: listed }, null, 2));
