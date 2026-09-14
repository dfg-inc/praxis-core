#!/usr/bin/env node
import { loadJiraConfig } from "../dist/config.js";
import { createJiraProvider } from "../dist/rest-provider.js";
import {
  architectPlanEpic,
  baAnalyzeEpic,
  collectEpicStatus,
} from "../dist/workflows.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (!cmd) {
  console.error("usage: jira-workflow.mjs smoke|epic|preview|status");
  process.exit(2);
}

const provider = createJiraProvider({ config: loadJiraConfig() });

if (cmd === "smoke") {
  const v = await provider.verifyConnection();
  console.log(JSON.stringify({ ok: v.ok, ...v }, null, 2));
  process.exit(v.ok ? 0 : 1);
}

if (cmd === "epic") {
  const epic = flag("--epic");
  const issue = await provider.getIssue(epic);
  const children = await provider.getChildren(epic);
  console.log(JSON.stringify({ epic: issue, children }, null, 2));
  process.exit(0);
}

if (cmd === "preview") {
  const epic = flag("--epic");
  const repo = flag("--repo") ?? ".";
  const ba = await baAnalyzeEpic({ provider, epicKey: epic, repo, dryRun: true });
  const arch = await architectPlanEpic({
    provider,
    epicKey: epic,
    repo,
    dryRun: true,
  }).catch((e) => ({ error: String(e) }));
  console.log(ba.planText);
  console.log(JSON.stringify({ dryRun: true, ba, arch }, null, 2));
  process.exit(0);
}

if (cmd === "status") {
  const epic = flag("--epic");
  const status = await collectEpicStatus(provider, epic);
  console.log(
    [
      `Epic:`,
      `  ${status.epic.key}  ${status.epic.summary}`,
      ``,
      `Canonical Stories:`,
      ...(status.canonicalStories.length
        ? status.canonicalStories.map((k) => `  ${k}`)
        : ["  none"]),
      ``,
      `Superseded:`,
      ...(status.superseded.length
        ? status.superseded.map((s) => `  ${s.from} -> ${s.to}`)
        : ["  none"]),
      ``,
      `Work Packages:`,
      ...(status.workPackages.length
        ? status.workPackages.map((w) => `  ${w.key}  ${w.title}`)
        : ["  none"]),
      ``,
      `Claims: ${status.claims.length}`,
      `Quality: ${status.quality.length}`,
      `Bugs: ${status.bugs.join(", ") || "none"}`,
    ].join("\n"),
  );
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

console.error("usage: jira-workflow.mjs smoke|epic|preview|status");
process.exit(2);
