#!/usr/bin/env node
/**
 * Machine handoff chain regression:
 *   BA approve-plan → ba.architect.handoff
 *   → Architect emit-developer-handoff (change-spec + architect.developer.handoff)
 *   → Developer accept-work-package
 *
 * Also covers negative Developer intake cases.
 *
 * Usage (monorepo root):
 *   node tools/scripts/machine-handoff-chain.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const smokeDir = join(root, "tools/smoke");
const productSrc = join(root, "samples/mini-counter");
const wpId = "WP-20260825-002";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(label, cmd, cwd) {
  console.log(`\n=== ${label} ===\n$ ${cmd}`);
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
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
  throw new Error("no JSON output found");
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const work = mkdtempSync(join(tmpdir(), "praxis-handoff-chain-"));
cpSync(join(smokeDir, "canon"), join(work, "canon"), { recursive: true });
cpSync(productSrc, join(work, "product"), { recursive: true });

const canon = join(work, "canon");
const product = join(work, "product");
const designRoot = join(work, "design");
const designDir = join(designRoot, wpId);

const baBin = join(root, "plugins/ba/canon-graph/bin/praxis-ba.mjs");
const emitDev = join(root, "plugins/architect/tools/emit-developer-handoff.mjs");
const acceptDev = join(root, "plugins/developer/tools/accept-work-package.mjs");

// --- BA: ensure plan-approved + machine handoff via approve-plan path ---
// Smoke fixture WP is already plan-approved; set ready and re-approve to prove emit.
{
  const wpIndex = join(canon, "wp", wpId, "index.md");
  let body = readFileSync(wpIndex, "utf8");
  body = body.replace(/status:\s*plan-approved/, "status: ready");
  // strip plan: if present so approve can set it
  body = body.replace(/^plan:.*$/m, "");
  writeFileSync(wpIndex, body);
  if (!existsSync(join(canon, "wp", wpId, "plan.md"))) {
    write(join(canon, "wp", wpId, "plan.md"), `# Plan\n\nFix increment.\n`);
  }
}

const validate = run(
  "BA validate",
  `${process.execPath} ${baBin} validate --repo ${canon}`,
  work,
);
if (!validate.ok) fail("BA validate failed");

const approve = run(
  "BA approve-plan (emits ba.architect.handoff)",
  `${process.execPath} ${baBin} wp approve-plan --repo ${canon} --wp ${wpId} --plan wp/${wpId}/plan.md --json`,
  work,
);
if (!approve.ok) fail(`approve-plan failed:\n${approve.stdout}\n${approve.stderr}`);
const approveJson = parseLastJson(approve.stdout);
const baHandoffPath =
  approveJson.handoffPath ??
  join(canon, "wp", wpId, "handoffs", "ba-architect.handoff.json");
if (!existsSync(baHandoffPath)) fail(`BA handoff missing at ${baHandoffPath}`);
const baHandoff = JSON.parse(readFileSync(baHandoffPath, "utf8"));
if (baHandoff.contract !== "ba.architect.handoff") {
  fail(`bad BA contract: ${baHandoff.contract}`);
}

// --- Architect interactive-shaped package (markdown + change-intent, no pre-made handoff) ---
const changeIntent = JSON.parse(
  readFileSync(join(smokeDir, "change-spec.json"), "utf8"),
);
// Rename ADR to ADR-001 style for counter acceptance narrative
changeIntent.decisionIds = ["ADR-001"];
write(
  join(designDir, "index.md"),
  `# Design package — ${wpId}\n\n## Purpose\n\nIncrement by one.\n`,
);
write(
  join(designDir, "decisions.md"),
  `| ADR-001 | Single-step increment | ADR-001.md | n += 1 |\n`,
);
write(
  join(designDir, "ADR-001.md"),
  `# ADR-001\n\n## Decision\n\nChange inc() to n += 1.\n`,
);
write(
  join(designDir, "contracts.md"),
  `# Contracts\n\nNone — single module.\n`,
);
write(
  join(designDir, "nfr-budgets.md"),
  `# NFR budgets\n\nNone for this slice.\n`,
);
write(
  join(designDir, "context-slice.md"),
  `---
workPackageId: ${wpId}
designPackagePath: design/${wpId}/
decisionIds: [ADR-001]
generated: 2026-08-31
---

# Context slice — ${wpId}

## In slice
- \`src/counter.js\`
- \`test/counter.test.js\`
- ADR-001

## Out of slice
- Unrelated marketplace surfaces

## Non-negotiables
- Apply change-intent only within allowed scope.
`,
);
write(join(designDir, "change-intent.json"), JSON.stringify(changeIntent, null, 2));

const emit = run(
  "Architect emit-developer-handoff",
  `${process.execPath} ${emitDev} --ba-handoff ${baHandoffPath} --design-dir ${designDir} --out ${designRoot} --product ${product}`,
  work,
);
if (!emit.ok) fail(`emit-developer-handoff failed:\n${emit.stderr}`);
const emitJson = parseLastJson(emit.stdout);
if (!existsSync(join(designDir, "change-spec.json"))) fail("change-spec.json missing");
if (!existsSync(join(designDir, "architect-developer.handoff.json"))) {
  fail("architect-developer.handoff.json missing");
}
const archHandoff = JSON.parse(
  readFileSync(join(designDir, "architect-developer.handoff.json"), "utf8"),
);
if (archHandoff.contract !== "architect.developer.handoff") {
  fail(`bad arch contract: ${archHandoff.contract}`);
}
if (!archHandoff.features?.every((f) => f.readyForDev === true)) {
  fail("features must be readyForDev");
}
if (!archHandoff.decisionIds?.includes("ADR-001")) fail("ADR-001 missing on handoff");

const changeSpec = JSON.parse(readFileSync(join(designDir, "change-spec.json"), "utf8"));
if (!changeSpec.changes?.some((c) => c.file === "src/counter.js")) {
  fail("change-spec must include src/counter.js");
}

// --- Developer accept PASS ---
const acceptOk = run(
  "Developer accept-work-package (PASS)",
  `${process.execPath} ${acceptDev} --arch-handoff ${emitJson.handoffPath} --design-dir ${designDir}`,
  work,
);
if (!acceptOk.ok) fail(`accept should PASS:\n${acceptOk.stdout}\n${acceptOk.stderr}`);
const acceptJson = parseLastJson(acceptOk.stdout);
if (acceptJson.status !== "accepted") fail(`expected accepted, got ${acceptJson.status}`);

// --- Negatives ---
function expectReturn(label, handoffPath, designOverride) {
  const r = run(
    label,
    `${process.execPath} ${acceptDev} --arch-handoff ${handoffPath} --design-dir ${designOverride ?? designDir}`,
    work,
  );
  if (r.ok) fail(`${label}: expected return/fail`);
  const j = parseLastJson(r.stdout);
  if (j.status !== "returned") fail(`${label}: expected returned`);
  return j;
}

// missing handoff
{
  const missing = join(work, "no-such-handoff.json");
  const r = run(
    "negative: missing handoff",
    `${process.execPath} ${acceptDev} --arch-handoff ${missing} --design-dir ${designDir}`,
    work,
  );
  if (r.ok) fail("missing handoff should fail");
}

// missing change-spec
{
  const negDir = join(work, "neg-no-spec");
  mkdirSync(negDir, { recursive: true });
  cpSync(join(designDir, "architect-developer.handoff.json"), join(negDir, "architect-developer.handoff.json"));
  write(join(negDir, "index.md"), "# x\n");
  write(join(negDir, "context-slice.md"), "## In slice\n\n## Out of slice\n\n## Non-negotiables\n");
  expectReturn(
    "negative: missing change-spec",
    join(negDir, "architect-developer.handoff.json"),
    negDir,
  );
}

// readyForDev false
{
  const negDir = join(work, "neg-ready");
  mkdirSync(negDir, { recursive: true });
  const bad = structuredClone(archHandoff);
  bad.features = [{ id: "F1", title: "x", readyForDev: false }];
  write(join(negDir, "architect-developer.handoff.json"), JSON.stringify(bad, null, 2));
  write(join(negDir, "change-spec.json"), JSON.stringify(changeSpec, null, 2));
  write(join(negDir, "index.md"), "# x\n");
  write(join(negDir, "context-slice.md"), "## In slice\n\n## Out of slice\n\n## Non-negotiables\n");
  const j = expectReturn(
    "negative: readyForDev false",
    join(negDir, "architect-developer.handoff.json"),
    negDir,
  );
  if (!j.blockers.some((b) => /readyForDev/i.test(b))) {
    fail("expected readyForDev blocker");
  }
}

// invalid contract
{
  const negDir = join(work, "neg-contract");
  mkdirSync(negDir, { recursive: true });
  const bad = { ...archHandoff, contract: "not.a.contract" };
  write(join(negDir, "architect-developer.handoff.json"), JSON.stringify(bad, null, 2));
  write(join(negDir, "change-spec.json"), JSON.stringify(changeSpec, null, 2));
  write(join(negDir, "index.md"), "# x\n");
  write(join(negDir, "context-slice.md"), "## In slice\n\n## Out of slice\n\n## Non-negotiables\n");
  const j = expectReturn(
    "negative: invalid contract",
    join(negDir, "architect-developer.handoff.json"),
    negDir,
  );
  if (!j.blockers.some((b) => /invalid contract/i.test(b))) {
    fail("expected invalid contract blocker");
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      work,
      baHandoffPath,
      baContract: baHandoff.contract,
      archHandoffPath: emitJson.handoffPath,
      archContract: archHandoff.contract,
      changeSpecPath: emitJson.changeSpecPath,
      accept: acceptJson.status,
      negatives: ["missing-handoff", "missing-change-spec", "readyForDev-false", "invalid-contract"],
    },
    null,
    2,
  ),
);

rmSync(work, { recursive: true, force: true });
