#!/usr/bin/env node
// Read-only report for scenario H: the persisted approvals[] of the COPY, and proof that the source Work Item is untouched.
//   node approval-check.mjs [copy dir]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
const copy = resolve(process.argv[2] ?? join(homedir(), "praxis-alpha49-approval-copy"));
const lab = process.env.PRAXIS_LAB ?? join(homedir(), "praxis-alpha49-lab");
const items = join(copy, ".praxis/workflow/items");
for (const f of readdirSync(items).filter((x) => x.endsWith(".json"))) {
  const s = JSON.parse(readFileSync(join(items, f), "utf8"));
  console.log(`== ${s.workItem.id}  revision-history ${s.history.length}  coverageRevision ${s.coverageRevision}`);
  console.log(`approvals[]: ${s.approvals.length}`);
  for (const a of s.approvals) {
    console.log(`  ${a.id} ${a.action} at ${a.at} channel=${a.channel} assurance=${a.assurance} trust=${a.trust} actor=${a.actor ?? "(none: the client does not identify the person)"}`);
    for (const x of a.subjects ?? []) console.log(`     subject ${x.type} ${x.id} r${x.revision} ${x.contentFingerprint ?? ""}`);
  }
  const legacy = Object.entries(s.phaseAcceptance ?? {}).filter(([k, v]) => !s.approvals.some((a) => (a.subjects ?? []).some((x) => x.contentFingerprint === v.fingerprint)));
  console.log(`decisions without a record (unverified provenance, never upgraded): ${legacy.map(([k]) => k).join(", ") || "none"}`);
}
const srcItems = join(lab, "projects/orders-app/.praxis/workflow/items");
const want = existsSync(join(copy, ".source-sha256")) ? readFileSync(join(copy, ".source-sha256"), "utf8").trim().split("\n") : [];
let ok = want.length > 0;
for (const line of want) {
  const [sha, name] = line.split(/\s+/);
  const now = createHash("sha256").update(readFileSync(join(srcItems, name))).digest("hex");
  if (now !== sha) { ok = false; console.log(`SOURCE CHANGED: ${name}`); }
}
console.log(ok ? "source Work Item: unchanged" : "source Work Item: CHECK FAILED");
