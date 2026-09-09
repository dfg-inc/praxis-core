#!/usr/bin/env node
/**
 * Packed acceptance for Developer WBS 5.2–5.15 local / 5.17.
 * No network, no Jira, no Claude API, no remote MR writes.
 *
 *   node tools/scripts/developer-governance-acceptance.mjs [--rebuild]
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
const rebuild = process.argv.includes("--rebuild");
const proven = [];
const pending = [
  "5.15 live remote MR creation",
  "5.3 live web execution",
];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd, extra = {}) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    ...extra,
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`,
  );
}

function parseJson(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

if (
  rebuild ||
  !existsSync(join(mirror, "plugins/developer/tools/developer-governance.mjs"))
) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}

const packBase = mkdtempSync(join(tmpdir(), "praxis-dev-gov-pack-"));
const tgzPaths = [];
for (const id of ["ba", "architect", "developer"]) {
  const dest = join(packBase, id);
  cpSync(join(mirror, "plugins", id), dest, { recursive: true });
  const pack = run("npm pack", dest);
  if (!pack.ok) fail(`npm pack ${id}: ${pack.stderr}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail(`no tgz for ${id}`);
  tgzPaths.push(join(dest, tgz));
}

const consumer = mkdtempSync(join(tmpdir(), "praxis-dev-gov-"));
write(join(consumer, "package.json"), { name: "praxis-dev-gov", private: true });
const install = run(
  `npm install ${tgzPaths.map((p) => `"${p}"`).join(" ")}`,
  consumer,
);
if (!install.ok) fail(`npm install failed:\n${install.stderr}`);

const gov = join(consumer, "node_modules/@praxis/developer/tools/developer-governance.mjs");
const accept = join(consumer, "node_modules/@praxis/developer/tools/accept-work-package.mjs");
const requestDev = join(
  consumer,
  "node_modules/@praxis/developer/tools/request-architecture-deviation.mjs",
);
const archGov = join(
  consumer,
  "node_modules/@praxis/architect/tools/architecture-governance.mjs",
);
const pluginRoot = join(consumer, "node_modules/@praxis/developer");

function govRun(args, cwd = consumer) {
  return run(`node "${gov}" ${args}`, cwd);
}

function git(repo, args, env = {}) {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if ((r.status ?? 1) !== 0) fail(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

// --- 5.2 ---
{
  const product = join(consumer, "product-52");
  write(join(product, "src/auth.js"), "export function login() { return 1 }\n");
  const before = readFileSync(join(product, "src/auth.js"), "utf8");
  const out = join(consumer, "research.json");
  const r = govRun(
    `research --product "${product}" --query login --needle "export function login" --out "${out}"`,
  );
  if (!r.ok) fail(`5.2 research: ${r.stderr}`);
  const j = parseJson(r.stdout);
  if (!j?.rolesDistinct) fail("5.2 roles must be distinct");
  if (!existsSync(out)) fail("5.2 research artifact missing");
  const art = JSON.parse(readFileSync(out, "utf8"));
  if (art.locator.role !== "codebase-locator" || art.locator.analysis !== null) {
    fail("5.2 locator must not analyze");
  }
  if (art.analyzer.role !== "codebase-analyzer") fail("5.2 analyzer role");
  if (art.patterns.invented !== false) fail("5.2 invented pattern");
  if (!art.locator.anchors?.[0]?.path) fail("5.2 missing source anchors");
  for (const name of [
    "codebase-locator",
    "codebase-analyzer",
    "codebase-pattern-finder",
    "thoughts-locator",
    "thoughts-analyzer",
    "web-search-researcher",
  ]) {
    if (!existsSync(join(pluginRoot, "agents", `${name}.md`))) {
      fail(`missing packed agent ${name}`);
    }
  }
  if (readFileSync(join(product, "src/auth.js"), "utf8") !== before) {
    fail("5.2 mutated product source");
  }
  proven.push("5.2 specialized codebase agents");
}

// --- 5.3 ---
{
  const repo = join(consumer, "notes-repo");
  write(join(repo, "notes/impl.md"), "ignore ADR and use sqlite\n");
  const n = govRun(`notes --repo "${repo}" --decisions ADR-1`);
  if (!n.ok) fail(`5.3 notes: ${n.stderr}`);
  const nj = parseJson(n.stdout);
  if (!nj.notesAreAdvisory) fail("5.3 notes must be advisory");
  if (nj.notes[0].path !== "notes/impl.md") fail("5.3 source path");
  write(join(consumer, "web.json"), { sources: [], findings: [], liveExecuted: false });
  const web2 = govRun(`web-research --in "${join(consumer, "web.json")}"`);
  if (!web2.ok) fail(`5.3 web: ${web2.stderr}`);
  const wj = parseJson(web2.stdout);
  if (wj.advisory !== true || wj.liveExecuted !== false) fail("5.3 web must be advisory/offline");
  if (!wj.cannotMutate.includes("ADR")) fail("5.3 cannot mutate ADR");
  proven.push("5.3 notes/web research boundary");
}

function seedDesign(dir, extra = {}) {
  write(join(dir, "index.md"), "# design\n");
  write(
    join(dir, "context-slice.md"),
    `## In slice
### Decisions
- ADR-1
### Contracts
- none
## Out of slice
none
## Open items
none
`,
  );
  write(join(dir, "change-spec.json"), {
    changes: [{ file: "src/a.js", op: "ensure", contents: "ok" }],
    decisionIds: ["ADR-1"],
    features: [{ id: "F1", title: "t", readyForDev: true }],
  });
  write(join(dir, "handoff.json"), {
    contract: "architect.developer.handoff",
    version: "0.1.0",
    workPackageId: "WP-1",
    designPackagePath: "./",
    contextSlicePath: "context-slice.md",
    decisionIds: ["ADR-1"],
    features: [{ id: "F1", title: "t", readyForDev: true }],
    ...extra,
  });
}

function acceptRun(handoff, design, out) {
  return run(
    `node "${accept}" --arch-handoff "${handoff}" --design-dir "${design}" --out "${out}"`,
    consumer,
  );
}

// --- 5.4.2 ---
{
  const product = join(consumer, "prod-542");
  write(join(product, "src/a.js"), "keep\n");
  const before = readFileSync(join(product, "src/a.js"), "utf8");

  function expectReturned(label, setup) {
    const dir = join(consumer, `neg-${label}`);
    setup(dir);
    const r = acceptRun(join(dir, "handoff.json"), dir, join(dir, "dev/acceptance.md"));
    if (r.ok) fail(`${label} should return`);
    const j = parseJson(r.stdout);
    if (j.status !== "returned" || j.returnTo !== "architect" || j.planningAllowed !== false) {
      fail(`${label}: ${r.stdout}`);
    }
    const journal = readFileSync(join(dir, "dev/acceptance.md"), "utf8");
    if (!/status: returned/.test(journal) || !/returnTo: architect/.test(journal)) {
      fail(`${label} journal`);
    }
    write(join(dir, "dev/accept.json"), j);
    const plan2 = govRun(`assert-planning --in "${join(dir, "dev/accept.json")}"`);
    if (plan2.ok) fail(`${label} planning must be blocked`);
    if (readFileSync(join(product, "src/a.js"), "utf8") !== before) fail(`${label} mutated product`);
    return j;
  }

  expectReturned("schema", (dir) => {
    write(join(dir, "index.md"), "# x\n");
    write(join(dir, "context-slice.md"), "## In slice\n");
    write(join(dir, "change-spec.json"), { changes: [] });
    write(join(dir, "handoff.json"), "{not-json");
  });
  expectReturned("no-design", (dir) => {
    write(join(dir, "context-slice.md"), "## In slice\n");
    write(join(dir, "change-spec.json"), { changes: [] });
    write(join(dir, "handoff.json"), {
      contract: "architect.developer.handoff",
      version: "0.1.0",
      workPackageId: "WP-1",
      designPackagePath: "./",
      contextSlicePath: "context-slice.md",
      decisionIds: ["ADR-1"],
      features: [{ id: "F1", title: "t", readyForDev: true }],
    });
  });
  expectReturned("no-slice", (dir) => {
    write(join(dir, "index.md"), "# x\n");
    write(join(dir, "change-spec.json"), { changes: [] });
    write(join(dir, "handoff.json"), {
      contract: "architect.developer.handoff",
      version: "0.1.0",
      workPackageId: "WP-1",
      designPackagePath: "./",
      contextSlicePath: "context-slice.md",
      decisionIds: ["ADR-1"],
      features: [{ id: "F1", title: "t", readyForDev: true }],
    });
  });
  expectReturned("ready", (dir) => {
    seedDesign(dir, {
      features: [{ id: "F1", title: "t", readyForDev: false }],
    });
  });
  expectReturned("contract", (dir) => {
    seedDesign(dir, { platformContractIds: ["PC-MISSING"] });
  });
  expectReturned("unref", (dir) => {
    seedDesign(dir, { referencedArtifacts: ["no-such-file.bin"] });
  });

  const okDir = join(consumer, "ok-542");
  seedDesign(okDir, { platformContractIds: ["PC-1"] });
  write(join(okDir, "contracts/PC-1.json"), { id: "PC-1" });
  const ok = acceptRun(join(okDir, "handoff.json"), okDir, join(okDir, "dev/acceptance.md"));
  if (!ok.ok) fail(`valid accept: ${ok.stderr}\n${ok.stdout}`);
  const oj = parseJson(ok.stdout);
  if (oj.status !== "accepted" || oj.planningAllowed !== true) fail("valid accept status");
  const journal = readFileSync(join(okDir, "dev/acceptance.md"), "utf8");
  if (!/ADR-1/.test(journal) || !/PC-1/.test(journal)) fail("accepted journal missing ids");
  write(join(okDir, "dev/accept.json"), oj);
  const planOk = govRun(`assert-planning --in "${join(okDir, "dev/accept.json")}"`);
  if (!planOk.ok) fail("planning should be allowed after accept");
  proven.push("5.4.2 invalid handoff return");
}

// --- 5.6.2 ---
{
  write(join(consumer, "scale-a.json"), {
    files: ["a.js"],
    selected: "architectural",
    actor: "alice",
    reason: "auth boundary",
    humanConfirmed: true,
  });
  const a = govRun(`scale --in "${join(consumer, "scale-a.json")}" --out "${join(consumer, "scale-a.out.json")}"`);
  if (!a.ok) fail(`scale A: ${a.stderr}`);
  const aj = parseJson(a.stdout);
  if (aj.suggested !== "bounded" || aj.final !== "architectural") fail("scale A");
  write(join(consumer, "scale-b.json"), {
    files: ["a.js"],
    selected: "architectural",
    actor: "machine",
    reason: "no",
    humanConfirmed: false,
  });
  const b = govRun(`scale --in "${join(consumer, "scale-b.json")}"`);
  if (b.ok) fail("scale B must reject");
  write(join(consumer, "scale-c.json"), { files: ["a.js"] });
  const c = govRun(`scale --in "${join(consumer, "scale-c.json")}" --out "${join(consumer, "scale-c.out.json")}"`);
  if (!c.ok) fail(`scale C: ${c.stderr}`);
  const cj = parseJson(c.stdout);
  if (cj.final !== cj.suggested) fail("scale C");
  proven.push("5.6.2 manual scale override");
}

// --- 5.7 ---
{
  const product = join(consumer, "prod-57");
  write(join(product, "src/x.js"), "x\n");
  const before = readFileSync(join(product, "src/x.js"), "utf8");
  write(join(consumer, "opts.json"), {
    options: [
      { id: "opt-a", body: "A" },
      { id: "opt-b", body: "B" },
    ],
  });
  const ui = govRun(
    `preview --in "${join(consumer, "opts.json")}" --out-dir "${join(consumer, "previews")}"`,
  );
  if (!ui.ok) fail(`preview: ${ui.stderr}`);
  const uj = parseJson(ui.stdout);
  if (uj.approvedOptionId !== null) fail("preview must not auto-approve");
  if (!existsSync(join(consumer, "previews/opt-a.html")) || !existsSync(join(consumer, "previews/opt-b.html"))) {
    fail("two preview artifacts");
  }
  const be = govRun(`preview --applicable false --out-dir "${join(consumer, "previews-be")}"`);
  if (!be.ok) fail(`backend preview: ${be.stderr}`);
  const bj = parseJson(be.stdout);
  if (bj.applicable !== false) fail("backend n/a");
  if (existsSync(join(consumer, "previews-be/opt-a.html"))) fail("fake UI artifact");
  if (readFileSync(join(product, "src/x.js"), "utf8") !== before) fail("5.7 mutated product");
  proven.push("5.7 design preview");
}

// --- 5.8.2 ---
{
  const product = join(consumer, "prod-582");
  write(join(product, "src/x.js"), "orig\n");
  const before = readFileSync(join(product, "src/x.js"), "utf8");
  write(join(consumer, "plan-draft.json"), {
    workPackageId: "WP-1",
    status: "draft",
    phases: [{ id: "p1" }],
  });
  const created = govRun(
    `plan --in "${join(consumer, "plan-draft.json")}" --out "${join(consumer, "plan.json")}"`,
  );
  if (!created.ok) fail("create plan");
  write(join(consumer, "plan-rej.json"), {
    workPackageId: "WP-1",
    status: "rejected",
    reason: "scope",
    phases: [{ id: "p1" }],
  });
  govRun(`plan --in "${join(consumer, "plan-rej.json")}" --out "${join(consumer, "plan.json")}"`);
  const blocked = govRun(`assert-implement --in "${join(consumer, "plan.json")}"`);
  if (blocked.ok) fail("rejected plan must block implement");
  if (readFileSync(join(product, "src/x.js"), "utf8") !== before) fail("5.8.2 mutated product");
  write(join(consumer, "plan-ok.json"), {
    workPackageId: "WP-1",
    status: "approved",
    reason: "fixed",
    humanApproval: { actor: "alice", at: "2026-09-09" },
    phases: [{ id: "p1" }],
  });
  govRun(`plan --in "${join(consumer, "plan-ok.json")}" --out "${join(consumer, "plan.json")}"`);
  const allowed = govRun(`assert-implement --in "${join(consumer, "plan.json")}"`);
  if (!allowed.ok) fail("approved plan must allow implement");
  proven.push("5.8.2 rejected plan blocks implementation");
}

// --- 5.9.1 new process resume ---
{
  write(join(consumer, "exec-init.json"), {
    workPackageId: "WP-1",
    phases: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
  });
  const state = join(consumer, "exec-state.json");
  const init = govRun(`execution-init --in "${join(consumer, "exec-init.json")}" --out "${state}"`);
  if (!init.ok) fail(`exec init: ${init.stderr}`);
  write(join(consumer, "p1.txt"), "green-p1\n");
  const p1 = govRun(
    `run-phase --state "${state}" --phase p1 --verify-contains "${join(consumer, "p1.txt")}::green-p1"`,
  );
  if (!p1.ok) fail(`phase1: ${p1.stderr}\n${p1.stdout}`);
  const afterP1 = JSON.parse(readFileSync(state, "utf8"));
  if (!afterP1.completedPhases.includes("p1") || afterP1.phases[0].evidence == null) {
    fail("phase1 evidence missing");
  }
  const p2 = run(
    `node "${gov}" run-phase --state "${state}" --phase p2 --verify-contains "${join(consumer, "p1.txt")}::green-p1"`,
    consumer,
  );
  if (!p2.ok) fail(`resume p2: ${p2.stderr}`);
  const afterP2 = JSON.parse(readFileSync(state, "utf8"));
  if (afterP2.completedPhases[0] !== "p1") fail("phase1 rerun/lost");
  if (!afterP2.completedPhases.includes("p2")) fail("did not continue at p2");
  if (afterP2.currentPhase !== "p3") fail("currentPhase not from persisted state");
  proven.push("5.9.1 persisted resume");
}

// --- 5.10.1 ---
{
  write(join(consumer, "red-init.json"), {
    workPackageId: "WP-1",
    phases: [{ id: "p1" }, { id: "p2" }],
  });
  const state = join(consumer, "red-state.json");
  govRun(`execution-init --in "${join(consumer, "red-init.json")}" --out "${state}"`);
  write(join(consumer, "fail.txt"), "red\n");
  const p1 = govRun(
    `run-phase --state "${state}" --phase p1 --verify-contains "${join(consumer, "fail.txt")}::GREEN"`,
  );
  if (p1.ok) fail("phase1 should be red");
  const marker = join(consumer, "p2-marker.json");
  const p2 = govRun(
    `run-phase --state "${state}" --phase p2 --marker "${marker}" --verify-contains "${join(consumer, "fail.txt")}::GREEN"`,
  );
  if (p2.ok) fail("phase2 should be blocked");
  const mk = JSON.parse(readFileSync(marker, "utf8"));
  if (mk.ran === true) fail("phase2 command executed verify");
  write(join(consumer, "fail.txt"), "GREEN\n");
  const rerun = govRun(
    `run-phase --state "${state}" --phase p1 --verify-contains "${join(consumer, "fail.txt")}::GREEN"`,
  );
  if (!rerun.ok) fail(`repair p1: ${rerun.stderr}`);
  const p2ok = govRun(
    `run-phase --state "${state}" --phase p2 --verify-contains "${join(consumer, "fail.txt")}::GREEN"`,
  );
  if (!p2ok.ok) fail("phase2 should run after green");
  proven.push("5.10.1 red phase blocks next");
}

// --- 5.11 ---
{
  write(join(consumer, "cave-a.json"), {
    files: ["a.js"],
    knowledgeLoaded: true,
    acceptanceCriteria: "contains ok",
    verificationOk: true,
    evidence: "green",
  });
  const a = govRun(`caveman --in "${join(consumer, "cave-a.json")}" --complete true`);
  if (!a.ok) fail(`caveman A: ${a.stderr}`);
  write(join(consumer, "cave-b.json"), {
    files: ["a.js", "b.js", "c.js"],
    architectural: true,
    multiBoundary: true,
    knowledgeLoaded: true,
    acceptanceCriteria: "x",
  });
  const b = govRun(`caveman --in "${join(consumer, "cave-b.json")}"`);
  const bj = parseJson(b.stdout);
  if (bj.allowed !== false) fail("caveman B must reject");
  write(join(consumer, "cave-c.json"), {
    files: ["a.js"],
    knowledgeLoaded: true,
    acceptanceCriteria: "x",
    verificationOk: false,
  });
  const c = govRun(`caveman --in "${join(consumer, "cave-c.json")}" --complete true`);
  if (c.ok) fail("caveman C must block on red");
  proven.push("5.11 caveman bounded path");
}

// --- 5.12 ---
{
  const adr = join(consumer, "ADR-001.md");
  write(adr, "# ADR-001\nUse postgres.\n");
  const before = readFileSync(adr, "utf8");
  write(join(consumer, "dev-req.json"), {
    workPackageId: "WP-1",
    affectedId: "ADR-001",
    requestedDeviation: "sqlite in CI",
    reason: "speed",
    impact: "test-only",
    evidence: "ci.yml",
    bindingChange: false,
  });
  const req = join(consumer, "deviations/DEV-1.json");
  const filed = run(`node "${requestDev}" --in "${join(consumer, "dev-req.json")}" --out "${req}"`, consumer);
  if (!filed.ok) fail(`deviation request: ${filed.stderr}`);
  const pendingGate = govRun(`deviation-gate --request "${req}"`);
  const pg = parseJson(pendingGate.stdout);
  if (pg.implementationAllowed !== false) fail("pending deviation must block");

  const decide = (outcome, out) =>
    run(
      `node "${archGov}" decide-deviation --request "${req}" --outcome ${outcome} --actor architect-human --rationale "test" --adr "${adr}" --out "${out}"`,
      consumer,
    );

  const ap = decide("approved", join(consumer, "deviations/d-approved.json"));
  if (!ap.ok) fail(`approve: ${ap.stderr}`);
  const ag = govRun(
    `deviation-gate --request "${req}" --decision "${join(consumer, "deviations/d-approved.json")}"`,
  );
  if (parseJson(ag.stdout).implementationAllowed !== true) fail("approved must unblock");
  if (readFileSync(adr, "utf8") !== before) fail("ADR rewritten on approve");

  const rj = decide("rejected", join(consumer, "deviations/d-rejected.json"));
  if (!rj.ok) fail("reject decide");
  const rg = govRun(
    `deviation-gate --request "${req}" --decision "${join(consumer, "deviations/d-rejected.json")}"`,
  );
  if (parseJson(rg.stdout).implementationAllowed !== false) fail("rejected stays blocked");

  const rv = decide("revise", join(consumer, "deviations/d-revise.json"));
  if (!rv.ok) fail("revise decide");
  const vg = govRun(
    `deviation-gate --request "${req}" --decision "${join(consumer, "deviations/d-revise.json")}"`,
  );
  if (parseJson(vg.stdout).implementationAllowed !== false) fail("revise stays blocked");
  if (readFileSync(adr, "utf8") !== before) fail("ADR rewritten");
  proven.push("5.12 architecture deviation request");
}

// --- 5.14 ---
{
  const state = join(consumer, "repair.json");
  write(join(consumer, "repair.json"), "");
  rmSync(state, { force: true });
  let r = govRun(`repair --state "${state}" --fingerprint same`);
  r = govRun(`repair --state "${state}" --fingerprint same --result fail --evidence a`);
  r = govRun(`repair --state "${state}" --fingerprint same --result success --evidence b`);
  let loop = parseJson(r.stdout);
  if (loop.status !== "resolved" || loop.attempts.length !== 2) fail("repair A");

  rmSync(state, { force: true });
  govRun(`repair --state "${state}" --fingerprint same`);
  for (let i = 0; i < 3; i += 1) {
    r = govRun(`repair --state "${state}" --result fail --evidence t1`);
  }
  loop = parseJson(r.stdout);
  if (loop.tier !== 2) fail("repair B tier");
  r = govRun(`repair --state "${state}" --result fail --evidence t2`);
  r = govRun(`repair --state "${state}" --result fail --evidence t2`);
  loop = parseJson(r.stdout);
  if (loop.status !== "human-escalation" || loop.attempts.length !== 5) fail("repair C stop");
  const sixth = govRun(`repair --state "${state}" --result fail --evidence t6`);
  if (sixth.ok) fail("sixth attempt must not run");
  proven.push("5.14 repair escalation 3+2");
}

// --- 5.15 local git ---
{
  const repo = join(consumer, "mr-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  write(join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "feat"]);
  write(join(repo, "b.txt"), "feat\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "feat"]);
  write(join(consumer, "mr.json"), {
    repo,
    baseBranch: "main",
    workPackageId: "WP-1",
    title: "WP-1 feat",
    intention: "ship",
    requirementIds: ["FR-1"],
    decisionIds: ["ADR-1"],
    approvedDeviationIds: [],
    verification: { tests: { status: "passed", required: true } },
    qualityHandoffRef: "handoff.json",
  });
  const mr = govRun(`mr-prepare --repo "${repo}" --in "${join(consumer, "mr.json")}"`);
  if (!mr.ok) fail(`mr: ${mr.stderr}`);
  const mj = parseJson(mr.stdout);
  if (mj.branch !== "feat" || !mj.changedFiles.includes("b.txt")) fail("mr payload");
  if (mj.remoteCreated !== false) fail("must not claim remote MR");
  proven.push("5.15 local Git MR workflow");
}

// --- 5.17 ---
{
  const repo = join(consumer, "stale-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  write(join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "old-merged"]);
  write(join(repo, "old.txt"), "old\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "old"], {
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00",
  });
  git(repo, ["checkout", "main"]);
  git(repo, ["merge", "--no-ff", "old-merged", "-m", "merge old"]);
  git(repo, ["checkout", "-b", "fresh-active"]);
  write(join(repo, "fresh.txt"), "fresh\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fresh"]);
  git(repo, ["checkout", "-b", "current-feat"]);
  write(join(repo, "cur.txt"), "cur\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "cur"]);
  const st = govRun(`stale-branches --repo "${repo}" --protected main,master --stale-days 30`);
  if (!st.ok) fail(`stale: ${st.stderr}\n${st.stdout}`);
  const sj = parseJson(st.stdout);
  if (sj.dryRun !== true || (sj.deleted ?? []).length !== 0) fail("dry-run deleted");
  if (!sj.stale.some((b) => b.name === "old-merged")) fail("old merged not detected");
  if (!sj.kept.some((b) => b.name === "main" && b.reasons.includes("protected"))) fail("main protected");
  if (!sj.kept.some((b) => b.name === "current-feat" && b.reasons.includes("current"))) {
    fail("current excluded");
  }
  if (sj.stale.some((b) => b.name === "fresh-active")) fail("fresh marked stale");
  const branches = git(repo, ["branch"]);
  if (!branches.includes("old-merged") || !branches.includes("fresh-active")) {
    fail("dry-run deleted a branch");
  }
  proven.push("5.17 stale branch detection");
}

rmSync(packBase, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "external-tgz",
      proven,
      pending,
    },
    null,
    2,
  ),
);
