#!/usr/bin/env node
import { loadJiraConfig } from "../dist/config.js";
import { createJiraProvider } from "../dist/rest-provider.js";
import { baAnalyzeEpic, architectPlanEpic } from "../dist/workflows.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
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
  console.log(JSON.stringify({ dryRun: true, ba, arch }, null, 2));
  process.exit(0);
}

if (cmd === "status") {
  const epic = flag("--epic");
  const issue = await provider.getIssue(epic);
  const children = await provider.getChildren(epic);
  const claim = await provider.getIssueProperty(epic, "praxis.claim");
  console.log(
    JSON.stringify(
      { epic: issue, children, claim, state: await provider.readPraxisState(epic) },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.error("usage: jira-workflow.mjs smoke|epic|preview|status");
process.exit(2);
