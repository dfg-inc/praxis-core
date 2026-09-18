#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const built = spawnSync("npm run build -w @praxis/contracts -w @praxis/jira", {
  cwd: root,
  shell: true,
  encoding: "utf8",
});
if ((built.status ?? 1) !== 0) fail(`build failed\n${built.stderr || built.stdout}`);

const {
  readNormalizedWorkPackage,
  resolveLocalWorkPackage,
  resolveWorkPackageTitle,
  selectArchitectWorkPackages,
  WorkPackageScopeError,
} = await import("@praxis/jira/workflow");

function seed(repo, id, opts = {}) {
  const design = join(repo, "design", id);
  mkdirSync(design, { recursive: true });
  const wpDir = join(repo, "wp", id);
  mkdirSync(wpDir, { recursive: true });
  const fm = ["---", `id: ${id}`, "type: wp", "role: developer", `status: ${opts.status ?? "ready"}`];
  if (opts.manifestTitle !== undefined) fm.push(`title: ${opts.manifestTitle}`);
  fm.push("---", "");
  writeFileSync(join(wpDir, "index.md"), `${fm.join("\n")}\n`);
  writeFileSync(join(design, "index.md"), opts.heading ? `# ${opts.heading}\n\nbody\n` : "body\n");
  const spec = { id };
  if (opts.designTitle) spec.design = { title: opts.designTitle };
  writeFileSync(join(design, "change-spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

const cases = {};

{
  const title = resolveWorkPackageTitle({
    manifestTitle: "From manifest",
    changeSpecTitle: "From design",
  });
  if (title.title !== "From manifest" || title.titleSource !== "manifest") fail(`CASE A: ${JSON.stringify(title)}`);
  cases.A = title;
}

{
  const repo = mkdtempSync(join(tmpdir(), "praxis-title-b-"));
  seed(repo, "WP-20260914-002", { designTitle: "Add reset() to the counter library" });
  const local = resolveLocalWorkPackage(repo, "WP-20260914-002");
  const n = readNormalizedWorkPackage(repo, local);
  if (n.title !== "Add reset() to the counter library") fail(`CASE B title ${n.title}`);
  if (n.titleSource !== "design.change-spec") fail(`CASE B source ${n.titleSource}`);
  if (n.jiraSummary !== "[WP-20260914-002] Add reset() to the counter library") fail(`CASE B summary ${n.jiraSummary}`);
  cases.B = { title: n.title, titleSource: n.titleSource, summary: n.jiraSummary };
}

{
  const title = resolveWorkPackageTitle({
    storySummary: "Counter library: add reset() to return the counter to zero",
  });
  if (title.titleSource !== "derived.story") fail(`CASE C: ${JSON.stringify(title)}`);
  cases.C = title;
}

{
  const repo = mkdtempSync(join(tmpdir(), "praxis-title-d-"));
  seed(repo, "WP-20260914-002", {});
  let code;
  try {
    selectArchitectWorkPackages({
      repo,
      epicKey: "PRX-1",
      workPackageId: "WP-20260914-002",
    });
  } catch (e) {
    code = e instanceof WorkPackageScopeError ? e.code : e instanceof Error ? e.message : String(e);
  }
  if (code !== "WORK_PACKAGE_TITLE_INVALID") fail(`CASE D expected TITLE_INVALID, got ${code}`);
  cases.D = { code };
}

{
  const repo = mkdtempSync(join(tmpdir(), "praxis-title-e-"));
  seed(repo, "WP-20260914-002", { manifestTitle: "---", heading: "---" });
  let code;
  try {
    selectArchitectWorkPackages({
      repo,
      epicKey: "PRX-1",
      workPackageId: "WP-20260914-002",
    });
  } catch (e) {
    code = e instanceof WorkPackageScopeError ? e.code : e instanceof Error ? e.message : String(e);
  }
  if (code !== "WORK_PACKAGE_TITLE_INVALID") fail(`CASE E expected TITLE_INVALID, got ${code}`);
  cases.E = { code };
}

console.log(JSON.stringify({ ok: true, version, cases }, null, 2));
