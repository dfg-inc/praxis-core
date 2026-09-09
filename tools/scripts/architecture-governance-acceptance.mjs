#!/usr/bin/env node
/**
 * Packed acceptance for WBS 1.4 + Architect 4.6 / 4.7 / 4.9 / 4.13 / 4.15 / 4.16.
 * No network, no Jira, no Claude API.
 *
 *   node tools/scripts/architecture-governance-acceptance.mjs [--rebuild]
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

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
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

if (rebuild || !existsSync(join(mirror, "plugins/architect/tools/architecture-governance.mjs"))) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}

const packBase = mkdtempSync(join(tmpdir(), "praxis-arch-gov-pack-"));
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

const consumer = mkdtempSync(join(tmpdir(), "praxis-arch-gov-"));
write(join(consumer, "package.json"), { name: "praxis-arch-gov", private: true });
const install = run(
  `npm install ${tgzPaths.map((p) => `"${p}"`).join(" ")}`,
  consumer,
);
if (!install.ok) fail(`npm install failed:\n${install.stderr}`);

const baBoot = join(consumer, "node_modules/@praxis/ba/tools/session-bootstrap.cjs");
const archBoot = join(
  consumer,
  "node_modules/@praxis/architect/tools/session-bootstrap.cjs",
);
const devBoot = join(
  consumer,
  "node_modules/@praxis/developer/tools/session-bootstrap.cjs",
);
const gov = join(
  consumer,
  "node_modules/@praxis/architect/tools/architecture-governance.mjs",
);
const requestDev = join(
  consumer,
  "node_modules/@praxis/developer/tools/request-architecture-deviation.mjs",
);
for (const p of [baBoot, archBoot, devBoot, gov, requestDev]) {
  if (!existsSync(p)) fail(`missing packed path ${p}`);
}

const callerCwd = join(consumer, "caller-cwd");
mkdirSync(callerCwd, { recursive: true });
write(join(callerCwd, ".project"), "stack: [python]\n");

const proven = [];

function bootPositional(bin, project) {
  return run(`node "${bin}" "${project}"`, callerCwd);
}

{
  const valid = join(consumer, "proj-valid");
  write(
    join(valid, ".project"),
    "stack: [node]\nrequirementsFormat: user-story-gherkin\nrequiredArtifacts: [vision]\nenvironments: [local]\n",
  );
  const invalid = join(consumer, "proj-invalid");
  write(join(invalid, ".project"), "stack: not-an-array\n");
  const missing = join(consumer, "proj-missing");
  mkdirSync(missing, { recursive: true });

  for (const [role, bin] of [
    ["ba", baBoot],
    ["architect", archBoot],
    ["developer", devBoot],
  ]) {
    const v = bootPositional(bin, valid);
    if (!v.ok && !v.stdout) fail(`${role} valid bootstrap failed:\n${v.stderr}`);
    if (!/\.project loaded:/.test(v.stdout)) fail(`${role} valid: ${v.stdout}`);
    if (!v.stdout.includes(join(valid, ".project"))) {
      fail(`${role} did not load positional root:\n${v.stdout}`);
    }
    if (/python/.test(v.stdout) && /loaded:/.test(v.stdout) && v.stdout.includes("caller-cwd")) {
      fail(`${role} used caller CWD instead of positional`);
    }

    const inv = bootPositional(bin, invalid);
    if (!/\.project invalid:/.test(inv.stdout)) fail(`${role} invalid: ${inv.stdout}`);

    const miss = bootPositional(bin, missing);
    if (!/\.project missing/.test(miss.stdout)) fail(`${role} missing: ${miss.stdout}`);
  }

  const ba = bootPositional(baBoot, valid);
  const arch = bootPositional(archBoot, valid);
  const dev = bootPositional(devBoot, valid);
  if (!/plugin praxis-ba@/.test(ba.stdout)) fail(`BA role missing:\n${ba.stdout}`);
  if (!/plugin praxis-architect@/.test(arch.stdout)) fail(`architect role missing:\n${arch.stdout}`);
  if (!/plugin praxis-developer@/.test(dev.stdout)) fail(`developer role missing:\n${dev.stdout}`);
  proven.push("1.4 project-config parity");
}

function govJson(args, cwd = consumer) {
  const r = run(`node "${gov}" ${args}`, cwd);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { ...r, json };
}

{
  const highIn = join(consumer, "high.json");
  write(highIn, {
    workPackageId: "WP-1",
    decisionId: "ADR-001",
    flags: { schemaOrApiWithExternalConsumers: true },
  });
  const high = govJson(`classify-error-cost --in "${highIn}"`);
  if (high.json?.result !== "council-required" || high.json?.priceOfError !== "high") {
    fail(`high risk: ${high.stdout}\n${high.stderr}`);
  }
  const gatePath = join(consumer, "gate-high.json");
  write(gatePath, high.json);
  const blocked2 = run(`node "${gov}" assert-record-decision --error-cost "${gatePath}"`, consumer);
  if (blocked2.ok) fail("high risk must block record-decision without council");
  if (!/blocked/i.test(blocked2.stderr)) fail(`expected blocker:\n${blocked2.stderr}`);

  const councilIn = join(consumer, "council.json");
  write(councilIn, {
    workPackageId: "WP-1",
    decisionId: "ADR-001",
    participants: [{ role: "reliability" }, { role: "security" }, { role: "delivery" }],
    options: [
      { id: "A", summary: "Monolith" },
      { id: "B", summary: "Extract" },
    ],
    concerns: [{ role: "delivery", text: "migration cost" }],
    outcome: "approved",
    humanApproval: { actor: "architect-human" },
  });
  const councilOut = join(consumer, "council-out.json");
  const rec = govJson(`record-council --in "${councilIn}" --out "${councilOut}"`);
  if (rec.json?.outcome !== "approved" || rec.json?.selfApproved !== false) {
    fail(`council: ${rec.stdout}\n${rec.stderr}`);
  }
  const self = join(consumer, "council-self.json");
  write(self, { ...JSON.parse(readFileSync(councilIn, "utf8")), humanApproval: {} });
  const selfRun = run(`node "${gov}" record-council --in "${self}"`, consumer);
  if (selfRun.ok) fail("self-approve must fail");

  const allowed = govJson(
    `assert-record-decision --error-cost "${gatePath}" --council "${councilOut}"`,
  );
  if (!allowed.ok) fail(`council should unblock:\n${allowed.stderr}`);

  const lowIn = join(consumer, "low.json");
  write(lowIn, {
    workPackageId: "WP-1",
    decisionId: "ADR-002",
    flags: {
      reversibleInWorkPackage: true,
      noSchemaSecurityOrCrossSystem: true,
      noProductionMigration: true,
      failureContainedInPackage: true,
      noHighSeverityIrreversibleLensFinding: true,
    },
  });
  const low = govJson(`classify-error-cost --in "${lowIn}" --out "${join(consumer, "gate-low.json")}"`);
  if (low.json?.result !== "skip") fail(`low risk: ${low.stdout}`);
  const lowOk = govJson(`assert-record-decision --error-cost "${join(consumer, "gate-low.json")}"`);
  if (!lowOk.ok) fail(`low risk should proceed:\n${lowOk.stderr}`);
  proven.push("4.6 architecture council");
  proven.push("4.7 mandatory council by price-of-error");
}

{
  const design = join(consumer, "design/WP-1");
  const pc = {
    id: "PC-001",
    owner: "orders",
    consumers: ["web"],
    request: { method: "POST", path: "/orders" },
    response: { status: 201 },
    errors: { "400": "invalid" },
    compatibility: { version: "1.0.0" },
    nfrRefs: ["NFR-1"],
    decisionIds: ["ADR-001"],
  };
  const pcIn = join(consumer, "pc-in.json");
  write(pcIn, pc);
  const pcOut = join(design, "contracts/PC-001.json");
  const w = govJson(`write-platform-contract --in "${pcIn}" --out "${pcOut}"`);
  if (w.json?.id !== "PC-001") fail(`pc write: ${w.stdout}`);
  const listed = govJson(`list-platform-contracts --design-dir "${design}"`);
  if (!listed.json?.ids?.includes("PC-001")) fail(`list pc: ${listed.stdout}`);
  const miss = run(
    `node "${gov}" detect-missing-contracts --design-dir "${design}" --required PC-001,PC-999`,
    consumer,
  );
  if (miss.ok) fail("missing PC-999 must be detected");
  if (!JSON.parse(miss.stdout).missing.includes("PC-999")) fail(`missing detect: ${miss.stdout}`);
  proven.push("4.9 platform contracts");
}

{
  const planIn = join(consumer, "plan.json");
  write(planIn, {
    units: [
      { id: "B", title: "API", estimateHours: 5, dependsOn: ["A"] },
      { id: "A", title: "Schema", estimateHours: 3, dependsOn: [] },
      { id: "C", title: "Docs", estimateHours: 1, dependsOn: [] },
    ],
  });
  const p1 = govJson(`build-plan --in "${planIn}"`);
  const p2 = govJson(`build-plan --in "${planIn}"`);
  if (JSON.stringify(p1.json) !== JSON.stringify(p2.json)) fail("build plan not deterministic");
  if (p1.json.order.indexOf("A") >= p1.json.order.indexOf("B")) fail("A must precede B");
  if (!p1.json.waves[0].includes("A") || !p1.json.waves[0].includes("C")) {
    fail(`parallelizable first wave: ${JSON.stringify(p1.json.waves)}`);
  }
  if (p1.json.totalEstimateHours !== 9) fail("total hours");
  proven.push("4.13 estimate/build order");
}

{
  const design = join(consumer, "design/WP-1");
  const adr = join(design, "ADR-001.md");
  write(adr, "# ADR-001\nUse postgres.\n");
  const before = readFileSync(adr, "utf8");
  const reqIn = join(consumer, "dev-req.json");
  write(reqIn, {
    workPackageId: "WP-1",
    affectedId: "ADR-001",
    requestedDeviation: "sqlite in CI",
    reason: "speed",
    impact: "test-only",
    evidence: "ci.yml",
    bindingChange: false,
  });
  const reqOut = join(design, "deviations/DEV-1.json");
  const filed = run(
    `node "${requestDev}" --in "${reqIn}" --out "${reqOut}"`,
    consumer,
  );
  if (!filed.ok) fail(`developer request failed:\n${filed.stderr}`);
  const approved = govJson(
    `decide-deviation --request "${reqOut}" --outcome approved --actor architect-human --rationale "ci only" --adr "${adr}" --out "${join(design, "deviations/DEV-1-decision.json")}"`,
  );
  if (approved.json?.outcome !== "approved") fail(`approve: ${approved.stdout}\n${approved.stderr}`);
  if (readFileSync(adr, "utf8") !== before) fail("ADR mutated on approve");

  const rejIn = join(consumer, "dev-rej.json");
  write(rejIn, {
    workPackageId: "WP-1",
    affectedId: "ADR-001",
    requestedDeviation: "drop postgres",
    reason: "cost",
    impact: "high",
    evidence: "note",
    bindingChange: true,
  });
  const rejReq = join(design, "deviations/DEV-2.json");
  run(`node "${requestDev}" --in "${rejIn}" --out "${rejReq}"`, consumer);
  const rejected = govJson(
    `decide-deviation --request "${rejReq}" --outcome rejected --actor architect-human --rationale "binding stays" --adr "${adr}" --out "${join(design, "deviations/DEV-2-decision.json")}"`,
  );
  if (rejected.json?.outcome !== "rejected") fail(`reject: ${rejected.stdout}`);
  if (readFileSync(adr, "utf8") !== before) fail("ADR mutated on reject");
  proven.push("4.15 architecture deviation");
}

{
  const confPass = join(consumer, "conf-pass.json");
  write(confPass, {
    files: { "src/db.js": "engine: postgres" },
    bindings: [
      {
        id: "ADR-001",
        kind: "decision",
        checks: [{ type: "contains", file: "src/db.js", contains: "postgres" }],
      },
    ],
  });
  const pass = govJson(`conformance --in "${confPass}"`);
  if (pass.json?.verdict !== "conforming") fail(`conforming: ${pass.stdout}`);

  const confFail = join(consumer, "conf-fail.json");
  write(confFail, {
    files: { "src/db.js": "engine: sqlite" },
    bindings: [
      {
        id: "ADR-001",
        kind: "decision",
        checks: [{ type: "contains", file: "src/db.js", contains: "postgres" }],
      },
    ],
  });
  const bad = govJson(`conformance --in "${confFail}"`);
  if (bad.json?.verdict !== "non-conforming") fail(`non-conforming: ${bad.stdout}`);
  if (!bad.json.deviations.some((d) => d.id === "ADR-001")) fail("must name ADR-001");

  const confDev = join(consumer, "conf-dev.json");
  write(confDev, {
    files: { "src/db.js": "engine: sqlite" },
    bindings: [
      {
        id: "ADR-001",
        kind: "decision",
        checks: [{ type: "contains", file: "src/db.js", contains: "postgres" }],
      },
    ],
    deviations: [
      { id: "DEV-1-decision", requestId: "DEV-1", affectedId: "ADR-001", outcome: "approved" },
    ],
  });
  const okDev = govJson(`conformance --in "${confDev}"`);
  if (okDev.json?.verdict !== "conforming") fail(`approved deviation: ${okDev.stdout}`);
  if (okDev.json.deviations.length) fail("approved deviation listed as unauthorized");
  if (!okDev.json.authorizedDeviations.some((d) => d.deviationId === "DEV-1-decision")) {
    fail("report must reference approved deviation");
  }
  proven.push("4.16 post-implementation conformance");
}

rmSync(packBase, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "external-tgz",
      proven,
    },
    null,
    2,
  ),
);
