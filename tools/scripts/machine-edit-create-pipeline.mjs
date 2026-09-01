#!/usr/bin/env node
/**
 * E2E: Architect change-spec with edit + create → Developer run-work-package.
 *
 * Proves:
 * - create new test file + edit existing source + package.json
 * - idempotent re-run
 * - conflicting create fails
 * - incomplete requiredMachineFiles refuses emit readyForDev
 * - failed npm test refuses Developer PASS
 *
 * Usage (monorepo root):
 *   node tools/scripts/machine-edit-create-pipeline.mjs
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

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n",
  );
}

const work = mkdtempSync(join(tmpdir(), "praxis-edit-create-"));
cpSync(smokeCanon, join(work, "canon"), { recursive: true });
cpSync(join(fixture, "product"), join(work, "product"), { recursive: true });
cpSync(join(fixture, "change-spec.json"), join(work, "change-spec.json"));

const canon = join(work, "canon");
const product = join(work, "product");
const designRoot = join(work, "design");
const designDir = join(designRoot, wpId);

const baBin = join(root, "plugins/ba/canon-graph/bin/praxis-ba.mjs");
const emitBa = join(root, "plugins/ba/tools/emit-architect-handoff.mjs");
const archTool = join(root, "plugins/architect/tools/build-architecture-package.mjs");
const emitDev = join(root, "plugins/architect/tools/emit-developer-handoff.mjs");
const acceptDev = join(root, "plugins/developer/tools/accept-work-package.mjs");
const runWp = join(root, "plugins/developer/tools/run-work-package.mjs");

// Ensure WP plan-approved for BA emit
{
  const wpIndex = join(canon, "wp", wpId, "index.md");
  let body = readFileSync(wpIndex, "utf8");
  if (!/status:\s*plan-approved/.test(body)) {
    body = body.replace(/status:\s*\S+/, "status: plan-approved");
    writeFileSync(wpIndex, body);
  }
}

const baOut = run(
  "BA emit handoff",
  `${process.execPath} ${emitBa} --repo ${canon} --wp ${wpId}`,
  work,
);
if (!baOut.ok) fail("BA emit failed");
const baJson = parseLastJson(baOut.stdout);

const archOut = run(
  "Architect build package (edit+create change-spec)",
  `${process.execPath} ${archTool} --ba-handoff ${baJson.path} --canon ${canon} --out ${designRoot} --product ${product} --change-spec ${join(work, "change-spec.json")}`,
  work,
);
if (!archOut.ok) fail(`Architect build failed:\n${archOut.stderr}`);
const archJson = parseLastJson(archOut.stdout);
const changeSpec = JSON.parse(readFileSync(join(designDir, "change-spec.json"), "utf8"));
if (!changeSpec.changes.some((c) => c.op === "create")) {
  fail("change-spec must include a create operation");
}
if (!changeSpec.changes.some((c) => c.op === "edit" && c.file === "src/widget.js")) {
  fail("change-spec must edit src/widget.js");
}
if (!changeSpec.changes.some((c) => c.file === "package.json")) {
  fail("change-spec must update package.json");
}

const accept = run(
  "Developer accept",
  `${process.execPath} ${acceptDev} --arch-handoff ${archJson.handoffPath} --design-dir ${designDir}`,
  work,
);
if (!accept.ok) fail("accept should PASS");

const pending = run(
  "Developer run without --approve (gate)",
  `${process.execPath} ${runWp} --arch-handoff ${archJson.handoffPath} --design-dir ${designDir} --product ${product}`,
  work,
);
if (pending.status !== 2) fail("expected exit 2 pending approval");

const plan = readFileSync(join(designDir, "developer-run/plan.md"), "utf8");
if (!/Create `test\/widget\.test\.js`/.test(plan)) {
  fail("plan.md must list create for test file");
}
if (!/Edit `package\.json`/.test(plan)) {
  fail("plan.md must list package.json edit");
}

const impl = run(
  "Developer implement (--approve)",
  `${process.execPath} ${runWp} --arch-handoff ${archJson.handoffPath} --design-dir ${designDir} --product ${product} --approve`,
  work,
);
if (!impl.ok) fail(`Developer implement failed:\n${impl.stderr}\n${impl.stdout}`);
const implJson = parseLastJson(impl.stdout);
if (!implJson.qualityHandoff?.verification?.tests) {
  fail("verification.tests must be present after successful npm test");
}
if (implJson.qualityHandoff.verification.tests.status !== "passed") {
  fail("verification.tests.status must be passed");
}
if (implJson.qualityHandoff.verification.build.status === "passed" &&
    implJson.qualityHandoff.verification.build.required === false) {
  // build may be skipped when not required — never treat skipped as passed
}
if (
  implJson.qualityHandoff.verification.build.status !== "skipped" &&
  implJson.qualityHandoff.verification.build.status !== "passed"
) {
  fail("verification.build must be skipped or passed");
}
if (implJson.qualityHandoff.workPackageId !== wpId) {
  fail("quality handoff missing/wrong workPackageId");
}
if (!existsSync(join(product, "test/widget.test.js"))) {
  fail("test file was not created");
}
const widget = readFileSync(join(product, "src/widget.js"), "utf8");
if (!widget.includes("value * factor")) fail("widget.js not edited");

// Idempotent re-run
const again = run(
  "Idempotent re-run",
  `${process.execPath} ${runWp} --arch-handoff ${archJson.handoffPath} --design-dir ${designDir} --product ${product} --approve`,
  work,
);
if (!again.ok) fail("idempotent re-run must succeed");

// Conflicting create
{
  write(
    join(product, "test/widget.test.js"),
    "// unexpected conflicting content\n",
  );
  const conflict = run(
    "Conflicting create must fail",
    `${process.execPath} ${runWp} --arch-handoff ${archJson.handoffPath} --design-dir ${designDir} --product ${product} --approve`,
    work,
  );
  if (conflict.ok) fail("conflicting create should fail");
  if (!/create conflict/i.test(conflict.stderr + conflict.stdout)) {
    fail("expected create conflict error");
  }
  // restore good content for later steps
  const goodSpec = JSON.parse(readFileSync(join(work, "change-spec.json"), "utf8"));
  const create = goodSpec.changes.find((c) => c.op === "create");
  write(join(product, "test/widget.test.js"), create.content);
}

// Incomplete machine requirements → emit refuses
{
  const badDir = join(work, "design-incomplete", wpId);
  mkdirSync(badDir, { recursive: true });
  write(
    join(badDir, "context-slice.md"),
    `---\nworkPackageId: ${wpId}\n---\n\n# Slice\n\n## In slice\n\nx\n\n## Out of slice\n\ny\n\n## Non-negotiables\n\nz\n\n## Machine requirements\n\n- \`src/widget.js\`\n- \`test/widget.test.js\`\n- \`package.json\`\n`,
  );
  write(join(badDir, "index.md"), `# Design\n`);
  write(join(badDir, "change-intent.json"), {
    decisionIds: ["ADR-EDITCREATE-001"],
    requiredMachineFiles: ["src/widget.js", "test/widget.test.js", "package.json"],
    features: [{ id: "F1", title: "x", readyForDev: true }],
    changes: [
      {
        file: "src/widget.js",
        op: "edit",
        match: "a",
        replace: "b",
      },
    ],
  });
  const incomplete = run(
    "Emit refuses incomplete change-spec",
    `${process.execPath} ${emitDev} --ba-handoff ${baJson.path} --design-dir ${badDir} --out ${join(work, "design-incomplete")} --product ${product}`,
    work,
  );
  if (incomplete.ok) fail("incomplete change-spec must not emit");
  if (!/incomplete for readyForDev/i.test(incomplete.stderr + incomplete.stdout)) {
    fail(`expected completeness error, got:\n${incomplete.stderr}`);
  }
}

// Failed npm test refuses PASS — break the test file expectation
{
  const brokenProduct = join(work, "product-broken");
  cpSync(join(fixture, "product"), brokenProduct, { recursive: true });
  const brokenDesign = join(work, "design-broken");
  const brokenBuild = run(
    "Build package for broken-test case",
    `${process.execPath} ${archTool} --ba-handoff ${baJson.path} --canon ${canon} --out ${brokenDesign} --product ${brokenProduct} --change-spec ${join(work, "change-spec.json")}`,
    work,
  );
  if (!brokenBuild.ok) fail("broken case arch build failed");
  const brokenArch = parseLastJson(brokenBuild.stdout);
  // Sabotage: change-spec create content that asserts wrong value
  const csPath = join(brokenArch.designDir, "change-spec.json");
  const cs = JSON.parse(readFileSync(csPath, "utf8"));
  const createIdx = cs.changes.findIndex((c) => c.op === "create");
  cs.changes[createIdx].content = cs.changes[createIdx].content.replace(
    "assert.equal(scale(5), 10)",
    "assert.equal(scale(5), 999)",
  );
  writeFileSync(csPath, JSON.stringify(cs, null, 2) + "\n");
  const failTest = run(
    "Developer must FAIL when npm test fails",
    `${process.execPath} ${runWp} --arch-handoff ${brokenArch.handoffPath} --design-dir ${brokenArch.designDir} --product ${brokenProduct} --approve --max-repairs 0`,
    work,
  );
  if (failTest.ok) fail("Developer should not PASS when tests fail");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      work,
      archHandoffPath: archJson.handoffPath,
      changeSpecPath: join(designDir, "change-spec.json"),
      verification: implJson.qualityHandoff.verification,
      proven: [
        "edit+create apply",
        "plan lists create",
        "idempotent rerun",
        "create conflict fails",
        "incomplete readyForDev refused",
        "failed npm test refuses PASS",
      ],
    },
    null,
    2,
  ),
);

rmSync(work, { recursive: true, force: true });
