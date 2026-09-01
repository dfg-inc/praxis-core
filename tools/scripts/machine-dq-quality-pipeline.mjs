#!/usr/bin/env node
/**
 * Developer → Quality handoff / artifact regressions (A–G).
 *
 * Proves:
 * A. quality-handoff includes correct workPackageId
 * B. handoff validates against DeveloperToQualityHandoffSchema
 * C. skipped build/lint ≠ passed
 * D. required failing test cannot emit Quality handoff
 * E. acceptance.md materializes decisions/NFRs/boundaries from slice
 * F. plan-status frontmatter has no duplicate keys after phase transitions
 * G. WP id mismatch prevents handoff
 *
 * Usage: node tools/scripts/machine-dq-quality-pipeline.mjs
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
import {
  DeveloperToQualityHandoffSchema,
  parseContract,
  verificationCheckFromArbiterStep,
  computePackageCriteria,
} from "../../packages/contracts/dist/index.js";
import {
  assertNoDuplicateFrontmatterKeys,
  findDuplicateFrontmatterKeys,
  splitFrontmatter,
  upsertFrontmatter,
} from "../../plugins/developer/tools/lib/frontmatter.mjs";
import { assertDeveloperReadyForQuality } from "../../plugins/developer/tools/lib/readiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "tools/e2e/fixtures/edit-create");
const smokeCanon = join(root, "tools/smoke/canon");
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

// Unit: duplicate frontmatter detection + upsert replaces
{
  const bad = `---\ncurrentPhase: 1\nstatus: x\ncurrentPhase: 3\n---\n\nbody\n`;
  const dups = findDuplicateFrontmatterKeys(splitFrontmatter(bad).frontmatter);
  if (!dups.includes("currentPhase")) fail("F: detector must find duplicate currentPhase");
  const fixed = upsertFrontmatter(bad, { currentPhase: 3, status: "complete" });
  assertNoDuplicateFrontmatterKeys(fixed, "upsert");
  if (findDuplicateFrontmatterKeys(splitFrontmatter(fixed).frontmatter).length) {
    fail("F: upsert must eliminate duplicates");
  }
}

const work = mkdtempSync(join(tmpdir(), "praxis-dq-"));
cpSync(smokeCanon, join(work, "canon"), { recursive: true });
cpSync(join(fixture, "product"), join(work, "product"), { recursive: true });
cpSync(join(fixture, "change-spec.json"), join(work, "change-spec.json"));

const canon = join(work, "canon");
const product = join(work, "product");
const designRoot = join(work, "design");
const designDir = join(designRoot, wpId);

{
  const wpIndex = join(canon, "wp", wpId, "index.md");
  let body = readFileSync(wpIndex, "utf8");
  if (!/status:\s*plan-approved/.test(body)) {
    body = body.replace(/status:\s*\S+/, "status: plan-approved");
    writeFileSync(wpIndex, body);
  }
}

const emitBa = join(root, "plugins/ba/tools/emit-architect-handoff.mjs");
const archTool = join(root, "plugins/architect/tools/build-architecture-package.mjs");
const runWp = join(root, "plugins/developer/tools/run-work-package.mjs");

const baOut = run(
  "BA emit",
  `${process.execPath} ${emitBa} --repo ${canon} --wp ${wpId}`,
  work,
);
if (!baOut.ok) fail("BA emit failed");
const baJson = parseLastJson(baOut.stdout);

const archOut = run(
  "Architect build",
  `${process.execPath} ${archTool} --ba-handoff ${baJson.path} --canon ${canon} --out ${designRoot} --product ${product} --change-spec ${join(work, "change-spec.json")}`,
  work,
);
if (!archOut.ok) fail(`Architect failed:\n${archOut.stderr}`);
const archJson = parseLastJson(archOut.stdout);

// Enrich slice with acceptance-case-like content (no invention in production — fixture for regression)
writeFileSync(
  join(designDir, "context-slice.md"),
  `# Context slice — ${wpId}

## In slice

### Decisions
| id | path | rule |
| ADR-EDITCREATE-001 | ${wpId}/ADR-EDITCREATE-001.md | Use node:test / node:assert |

### Contracts
None

### NFR budgets
| metric | limit | verify when | path |
| CTR-NFR-002 | public API covered by automated tests | npm test | nfr/CTR-NFR-002.md |

### Must-read
- \`src/widget.js\` — required

## Out of slice

- Unrelated products
- External test frameworks (Jest/Vitest)

## Non-negotiables

- Node built-in test runner only

## Open items

None
`,
);

const impl = run(
  "Developer implement",
  `${process.execPath} ${runWp} --arch-handoff ${archJson.handoffPath} --design-dir ${designDir} --product ${product} --approve`,
  work,
);
if (!impl.ok) fail(`Developer failed:\n${impl.stderr}\n${impl.stdout}`);
const implJson = parseLastJson(impl.stdout);
const qh = implJson.qualityHandoff;
const qPath = implJson.qualityHandoffPath;

// A
if (qh.workPackageId !== wpId) fail(`A: workPackageId=${qh.workPackageId}`);
if (!existsSync(qPath)) fail("A: quality-handoff path missing");
const onDisk = JSON.parse(readFileSync(qPath, "utf8"));
if (onDisk.workPackageId !== wpId) fail("A: on-disk handoff missing workPackageId");

// B
parseContract(DeveloperToQualityHandoffSchema, onDisk);

// C — skipped must never be encoded as passed (compare to arbiter)
{
  const arb = JSON.parse(
    readFileSync(join(designDir, "developer-run", "arbiter.json"), "utf8"),
  );
  for (const r of arb.results ?? []) {
    const key = r.label === "test" ? "tests" : r.label;
    const v = qh.verification[key];
    if (!v) fail(`C: missing verification.${key}`);
    if (r.skipped) {
      if (v.status === "passed") {
        fail(`C: arbiter skipped ${r.label} but handoff status=passed`);
      }
      if (v.status !== "skipped" && !v.required) {
        fail(`C: expected skipped for ${r.label}, got ${v.status}`);
      }
    } else if (r.ok) {
      if (v.status !== "passed") {
        fail(`C: arbiter passed ${r.label} but handoff status=${v.status}`);
      }
    } else if (v.status !== "failed") {
      fail(`C: arbiter failed ${r.label} but handoff status=${v.status}`);
    }
  }
  // At least one required check must be a real executed pass for this fixture
  if (qh.verification.tests.status !== "passed") {
    fail("C: tests must be executed passed for this fixture");
  }
}

// E
const acceptance = readFileSync(implJson.acceptancePath, "utf8");
if (!/ADR-EDITCREATE-001/.test(acceptance)) fail("E: decisions not materialized");
if (!/CTR-NFR-002/.test(acceptance)) fail("E: NFR budgets not materialized");
if (!/External test frameworks/.test(acceptance)) {
  fail("E: out-of-slice boundaries not materialized");
}
if (!/## Residual opens\nNone/i.test(acceptance) && !/## Residual opens\n\nNone/i.test(acceptance)) {
  // allow whitespace variants
  if (!/Residual opens[\s\S]*None/.test(acceptance)) {
    fail("E: residual opens should say None");
  }
}

// F
const planStatus = readFileSync(implJson.planStatusPath, "utf8");
assertNoDuplicateFrontmatterKeys(planStatus, implJson.planStatusPath);
const fm = splitFrontmatter(planStatus).frontmatter;
if (findDuplicateFrontmatterKeys(fm).length) fail("F: duplicate keys after phases");
if (!/phasesComplete:\s*true/.test(fm)) fail("F: phasesComplete not true");

// C2 — unit: arbiter skipped never maps to passed
{
  const skipped = verificationCheckFromArbiterStep(
    { ok: true, skipped: true },
    false,
  );
  if (skipped.status !== "skipped") fail("C2: skipped step must map to skipped");
  if (skipped.status === "passed") fail("C2: skipped must not be passed");
  const pc = computePackageCriteria(
    skipped,
    { status: "passed", required: true },
    skipped,
  );
  if (pc.status !== "passed") fail("C2: packageCriteria with skipped non-required");
}
{
  const brokenProduct = join(work, "product-broken");
  cpSync(join(fixture, "product"), brokenProduct, { recursive: true });
  const brokenDesignRoot = join(work, "design-broken");
  const brokenBuild = run(
    "Arch for failing-test case",
    `${process.execPath} ${archTool} --ba-handoff ${baJson.path} --canon ${canon} --out ${brokenDesignRoot} --product ${brokenProduct} --change-spec ${join(work, "change-spec.json")}`,
    work,
  );
  if (!brokenBuild.ok) fail("broken arch build failed");
  const brokenArch = parseLastJson(brokenBuild.stdout);
  writeFileSync(
    join(brokenArch.designDir, "context-slice.md"),
    readFileSync(join(designDir, "context-slice.md"), "utf8"),
  );
  const csPath = join(brokenArch.designDir, "change-spec.json");
  const cs = JSON.parse(readFileSync(csPath, "utf8"));
  const createIdx = cs.changes.findIndex((c) => c.op === "create");
  cs.changes[createIdx].content = cs.changes[createIdx].content.replace(
    "assert.equal(scale(5), 10)",
    "assert.equal(scale(5), 999)",
  );
  writeFileSync(csPath, JSON.stringify(cs, null, 2) + "\n");
  const failTest = run(
    "D: failing test must not emit Quality handoff",
    `${process.execPath} ${runWp} --arch-handoff ${brokenArch.handoffPath} --design-dir ${brokenArch.designDir} --product ${brokenProduct} --approve --max-repairs 0`,
    work,
  );
  if (failTest.ok) fail("D: Developer must not PASS when tests fail");
  const badQ = join(brokenArch.designDir, "dev", "quality-handoff.json");
  if (existsSync(badQ)) fail("D: quality-handoff must not be written on failure");
}

// G — WP id mismatch prevents handoff
{
  const gate = assertDeveloperReadyForQuality({
    workPackageId: wpId,
    designDir,
    acceptancePath: implJson.acceptancePath,
    planStatusPath: implJson.planStatusPath,
    verification: qh.verification,
    qualityHandoff: { ...qh, workPackageId: "WP-WRONG" },
  });
  if (gate.ok) fail("G: mismatch workPackageId must fail readiness");
  if (!gate.blockers.some((b) => /mismatch/i.test(b))) {
    fail(`G: expected mismatch blocker, got ${gate.blockers.join("; ")}`);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      workPackageId: qh.workPackageId,
      verification: qh.verification,
      proven: [
        "A workPackageId",
        "B schema valid",
        "C skipped≠passed",
        "C2 skipped build/lint",
        "D failing test no handoff",
        "E acceptance materialized",
        "F no duplicate frontmatter",
        "G WP mismatch gate",
      ],
    },
    null,
    2,
  ),
);

rmSync(work, { recursive: true, force: true });
