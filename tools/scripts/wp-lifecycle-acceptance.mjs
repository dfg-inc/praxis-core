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
  classifyWpLifecycle,
  isMaterializableLifecycle,
  readNormalizedWorkPackage,
  resolveLocalWorkPackage,
  selectArchitectWorkPackages,
} = await import("@praxis/jira/workflow");

const id = "WP-20260901-001";
const repo = mkdtempSync(join(tmpdir(), "praxis-accept-wp-life-"));
const wpDir = join(repo, "wp", id);
mkdirSync(wpDir, { recursive: true });
const raw = `---
id: ${id}
type: wp
role: developer
status: ready
phasesComplete: true
---
`;
writeFileSync(join(wpDir, "index.md"), raw);
mkdirSync(join(repo, "work-packages", id), { recursive: true });
writeFileSync(
  join(repo, "work-packages", id, "manifest.json"),
  `${JSON.stringify({ id, status: "ready", jiraIssueKey: "PLANNED" }, null, 2)}\n`,
);
mkdirSync(join(repo, "design", id), { recursive: true });
writeFileSync(
  join(repo, "design", id, "change-spec.json"),
  `${JSON.stringify({ id, design: { title: "Add decrement(value) to the counter library" } }, null, 2)}\n`,
);

const local = resolveLocalWorkPackage(repo, id);
const n = readNormalizedWorkPackage(repo, local);
if (n.lifecycle !== "historical") fail(`expected historical, got ${n.lifecycle}`);
if (n.materializable) fail("historical WP must not be materializable");
if (n.status !== "ready") fail("on-disk status must remain ready (no migration)");
if (n.jiraIssueKey !== "PLANNED") fail("on-disk jiraIssueKey must remain PLANNED");
if (isMaterializableLifecycle(n.lifecycle)) fail("historical lifecycle is materializable");
if (readFileSync(join(wpDir, "index.md"), "utf8") !== raw) fail("lifecycle inference rewrote wp index");

const classified = classifyWpLifecycle({
  status: "ready",
  phasesComplete: true,
  jiraIssueKey: "PLANNED",
});
if (classified !== "historical") fail(`classifyWpLifecycle ${classified}`);

const currentId = "WP-20260914-002";
mkdirSync(join(repo, "design", currentId), { recursive: true });
writeFileSync(
  join(repo, "design", currentId, "change-spec.json"),
  `${JSON.stringify({ id: currentId, design: { title: "Add reset() to the counter library" } }, null, 2)}\n`,
);
mkdirSync(join(repo, "wp", currentId), { recursive: true });
writeFileSync(
  join(repo, "wp", currentId, "index.md"),
  "---\nid: WP-20260914-002\ntype: wp\nrole: developer\nstatus: ready\n---\n",
);
const omitted = selectArchitectWorkPackages({ repo, epicKey: "PRX-1" });
if (omitted.selected.map((w) => w.id).join() !== currentId) {
  fail(`omitted scope should pick current WP only, got ${omitted.selected.map((w) => w.id)}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      id,
      onDisk: { status: n.status, jiraIssueKey: n.jiraIssueKey, phasesComplete: n.phasesComplete },
      normalized: { lifecycle: n.lifecycle, materializable: n.materializable },
      filesRewritten: false,
    },
    null,
    2,
  ),
);
