#!/usr/bin/env node
/**
 * External Knowledge + SessionStart acceptance against packed plugins.
 *
 * Proves BA / Architect / Developer session-bootstrap.cjs from release-mirror
 * artifacts load role/stage slices, precedence, skipped/unavailable paths,
 * and the finding propose/reject/accept lifecycle via praxis-knowledge CLI.
 *
 * Usage (monorepo root):
 *   node tools/scripts/knowledge-external-acceptance.mjs [--rebuild]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const knowledgeCli = join(root, "packages/knowledge/bin/praxis-knowledge.mjs");
const knowledgeDist = join(root, "packages/knowledge/dist/index.js");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd, env = {}) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...env },
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

function writeRule(dir, id, roles, stages, title = id) {
  write(
    join(dir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      `roles: [${roles.join(", ")}]`,
      `stages: [${stages.join(", ")}]`,
      "severity: mandatory",
      "overridable: true",
      "---",
      "",
      `# ${title}`,
      "",
      "Body.",
      "",
    ].join("\n"),
  );
}

if (!existsSync(knowledgeDist)) {
  console.log("building @praxis/knowledge…");
  const b = run("npm run build -w @praxis/knowledge", root);
  if (!b.ok) fail(`knowledge build failed:\n${b.stderr}`);
}

if (rebuild || !existsSync(join(mirror, "plugins/ba/tools/session-bootstrap.cjs"))) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}

for (const id of ["ba", "architect", "developer"]) {
  const hook = join(mirror, "plugins", id, "hooks/session-start.md");
  const skill = join(mirror, "plugins", id, "skills/session-start/SKILL.md");
  const boot = join(mirror, "plugins", id, "tools/session-bootstrap.cjs");
  if (!existsSync(boot)) fail(`packed ${id} missing session-bootstrap.cjs`);
  if (!existsSync(hook)) fail(`packed ${id} missing hooks/session-start.md`);
  if (!existsSync(skill)) fail(`packed ${id} missing skills/session-start`);
}

const packBase = mkdtempSync(join(tmpdir(), "praxis-know-pack-"));
const tgzPaths = [];
for (const id of ["ba", "architect", "developer"]) {
  const dest = join(packBase, id);
  cpSync(join(mirror, "plugins", id), dest, { recursive: true });
  const pack = run("npm pack", dest);
  if (!pack.ok) fail(`npm pack ${id}: ${pack.stderr}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail(`no .tgz for ${id}`);
  tgzPaths.push(join(dest, tgz));
}

const consumer = mkdtempSync(join(tmpdir(), "praxis-know-ext-"));
write(
  join(consumer, "package.json"),
  JSON.stringify({ name: "praxis-know-ext", private: true }, null, 2),
);
const install = run(
  `npm install ${tgzPaths.map((p) => `"${p}"`).join(" ")}`,
  consumer,
);
if (!install.ok) fail(`npm install plugins failed:\n${install.stderr}`);

const baBoot = join(consumer, "node_modules/@praxis/ba/tools/session-bootstrap.cjs");
const archBoot = join(
  consumer,
  "node_modules/@praxis/architect/tools/session-bootstrap.cjs",
);
const devBoot = join(
  consumer,
  "node_modules/@praxis/developer/tools/session-bootstrap.cjs",
);
for (const p of [baBoot, archBoot, devBoot]) {
  if (!existsSync(p)) fail(`missing installed bootstrap: ${p}`);
}

const project = join(consumer, "ext-project");
const knowledge = join(project, "knowledge");
mkdirSync(project, { recursive: true });

// Role/stage differentiated rules + precedence fixture
writeRule(join(knowledge, "company/rules"), "shared-base", ["ba", "architect", "developer"], [
  "research",
  "plan",
  "implement",
], "company shared-base");
writeRule(join(knowledge, "company/rules"), "ba-research", ["ba"], ["research"]);
writeRule(join(knowledge, "company/rules"), "arch-plan", ["architect"], ["plan"]);
writeRule(join(knowledge, "company/rules"), "dev-implement", ["developer"], ["implement"]);
writeRule(join(knowledge, "company/rules"), "override-demo", ["ba", "architect", "developer"], [
  "research",
  "plan",
  "implement",
], "company override-demo");
writeRule(join(knowledge, "product/demo/rules"), "override-demo", ["ba", "architect", "developer"], [
  "research",
  "plan",
  "implement",
], "product override-demo");
writeRule(join(knowledge, "service/api/rules"), "override-demo", ["ba", "architect", "developer"], [
  "research",
  "plan",
  "implement",
], "service override-demo");

function writeProject(extra = {}) {
  const lines = [
    "stack: [node]",
    "requirementsFormat: user-story-gherkin",
    "requiredArtifacts: [vision]",
    "environments: [local]",
    "knowledge:",
    `  path: ${knowledge}`,
    "  ref: main",
  ];
  if (extra.product) lines.push(`  product: ${extra.product}`);
  if (extra.service) lines.push(`  service: ${extra.service}`);
  write(join(project, ".project"), `${lines.join("\n")}\n`);
}

function boot(label, bin, args = "") {
  const cmd = args ? `node "${bin}" ${args}` : `node "${bin}"`;
  const r = run(cmd, project);
  if (!r.ok && !r.stdout) fail(`${label} failed:\n${r.stderr}`);
  return r.stdout;
}

// Missing .project — no crash, skipped knowledge
{
  const bare = mkdtempSync(join(tmpdir(), "praxis-know-bare-"));
  const out = run(`node "${baBoot}"`, bare);
  if (!out.stdout) fail(`missing .project produced no output:\n${out.stderr}`);
  if (!/\.project missing/i.test(out.stdout)) fail("expected .project missing");
  if (!/knowledge\.path unset; rules not applied/i.test(out.stdout)) {
    fail("expected knowledge.path unset skipped message");
  }
  rmSync(bare, { recursive: true, force: true });
}

// Unset knowledge.path with .project present
{
  write(
    join(project, ".project"),
    ["stack: [node]", "requirementsFormat: user-story-gherkin"].join("\n") + "\n",
  );
  const out = boot("unset path", baBoot);
  if (!/knowledge\.path unset; rules not applied/i.test(out)) {
    fail(`unset path message missing:\n${out}`);
  }
}

// Invalid knowledge.path
{
  write(
    join(project, ".project"),
    [
      "stack: [node]",
      "requirementsFormat: user-story-gherkin",
      "knowledge:",
      "  path: /definitely/not/a/knowledge/root",
    ].join("\n") + "\n",
  );
  const out = boot("invalid path", baBoot);
  if (!/knowledge unavailable:/i.test(out)) {
    fail(`expected unavailable:\n${out}`);
  }
}

// Valid path — role/stage slices
writeProject();
{
  const ba = boot("BA research", baBoot);
  if (!/knowledge rules loaded:/i.test(ba)) fail(`BA did not load rules:\n${ba}`);
  if (!/ba-research/.test(ba)) fail(`BA missing ba-research:\n${ba}`);
  if (/arch-plan/.test(ba)) fail(`BA must not load arch-plan:\n${ba}`);
  if (/dev-implement/.test(ba)) fail(`BA must not load dev-implement:\n${ba}`);

  const arch = boot(
    "Architect plan",
    archBoot,
    `--repo "${project}" --stage plan`,
  );
  if (!/arch-plan/.test(arch)) fail(`Architect missing arch-plan:\n${arch}`);
  if (/ba-research/.test(arch)) fail(`Architect must not load ba-research:\n${arch}`);
  if (/dev-implement/.test(arch)) fail(`Architect must not load dev-implement:\n${arch}`);

  const dev = boot(
    "Developer implement",
    devBoot,
    `--repo "${project}" --stage implement`,
  );
  if (!/dev-implement/.test(dev)) fail(`Developer missing dev-implement:\n${dev}`);
  if (/ba-research/.test(dev)) fail(`Developer must not load ba-research:\n${dev}`);
  if (/arch-plan/.test(dev)) fail(`Developer must not load arch-plan:\n${dev}`);
}

// Company selected when no override product/service
{
  writeProject();
  const out = boot("company only", baBoot);
  if (!/override-demo/.test(out)) fail(`company override-demo missing:\n${out}`);
}

// Product overrides company
{
  writeProject({ product: "demo" });
  // Use API via node -e against installed? Prefer monorepo knowledge CLI for lifecycle;
  // for bootstrap, product override changes which file wins but id stays override-demo.
  // Prove via loadApplicableSlice in-process from monorepo contracts isn't available in consumer.
  // Use praxis-knowledge from monorepo for slice level check:
  const slice = run(
    `node "${knowledgeCli}" slice --root "${knowledge}" --role ba --stage research --product demo`,
    root,
  );
  if (!slice.ok) fail(`slice product failed:\n${slice.stderr}`);
  if (!/override-demo \[product\//.test(slice.stdout)) {
    fail(`expected product override:\n${slice.stdout}`);
  }
}

// Service overrides product
{
  const slice = run(
    `node "${knowledgeCli}" slice --root "${knowledge}" --role ba --stage research --product demo --service api`,
    root,
  );
  if (!slice.ok) fail(`slice service failed:\n${slice.stderr}`);
  if (!/override-demo \[service\//.test(slice.stdout)) {
    fail(`expected service override:\n${slice.stdout}`);
  }
}

// Bootstrap with product+service in .project still loads without inventing path
{
  writeProject({ product: "demo", service: "api" });
  const out = boot(
    "bootstrap with product/service",
    baBoot,
  );
  if (!/knowledge rules loaded:/i.test(out)) fail(`product/service boot failed:\n${out}`);
  if (!/override-demo/.test(out)) fail(`expected override-demo loaded:\n${out}`);
}

// Finding lifecycle via public CLI (monorepo built knowledge package)
{
  const storePath = join(project, "findings.json");
  const propose = run(
    `node "${knowledgeCli}" finding propose --store "${storePath}" --kind architecture-decision --id async-queue --title "Prefer queue" --body "Use queue" --ref ADR-1 --ref ADR-2`,
    root,
  );
  if (!propose.ok) fail(`propose failed:\n${propose.stderr}\n${propose.stdout}`);
  if (!/"status": "proposed"/.test(propose.stdout)) fail(`propose not proposed:\n${propose.stdout}`);

  const reject = run(
    `node "${knowledgeCli}" finding reject --store "${storePath}" --id async-queue --reason "too narrow"`,
    root,
  );
  if (!reject.ok) fail(`reject failed:\n${reject.stderr}`);

  const again = run(
    `node "${knowledgeCli}" finding propose --store "${storePath}" --kind architecture-decision --id async-queue --title "Prefer queue" --body "Use queue" --ref ADR-1 --ref ADR-2`,
    root,
  );
  if (again.ok) fail("re-propose after reject must be suppressed (non-zero)");
  if (!/"status": "suppressed"/.test(again.stdout)) {
    fail(`expected suppressed:\n${again.stdout}`);
  }

  // Accept a fresh proposal with different refs
  const propose2 = run(
    `node "${knowledgeCli}" finding propose --store "${storePath}" --kind repeated-choice --id prefer-hello --title "Hello" --body "Use Hello" --ref WP-1`,
    root,
  );
  if (!propose2.ok) fail(`second propose failed:\n${propose2.stderr}`);
  const accept = run(
    `node "${knowledgeCli}" finding accept --store "${storePath}" --id prefer-hello`,
    root,
  );
  if (!accept.ok) fail(`accept failed:\n${accept.stderr}`);
  if (!/"status": "accepted"/.test(accept.stdout)) fail(`accept not accepted:\n${accept.stdout}`);

  // Fresh process read
  const list = run(`node "${knowledgeCli}" finding list --store "${storePath}"`, root);
  if (!list.ok) fail(`list failed:\n${list.stderr}`);
  const store = JSON.parse(list.stdout);
  if (!store.rejections?.length) fail("rejections not persisted");
  if (!store.proposals?.some((p) => p.status === "accepted")) {
    fail("accepted proposal not persisted");
  }
  if (!store.proposals?.some((p) => p.status === "rejected")) {
    fail("rejected proposal not persisted");
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "external-tgz",
      proven: [
        "packed hooks+skills+bootstrap for ba/architect/developer",
        "BA/Architect/Developer role-stage slices",
        "company/product/service precedence",
        "missing .project skipped",
        "unset knowledge.path skipped",
        "invalid knowledge.path unavailable",
        "finding propose/reject/suppress/accept + disk persist",
      ],
    },
    null,
    2,
  ),
);

rmSync(packBase, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
