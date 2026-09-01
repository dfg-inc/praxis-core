#!/usr/bin/env node
/**
 * External .tgz acceptance: BA → Architect → Developer machine handoff chain.
 *
 * Packs staged plugins, installs into a temp consumer OUTSIDE the monorepo
 * workspace, then:
 *   approve-plan → ba.architect.handoff
 *   emit-developer-handoff → change-spec + architect.developer.handoff
 *   accept-work-package → PASS
 *   negatives → returned
 *
 * Usage:
 *   node tools/scripts/machine-handoff-external-acceptance.mjs [--rebuild]
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
const smokeDir = join(root, "tools/smoke");
const productSrc = join(root, "samples/mini-counter");
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

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
}

if (rebuild || !existsSync(join(mirror, "plugins/ba/bin/praxis-ba.cjs"))) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}

const PLUGIN_IDS = ["ba", "architect", "developer"];
for (const id of PLUGIN_IDS) {
  if (!existsSync(join(mirror, "plugins", id))) fail(`missing staged plugin ${id}`);
}

const packBase = mkdtempSync(join(tmpdir(), "praxis-handoff-pack-"));
const tgzPaths = [];
for (const id of PLUGIN_IDS) {
  const dest = join(packBase, id);
  cpSync(join(mirror, "plugins", id), dest, { recursive: true });
  const pack = run("npm pack", dest);
  if (!pack.ok) fail(`npm pack ${id}: ${pack.stderr}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail(`no .tgz for ${id}`);
  tgzPaths.push(join(dest, tgz));
  console.log(`packed ${id}: ${tgz}`);
}

const consumer = mkdtempSync(join(tmpdir(), "praxis-handoff-ext-"));
write(join(consumer, "package.json"), { name: "praxis-handoff-ext", private: true });
const install = run(`npm install ${tgzPaths.map((p) => `"${p}"`).join(" ")}`, consumer);
if (!install.ok) fail(`npm install failed:\n${install.stderr}`);

const baRoot = join(consumer, "node_modules/@praxis/ba");
const archRoot = join(consumer, "node_modules/@praxis/architect");
const devRoot = join(consumer, "node_modules/@praxis/developer");
const baCli = join(baRoot, "bin/praxis-ba.cjs");
const emitDev = join(archRoot, "tools/emit-developer-handoff.mjs");
const acceptDev = join(devRoot, "tools/accept-work-package.mjs");

for (const p of [baCli, emitDev, acceptDev, join(archRoot, "tools/lib/architecture-package.mjs")]) {
  if (!existsSync(p)) fail(`missing installed path ${p}`);
}

const project = join(consumer, "ext-project");
cpSync(join(smokeDir, "canon"), join(project, "canon"), { recursive: true });
cpSync(productSrc, join(project, "product"), { recursive: true });

const canon = join(project, "canon");
const product = join(project, "product");
const designRoot = join(project, "design");
const designDir = join(designRoot, wpId);

// Reset WP to ready so approve-plan emits handoff.
{
  const wpIndex = join(canon, "wp", wpId, "index.md");
  let body = readFileSync(wpIndex, "utf8");
  body = body.replace(/status:\s*\S+/, "status: ready");
  body = body.replace(/^plan:.*\n/m, "");
  writeFileSync(wpIndex, body);
}

const approve = run(
  `node "${baCli}" wp approve-plan --repo "${canon}" --wp ${wpId} --plan wp/${wpId}/plan.md --json`,
  project,
);
if (!approve.ok) fail(`approve-plan failed:\n${approve.stdout}\n${approve.stderr}`);
const approveJson = parseLastJson(approve.stdout);
const baHandoffPath =
  approveJson.handoffPath ??
  join(canon, "wp", wpId, "handoffs", "ba-architect.handoff.json");
if (!existsSync(baHandoffPath)) fail(`BA handoff missing: ${baHandoffPath}`);

const changeIntent = JSON.parse(readFileSync(join(smokeDir, "change-spec.json"), "utf8"));
changeIntent.decisionIds = ["ADR-001"];
write(join(designDir, "index.md"), `# Design — ${wpId}\n`);
write(join(designDir, "decisions.md"), `| ADR-001 | inc by one | ADR-001.md |\n`);
write(join(designDir, "ADR-001.md"), `# ADR-001\n\n## Decision\nn += 1\n`);
write(
  join(designDir, "context-slice.md"),
  `---\nworkPackageId: ${wpId}\ndecisionIds: [ADR-001]\n---\n\n# Context slice\n\n## In slice\n- src/counter.js\n\n## Out of slice\n- other\n\n## Non-negotiables\n- scope only\n`,
);
write(join(designDir, "change-intent.json"), changeIntent);

const emit = run(
  `node "${emitDev}" --ba-handoff "${baHandoffPath}" --design-dir "${designDir}" --out "${designRoot}" --product "${product}"`,
  project,
);
if (!emit.ok) fail(`emit-developer-handoff failed:\n${emit.stderr}`);
const emitJson = parseLastJson(emit.stdout);
if (!existsSync(join(designDir, "change-spec.json"))) fail("change-spec missing");
if (!existsSync(join(designDir, "architect-developer.handoff.json"))) {
  fail("architect-developer.handoff missing");
}

const accept = run(
  `node "${acceptDev}" --arch-handoff "${emitJson.handoffPath}" --design-dir "${designDir}"`,
  project,
);
if (!accept.ok) fail(`Developer accept should PASS:\n${accept.stdout}\n${accept.stderr}`);
const acceptJson = parseLastJson(accept.stdout);
if (acceptJson.status !== "accepted") fail(`expected accepted, got ${acceptJson.status}`);

// Negative: invalid contract
{
  const neg = join(project, "neg-contract");
  mkdirSync(neg, { recursive: true });
  const bad = {
    ...JSON.parse(readFileSync(emitJson.handoffPath, "utf8")),
    contract: "bogus",
  };
  write(join(neg, "architect-developer.handoff.json"), bad);
  write(join(neg, "change-spec.json"), readFileSync(join(designDir, "change-spec.json"), "utf8"));
  write(join(neg, "index.md"), "# x\n");
  write(join(neg, "context-slice.md"), "## In slice\n\n## Out of slice\n\n## Non-negotiables\n");
  const r = run(
    `node "${acceptDev}" --arch-handoff "${join(neg, "architect-developer.handoff.json")}" --design-dir "${neg}"`,
    project,
  );
  if (r.ok) fail("invalid contract should return");
  const j = parseLastJson(r.stdout);
  if (j.status !== "returned") fail("expected returned for invalid contract");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      consumer,
      baHandoffPath,
      archHandoffPath: emitJson.handoffPath,
      changeSpecPath: emitJson.changeSpecPath,
      accept: acceptJson.status,
      source: "external-tgz",
    },
    null,
    2,
  ),
);

rmSync(packBase, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
