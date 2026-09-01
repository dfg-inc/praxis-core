#!/usr/bin/env node
/**
 * External .tgz acceptance: edit+create change-spec through packaged plugins.
 *
 * Usage:
 *   node tools/scripts/machine-edit-create-external-acceptance.mjs [--rebuild]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildAllPluginArtifacts } from "./package-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mirror = join(root, "dist/release-mirror");
const fixture = join(root, "tools/e2e/fixtures/edit-create");
const smokeCanon = join(root, "tools/smoke/canon");
const rebuild = process.argv.includes("--rebuild");
const wpId = "WP-20260825-002";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function parseLastJson(text) {
  const chunks = text.split(/\n(?=\{)/);
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(chunks[i]);
    } catch {
      /* continue */
    }
  }
  throw new Error(`no JSON in:\n${text}`);
}

if (rebuild || !existsSync(join(mirror, "plugins/ba/bin/praxis-ba.cjs"))) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}

const PLUGIN_IDS = ["ba", "architect", "developer"];
const packBase = mkdtempSync(join(tmpdir(), "praxis-ec-pack-"));
const tgzPaths = [];
for (const id of PLUGIN_IDS) {
  const dest = join(packBase, id);
  cpSync(join(mirror, "plugins", id), dest, { recursive: true });
  const pack = run("npm pack", dest);
  if (!pack.ok) fail(`npm pack ${id}: ${pack.stderr}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail(`no .tgz for ${id}`);
  tgzPaths.push(join(dest, tgz));
}

const consumer = mkdtempSync(join(tmpdir(), "praxis-ec-ext-"));
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ name: "praxis-ec-ext", private: true }, null, 2),
);
const install = run(`npm install ${tgzPaths.map((p) => `"${p}"`).join(" ")}`, consumer);
if (!install.ok) fail(`npm install failed:\n${install.stderr}`);

const baCli = join(consumer, "node_modules/@praxis/ba/bin/praxis-ba.cjs");
const archTool = join(
  consumer,
  "node_modules/@praxis/architect/tools/build-architecture-package.mjs",
);
const runWp = join(
  consumer,
  "node_modules/@praxis/developer/tools/run-work-package.mjs",
);
const applyLib = join(
  consumer,
  "node_modules/@praxis/developer/tools/lib/apply-change-spec.mjs",
);
if (!existsSync(applyLib)) fail("apply-change-spec.mjs missing from package");

const project = join(consumer, "ext-project");
cpSync(smokeCanon, join(project, "canon"), { recursive: true });
cpSync(join(fixture, "product"), join(project, "product"), { recursive: true });
cpSync(join(fixture, "change-spec.json"), join(project, "change-spec.json"));

const canon = join(project, "canon");
const product = join(project, "product");
const design = join(project, "design");
{
  const wpIndex = join(canon, "wp", wpId, "index.md");
  let body = readFileSync(wpIndex, "utf8");
  body = body.replace(/status:\s*\S+/, "status: plan-approved");
  writeFileSync(wpIndex, body);
}

const emit = run(
  `node "${join(consumer, "node_modules/@praxis/ba/tools/emit-architect-handoff.mjs")}" --repo "${canon}" --wp ${wpId}`,
  project,
);
if (!emit.ok) fail(`BA emit failed:\n${emit.stderr}`);
const baJson = parseLastJson(emit.stdout);

const arch = run(
  `node "${archTool}" --ba-handoff "${baJson.path}" --canon "${canon}" --out "${design}" --product "${product}" --change-spec "${join(project, "change-spec.json")}"`,
  project,
);
if (!arch.ok) fail(`Architect failed:\n${arch.stderr}`);
const archJson = parseLastJson(arch.stdout);

const cs = JSON.parse(readFileSync(join(archJson.designDir, "change-spec.json"), "utf8"));
if (!cs.changes.some((c) => c.op === "create")) fail("packaged change-spec missing create");

const impl = run(
  `node "${runWp}" --arch-handoff "${archJson.handoffPath}" --design-dir "${archJson.designDir}" --product "${product}" --approve`,
  project,
);
if (!impl.ok) fail(`Developer failed:\n${impl.stderr}\n${impl.stdout}`);
const implJson = parseLastJson(impl.stdout);
if (!implJson.qualityHandoff?.verification?.tests) fail("tests not verified");
if (!existsSync(join(product, "test/widget.test.js"))) fail("test file missing");

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "external-tgz",
      verification: implJson.qualityHandoff.verification,
      created: "test/widget.test.js",
    },
    null,
    2,
  ),
);

rmSync(packBase, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
