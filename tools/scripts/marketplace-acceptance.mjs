#!/usr/bin/env node
/**
 * Local Marketplace / catalog / license / changelog acceptance (WBS 7.x local).
 * Does not deploy or provision TLS.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const site = join(root, "apps/marketplace-site");
const docs = join(site, "docs");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".vitepress" || name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const catalog = JSON.parse(
  readFileSync(join(root, "packages/catalog/catalog.json"), "utf8"),
);
const catalogPage = readFileSync(join(docs, "catalog/index.md"), "utf8");
for (const p of catalog.plugins) {
  if (!catalogPage.includes(p.name)) fail(`catalog page missing ${p.name}`);
  const doc = join(docs, "plugins", `${p.name.replace("praxis-", "")}.md`);
  if (!existsSync(doc)) fail(`7.6.2 missing plugin page ${relative(root, doc)}`);
}

if (!Array.isArray(catalog.unpublished) || catalog.unpublished.length < 2) {
  fail("7.2.2 unpublished quality/jira not declared in catalog.json");
}

for (const id of ["ba", "architect", "developer"]) {
  const lic = join(root, "plugins", id, "LICENSE");
  const pkg = JSON.parse(readFileSync(join(root, "plugins", id, "package.json"), "utf8"));
  if (!existsSync(lic)) fail(`missing LICENSE ${id}`);
  if (pkg.license !== "Apache-2.0") fail(`${id} license ${pkg.license}`);
}
const jiraPkg = JSON.parse(readFileSync(join(root, "plugins/jira/package.json"), "utf8"));
const qPkg = JSON.parse(readFileSync(join(root, "apps/quality-service/package.json"), "utf8"));
if (jiraPkg.license !== "UNLICENSED") fail("jira must stay UNLICENSED");
if (qPkg.license !== "UNLICENSED") fail("quality-service must stay UNLICENSED");

const mdFiles = walk(docs).filter((f) => extname(f) === ".md");
for (const file of mdFiles) {
  const text = readFileSync(file, "utf8");
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const href = m[1].split("#")[0].split("?")[0];
    if (!href || href.startsWith("http") || href.startsWith("mailto:")) continue;
    let target;
    if (href.startsWith("/")) {
      const relDoc = href.replace(/^\//, "").replace(/\/$/, "");
      target = join(docs, `${relDoc}.md`);
      const asIndex = join(docs, relDoc, "index.md");
      if (!existsSync(target) && !existsSync(asIndex)) {
        fail(`7.4.2 broken link in ${relative(root, file)} -> ${href}`);
      }
      continue;
    }
    target = resolve(dirname(file), href.endsWith(".md") ? href : `${href}.md`);
    const asIndex = resolve(dirname(file), href, "index.md");
    if (!existsSync(target) && !existsSync(asIndex) && !existsSync(resolve(dirname(file), href))) {
      fail(`7.4.2 broken link in ${relative(root, file)} -> ${href}`);
    }
  }
}

const changelog = readFileSync(join(docs, "changelog.md"), "utf8");
if (!catalog.plugins.every((p) => changelog.toLowerCase().includes(p.name))) {
  fail("changelog missing plugin name");
}

const build = spawnSync("npm", ["run", "build", "-w", "@praxis/marketplace-site"], {
  cwd: root,
  encoding: "utf8",
});
if ((build.status ?? 1) !== 0) {
  fail(`marketplace build failed:\n${build.stderr || build.stdout}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "local-marketplace",
      proven: [
        "7.1 catalog names listed on site",
        "7.2 Apache role plugins + unpublished jira/quality",
        "7.4 local VitePress build",
        "7.4.2 internal markdown links resolve",
        "7.6 plugin pages exist for catalog entries",
      ],
      pending: [
        "7.3 public mirror hosting",
        "7.4.1 production deploy pipeline",
        "7.5 domain/TLS",
        "7.8 public site changelog after remote publish",
      ],
      version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    },
    null,
    2,
  ),
);
