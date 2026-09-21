#!/usr/bin/env node
/**
 * Documentation portal + shared Marketplace source acceptance.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canonical = join(root, "docs/user");
const marketplaceDocs = join(root, "apps/marketplace-site/docs");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function walk(dir, acc = [], skip = new Set()) {
  for (const name of readdirSync(dir)) {
    if (name === ".vitepress" || name === "node_modules" || skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc, skip);
    else acc.push(p);
  }
  return acc;
}

function sha(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const requiredPages = [
  "index.md",
  "getting-started/overview.md",
  "getting-started/requirements.md",
  "getting-started/installation.md",
  "getting-started/credentials.md",
  "getting-started/first-run.md",
  "getting-started/update.md",
  "getting-started/uninstall.md",
  "concepts/runtime.md",
  "concepts/plugins.md",
  "concepts/skills.md",
  "concepts/work-packages.md",
  "concepts/jira-workflow.md",
  "concepts/approvals.md",
  "plugins/overview.md",
  "plugins/ba.md",
  "plugins/architect.md",
  "plugins/developer.md",
  "plugins/quality.md",
  "workflows/full-e2e.md",
  "workflows/existing-epic.md",
  "workflows/ba-only.md",
  "workflows/architect-only.md",
  "workflows/developer-only.md",
  "workflows/quality-only.md",
  "workflows/resume.md",
  "reference/configuration.md",
  "reference/tools.md",
  "reference/artifacts.md",
  "reference/prompts.md",
  "reference/permissions.md",
  "reference/secrets.md",
  "reference/troubleshooting.md",
  "reference/faq.md",
  "reference/changelog.md",
];

for (const rel of requiredPages) {
  const p = join(canonical, rel);
  if (!existsSync(p)) fail(`missing canonical page ${rel}`);
}

const install = readFileSync(join(canonical, "getting-started/installation.md"), "utf8");
for (const needle of [
  "praxis-runtime.mcpb",
  "praxis-ba.zip",
  "praxis-architect.zip",
  "praxis-developer.zip",
  "praxis-quality.zip",
  "PRAXIS_RUNTIME_UNAVAILABLE",
  "jira_token",
]) {
  if (!install.includes(needle)) fail(`installation guide missing ${needle}`);
}
if (/launchctl setenv/.test(install) && /standard/.test(install.toLowerCase())) {
  fail("installation must not recommend launchctl as standard");
}
if (install.includes(".mcp.json")) fail("canonical install still documents .mcp.json");

const qualityGuide = readFileSync(join(canonical, "plugins/quality.md"), "utf8");
for (const needle of [
  "praxis_quality_ensure",
  "praxis_quality_status",
  "not_started",
  "QUALITY_PACKAGE_MISSING",
  "QUALITY_SQLITE_UNAVAILABLE",
  "praxis-quality.cjs",
  "sql.js",
]) {
  if (!qualityGuide.includes(needle)) fail(`quality guide missing ${needle}`);
}
if (/make quality-up/.test(qualityGuide) && /normal/.test(qualityGuide.toLowerCase())) {
  fail("quality guide must not recommend make quality-up as normal");
}

for (const f of [
  "claude-extensions/praxis-runtime.mcpb",
  "claude-plugins/praxis-ba.zip",
  "claude-plugins/praxis-architect.zip",
  "claude-plugins/praxis-developer.zip",
  "claude-plugins/praxis-quality.zip",
]) {
  if (!existsSync(join(root, f))) fail(`documented artifact missing: ${f}`);
}

const secretHits = [];
for (const file of walk(canonical)) {
  if (extname(file) !== ".md") continue;
  const text = readFileSync(file, "utf8");
  if (/ATATT3xFfGF0|praxis-integration-test\.atlassian\.net/.test(text)) {
    secretHits.push(relative(root, file));
  }
}
if (secretHits.length) fail(`possible live secrets in docs: ${secretHits.join(", ")}`);

const catalogSrc = readFileSync(join(root, "packages/mcp/src/catalog.ts"), "utf8");
const toolNames = [...catalogSrc.matchAll(/name: "(praxis_[a-z0-9_]+)"/g)].map((m) => m[1]);
const toolsPage = readFileSync(join(canonical, "reference/tools.md"), "utf8");
for (const name of toolNames) {
  if (!toolsPage.includes(name)) fail(`tools.md missing catalog tool ${name}`);
}

const e2e = readFileSync(join(canonical, "workflows/full-e2e.md"), "utf8");
for (let i = 1; i <= 20; i += 1) {
  if (!e2e.includes(`STEP ${i}`)) fail(`e2e tutorial missing STEP ${i}`);
}

const prompts = readFileSync(join(canonical, "reference/prompts.md"), "utf8");
for (const tag of ["READ ONLY", "PREVIEW", "WRITE"]) {
  if (!prompts.includes(tag)) fail(`prompt library missing ${tag}`);
}

const mdFiles = walk(canonical);
for (const file of mdFiles) {
  if (extname(file) !== ".md") continue;
  const text = readFileSync(file, "utf8");
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const href = m[1].split("#")[0].split("?")[0];
    if (!href || href.startsWith("http") || href.startsWith("mailto:")) continue;
    if (href.startsWith("/getting-started") || href.startsWith("/concepts")
      || href.startsWith("/plugins") || href.startsWith("/workflows") || href.startsWith("/reference")
      || href === "/") {
      const relDoc = href.replace(/^\//, "").replace(/\/$/, "");
      const target = join(canonical, `${relDoc}.md`);
      const asIndex = join(canonical, relDoc, "index.md");
      const rootIndex = relDoc === "" ? join(canonical, "index.md") : null;
      if (!existsSync(target) && !existsSync(asIndex) && !(rootIndex && existsSync(rootIndex))) {
        fail(`broken portal link in ${relative(root, file)} -> ${href}`);
      }
      continue;
    }
    if (href.startsWith("/")) continue;
    const target = resolve(dirname(file), href.endsWith(".md") ? href : `${href}.md`);
    const asIndex = resolve(dirname(file), href, "index.md");
    if (!existsSync(target) && !existsSync(asIndex) && !existsSync(resolve(dirname(file), href))) {
      fail(`broken relative link in ${relative(root, file)} -> ${href}`);
    }
  }
}

const sync = spawnSync("node", [join(root, "tools/scripts/sync-user-docs.mjs")], {
  cwd: root,
  encoding: "utf8",
});
if ((sync.status ?? 1) !== 0) fail(`sync-user-docs failed\n${sync.stderr || sync.stdout}`);

const mirrored = join(marketplaceDocs, "user-guide");
for (const rel of requiredPages) {
  const a = join(canonical, rel);
  const b = join(mirrored, rel);
  if (!existsSync(b)) fail(`marketplace mirror missing ${rel}`);
  if (sha(a) !== sha(b)) fail(`Marketplace/VitePress source diverged: ${rel}`);
}

const marketStart = readFileSync(join(marketplaceDocs, "guide/start.md"), "utf8");
if (marketStart.includes(".mcp.json")) fail("marketplace start still documents .mcp.json");
if (!marketStart.includes("praxis-runtime.mcpb")) fail("marketplace start missing Runtime MCPB");
if (!marketStart.includes("/user-guide/getting-started/installation")) {
  fail("marketplace start must link canonical install");
}
if (!marketStart.includes("/user-guide/reference/prompts")) {
  fail("marketplace start must link prompt library");
}

const docsBuild = spawnSync("npm", ["run", "build", "-w", "@praxis/docs-site"], {
  cwd: root,
  encoding: "utf8",
});
if ((docsBuild.status ?? 1) !== 0) fail(`docs-site build failed\n${docsBuild.stderr || docsBuild.stdout}`);

const marketBuild = spawnSync("npm", ["run", "build", "-w", "@praxis/marketplace-site"], {
  cwd: root,
  encoding: "utf8",
});
if ((marketBuild.status ?? 1) !== 0) {
  fail(`marketplace build failed\n${marketBuild.stderr || marketBuild.stdout}`);
}

const dist = join(root, "apps/docs-site/.vitepress/dist");
if (!existsSync(join(dist, "index.html"))) fail("docs-site dist missing index.html");

console.log(
  JSON.stringify(
    {
      ok: true,
      canonicalPages: requiredPages.length,
      toolsChecked: toolNames.length,
      sharedSource: "docs/user -> apps/marketplace-site/docs/user-guide (build copy)",
      docsSite: "apps/docs-site srcDir=docs/user",
    },
    null,
    2,
  ),
);
