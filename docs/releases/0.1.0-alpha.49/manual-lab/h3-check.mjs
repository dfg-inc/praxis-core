#!/usr/bin/env node
// Read-only snapshot for the controlled H3 check: node h3-check.mjs [copy] [storyId]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const copy = resolve(process.argv[2] ?? join(homedir(), "praxis-alpha49-h3-copy"));
const id = process.argv[3] ?? "US-ORD-004";
const dir = join(copy, ".praxis", "workflow", "items");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
  const raw = readFileSync(join(dir, f), "utf8"); const d = JSON.parse(raw);
  const s = (d.stories ?? []).find((x) => x.id === id);
  console.log(`${f} sha256:${createHash("sha256").update(raw).digest("hex").slice(0, 16)} workItemRevision ${d.workItem?.revision}`);
  console.log(`  ${id}: status=${s?.status} revision=${s?.revision} confirmedBehavior=${s?.confirmedBehavior}`);
  console.log(`  approvals[]: ${(d.approvals ?? []).length}`);
  for (const a of d.approvals ?? []) console.log(`    ${a.id} ${a.action} ${a.trust} ${(a.subjects ?? []).map((x) => x.id ?? x.ref ?? "").join(",")}`);
}
