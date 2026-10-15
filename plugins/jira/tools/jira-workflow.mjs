#!/usr/bin/env node
import { resolve } from "node:path";
import { loadJiraConfig } from "../dist/config.js";
import { createJiraProvider } from "../dist/rest-provider.js";
import {
  architectPlanEpic,
  baAnalyzeEpic,
  collectEpicStatus,
} from "../dist/workflows.js";
import {
  abortConsumption,
  beginConsumption,
  completeConsumption,
  inspectMutation,
} from "@praxis/contracts";

const argv = process.argv.slice(2);
const cmd = argv[0];
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function requireStoredApproval(repo, action, operation, workItemId) {
  const root = resolve(repo);
  let inspection;
  try {
    inspection = inspectMutation({
      repo: root,
      operation,
      provider: "jira",
      instanceId: process.env.PRAXIS_JIRA_BASE_URL,
      workItemId,
      repository: root,
      previewFingerprint: flag("--fingerprint"),
      action,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "APPROVAL_REQUIRED";
    console.error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (inspection.kind === "replay") return inspection;
  if (flag("--confirm") !== "YES") {
    console.error(`${action} requires --confirm YES`);
    process.exit(1);
  }
  if (inspection.kind === "ready") beginConsumption(root, inspection.planId, inspection.key, action);
  return { ...inspection, root };
}

function formatIssue(issue) {
  const p = issue.properties ?? {};
  return [
    `  ${issue.key}`,
    `    summary: ${issue.summary}`,
    `    status: ${issue.status}`,
    `    issueType: ${issue.issueType}`,
    `    semanticType: ${issue.semanticType ?? ""}`,
    `    parent: ${issue.parentKey ?? ""}`,
    `    managed: ${p["praxis.managed"] ?? ""}`,
    `    artifactId: ${p["praxis.artifactId"] ?? ""}`,
    `    superseded: ${Boolean(p["praxis.superseded"] || p["praxis.supersededBy"])}`,
    `    supersededBy: ${p["praxis.supersededBy"] ?? ""}`,
  ].join("\n");
}

if (!cmd) {
  console.error(
    "usage: jira-workflow.mjs smoke|epic|status|discover|ba-preview|ba-apply|architect-preview|architect-apply",
  );
  process.exit(2);
}

const provider = createJiraProvider({ config: loadJiraConfig() });

if (cmd === "smoke") {
  const v = await provider.verifyConnection();
  console.log(JSON.stringify({ ok: v.ok, ...v }, null, 2));
  process.exit(v.ok ? 0 : 1);
}

if (cmd === "discover") {
  const meta = await provider.discoverMetadata();
  console.log(
    JSON.stringify(
      {
        issueTypes: meta.issueTypes.map((t) => ({
          id: t.id,
          displayName: t.displayName ?? t.name,
          hierarchyLevel: t.hierarchyLevel,
          semanticType: t.semanticType,
        })),
        epicTypeId: meta.epicTypeId,
        storyTypeId: meta.storyTypeId,
        taskTypeId: meta.taskTypeId,
        bugTypeId: meta.bugTypeId,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (cmd === "epic") {
  const epic = flag("--epic");
  const issue = await provider.getIssue(epic);
  const children = await provider.getChildren(epic);
  const verbose = argv.includes("--verbose") || process.env.VERBOSE === "1";
  console.log(`Epic:\n  key: ${issue.key}\n  summary: ${issue.summary}\n  status: ${issue.status}\n  issueType: ${issue.issueType}\n`);
  console.log("Children:\n");
  for (const c of children) console.log(formatIssue(c) + "\n");
  if (verbose) console.log(JSON.stringify({ epic: issue, children }, null, 2));
  process.exit(0);
}

if (cmd === "ba-preview") {
  const epic = flag("--epic");
  const repo = flag("--repo") ?? ".";
  const ba = await baAnalyzeEpic({
    provider,
    epicKey: epic,
    repo,
    dryRun: true,
  });
  console.log(ba.planText);
  console.log(
    JSON.stringify(
      {
        ok: ba.ok,
        reason: ba.reason,
        dryRun: true,
        proposalReady: ba.proposalReady,
        readyForArchitecture: ba.handoff.readyForArchitecture,
        canonicalStoryKeys: ba.handoff.canonicalStoryKeys,
        supersededStoryKeys: ba.handoff.supersededStoryKeys,
        plan: ba.plan,
      },
      null,
      2,
    ),
  );
  process.exit(ba.ok || ba.reason === "BA_PROPOSAL_MISSING" ? 0 : 1);
}

if (cmd === "ba-apply") {
  const epic = flag("--epic");
  const repo = flag("--repo") ?? ".";
  const gate = requireStoredApproval(repo, "praxis_ba_apply", "external_record_update", epic);
  if (gate.kind === "replay") {
    console.log(JSON.stringify({ ok: true, replayed: true }, null, 2));
    process.exit(0);
  }
  let ba;
  try {
    ba = await baAnalyzeEpic({
      provider,
      epicKey: epic,
      repo,
      dryRun: false,
    });
    completeConsumption(gate.root, gate.planId, gate.key, "praxis_ba_apply", { ok: ba.ok });
  } catch (error) {
    abortConsumption(gate.root, gate.planId, gate.key, "praxis_ba_apply");
    throw error;
  }
  console.log(ba.planText);
  console.log(JSON.stringify({ ok: ba.ok, created: ba.created, storyKeys: ba.storyKeys }, null, 2));
  process.exit(ba.ok ? 0 : 1);
}

if (cmd === "architect-preview") {
  const epic = flag("--epic");
  const repo = flag("--repo") ?? ".";
  try {
    const arch = await architectPlanEpic({
      provider,
      epicKey: epic,
      repo,
      dryRun: true,
    });
    if (arch.planText) console.log(arch.planText);
    console.log(JSON.stringify({ ok: true, dryRun: true, arch }, null, 2));
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ ok: false, skipped: true, reason: msg }, null, 2));
    process.exit(0);
  }
}

if (cmd === "architect-apply") {
  const epic = flag("--epic");
  const repo = flag("--repo") ?? ".";
  const gate = requireStoredApproval(repo, "praxis_architect_apply", "external_record_update", epic);
  if (gate.kind === "replay") {
    console.log(JSON.stringify({ ok: true, replayed: true, dryRun: false }, null, 2));
    process.exit(0);
  }
  let arch;
  try {
    arch = await architectPlanEpic({
      provider,
      epicKey: epic,
      repo,
      dryRun: false,
    });
    completeConsumption(gate.root, gate.planId, gate.key, "praxis_architect_apply", { ok: arch.ok !== false });
  } catch (error) {
    abortConsumption(gate.root, gate.planId, gate.key, "praxis_architect_apply");
    throw error;
  }
  if (arch.planText) console.log(arch.planText);
  console.log(
    JSON.stringify(
      {
        ok: arch.ok !== false,
        dryRun: false,
        workPackages: arch.workPackages,
        taskKeys: arch.taskKeys,
        readyForDevelopment: arch.readyForDevelopment,
        plan: arch.plan,
      },
      null,
      2,
    ),
  );
  process.exit(arch.ok === false ? 4 : 0);
}

if (cmd === "status") {
  const epic = flag("--epic");
  const status = await collectEpicStatus(provider, epic);
  console.log(
    [
      `Epic:`,
      `  ${status.epic.key}`,
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
      `Developer claims: ${status.claims.length}`,
      `Quality: ${status.quality.length}`,
      `Bugs: ${status.bugs.join(", ") || "none"}`,
      ``,
      `BA:`,
      `  proposalReady: ${status.ba?.proposalReady ?? false}`,
      `  readyForArchitecture: ${status.ba?.readyForArchitecture ?? false}`,
    ].join("\n"),
  );
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

console.error("usage: jira-workflow.mjs smoke|epic|status|discover|ba-preview|ba-apply|architect-preview|architect-apply");
process.exit(2);
