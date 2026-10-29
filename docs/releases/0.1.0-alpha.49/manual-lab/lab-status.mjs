#!/usr/bin/env node
// Prints what Praxis has actually SAVED for a project, read straight from .praxis/workflow (not from what Claude says).
//   node lab-status.mjs [project dir]      default: current directory
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
const dir = resolve(process.argv[2] ?? ".");
const wf = join(dir, ".praxis", "workflow");
if (!existsSync(wf)) { console.log(`no Praxis state in ${dir} (.praxis/workflow is missing)`); process.exit(0); }
const index = JSON.parse(readFileSync(join(wf, "index.json"), "utf8"));
console.log(`work items: ${index.items.length}   current: ${index.current ?? "(none selected)"}`);
for (const item of index.items) {
  const s = JSON.parse(readFileSync(join(wf, "items", `${item.workItemId}.json`), "utf8"));
  const reqs = s.requirements.filter((r) => r.status !== "superseded");
  const marks = reqs.flatMap((r) => r.acceptanceCriteria.map((c) => c.review?.status ?? "pending"));
  const count = (x) => marks.filter((m) => m === x).length;
  const stories = s.stories.filter((x) => x.status !== "superseded");
  console.log(`\n== ${s.workItem.id}  "${s.workItem.title}"  mode=${s.mode}  phase=${s.phase}  version=${s.version}`);
  console.log(`   requirements: ${reqs.map((r) => `${r.id}[r${r.revision},${r.scope}]`).join(" ") || "-"}`);
  console.log(`   criteria: ${marks.length} (accepted ${count("accepted")}, rejected ${count("rejected")}, pending ${count("pending")})`);
  for (const r of reqs) for (const c of r.acceptanceCriteria) console.log(`     ${c.id}: ${c.review?.status ?? "pending"}${c.review?.via ? ` (${c.review.via})` : ""}${c.review?.comment ? ` "${c.review.comment}"` : ""}${c.review?.at ? ` decided ${c.review.at}` : ""}${c.review?.commentAt ? ` commented ${c.review.commentAt}` : ""}${c.review?.previous ? ` [previous: ${c.review.previous.status}${c.review.previous.comment ? ` "${c.review.previous.comment}"` : ""}]` : ""}  - ${c.statement.slice(0, 70)}`);
  console.log(`   accepted stages: ${Object.entries(s.phaseAcceptance ?? {}).map(([k, v]) => `${k}(${v.via})`).join(", ") || "none"}`);
  console.log(`   prototype: ${s.prototype ? `${s.prototype.kind} r${s.prototype.revision} ${s.prototype.status}, ${s.prototype.screens.length} screens, ${s.prototype.feedback.filter((f) => !f.resolved).length} open comments` : "none"}`);
  console.log(`   story plan: ${s.storyPlan ? `r${s.storyPlan.revision} ${s.storyPlan.status}: ${s.storyPlan.entries.map((e) => `${e.id}[${e.status}]`).join(" ")}` : "none"}`);
  console.log(`   stories: ${stories.map((x) => `${x.id}[r${x.revision},${x.status}${x.confirmedBehavior ? ",confirmed" : ""}]`).join(" ") || "-"}`);
  console.log(`   repositories: ${s.repositories.map((r) => `${r.id}(${r.status})`).join(" ") || "-"}   services: ${s.services.map((x) => `${x.id}@${x.repositoryId ?? "?"}[${x.status}]`).join(" ") || "-"}`);
  console.log(`   contracts: ${s.contracts.map((c) => `${c.id}[${c.status}${c.agreement ? ", agreed " + c.agreement.via : ""}]`).join(" ") || "-"}`);
  console.log(`   implementation records: ${s.implementationUnits.map((u) => `${u.serviceId}:${u.path}${u.stale ? "(stale)" : ""}`).join(" ") || "-"}`);
  console.log(`   verdicts: ${s.verdicts.map((v) => `${v.scope}:${v.verdict}${v.stale ? "(stale)" : ""}`).join(" ") || "-"}`);
  console.log(`   last session notes: ${s.sessionLog.slice(-3).map((n) => n.summary).join(" | ") || "-"}`);
}
