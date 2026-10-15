#!/usr/bin/env node
/**
 * Claude Code hook for Praxis approvals.
 *
 * PreToolUse cannot see the person's Allow click, and Claude Code does not
 * give the tool a signed permission receipt. This hook asks the host to show
 * the stored plan, and records APPROVED only on PostToolUse of
 * praxis_approval_confirm after that prompt. It is not a trust boundary
 * against a same-user shell that can write the approval file or invoke this
 * script with a forged payload. Runtime mutation paths still fail closed
 * without a matching persisted record.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MUTATIONS = new Set([
  "praxis_project_init_apply",
  "praxis_ba_apply",
  "praxis_architect_apply",
  "praxis_developer_claim",
  "praxis_developer_release",
  "praxis_developer_complete",
  "praxis_developer_complete_recovery_apply",
  "praxis_quality_apply",
  "praxis_developer_git_connect_apply",
  "praxis_developer_git_identity_apply",
  "praxis_developer_git_commit",
  "praxis_developer_git_publish",
  "praxis_developer_git_merge_request",
  "praxis_developer_git_link_jira_apply",
  "praxis_workflow_apply",
  "praxis_approval_confirm",
]);

const raw = readFileSync(0, "utf8");
let event = {};
try {
  event = JSON.parse(raw || "{}");
} catch {
  deny("APPROVAL_HOOK_INVALID", "hook input was not JSON");
}

const tool = String(event.tool_name ?? "");
const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
const hookEvent = String(event.hook_event_name ?? "PreToolUse");

if (hookEvent === "PostToolUse") {
  commitIfConfirmed(event, tool, input);
  process.stdout.write("{}\n");
  process.exit(0);
}

if (tool === "praxis_plan_approve" || tool === "praxis_approval_grant" || tool === "praxis_approval_sign") {
  deny("APPROVAL_SELF_GRANT_FORBIDDEN", `${tool} cannot approve a plan`);
}

const paths = collectPaths(input);
if (paths.some((value) => /\/\.praxis\/approvals\/|\\.\praxis\\approvals\\|approval-key/.test(value))) {
  deny("APPROVAL_STORE_PROTECTED", "the approval store is not writable by an agent tool");
}

if (tool === "Bash" || tool === "Shell" || tool === "PowerShell") {
  const command = String(input.command ?? "");
  if (/\.praxis\/approvals|approval-key|PRAXIS_APPROVAL|osascript|display dialog/i.test(command)) {
    deny("APPROVAL_STORE_PROTECTED", "shell cannot read or write the approval store");
  }
}

if (MUTATIONS.has(tool)) {
  const repo = typeof input.repo === "string" ? input.repo : String(event.cwd ?? "");
  const planId = typeof input.planId === "string" ? input.planId : "";
  const loaded = loadPlan(repo, planId);
  const summary = loaded ? formatPlan(loaded) : "No stored proposal. The runtime will fail closed and will not mutate.";
  ask(summary, loaded?.fingerprint);
}

process.stdout.write("{}\n");
process.exit(0);

function collectPaths(value) {
  const found = [];
  if (!value || typeof value !== "object") return found;
  for (const key of ["file_path", "path", "target_file", "notebook_path"]) {
    if (typeof value[key] === "string") found.push(value[key]);
  }
  if (Array.isArray(value.edits)) {
    for (const edit of value.edits) found.push(...collectPaths(edit));
  }
  return found;
}

function loadPlan(repo, planId) {
  if (!repo || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(repo, ".praxis", "approvals", `${planId}.json`), "utf8"));
    return parsed.plan;
  } catch {
    return undefined;
  }
}

function formatPlan(plan) {
  return [
    "Praxis approval",
    `plan: ${plan.planId}`,
    `version: ${plan.version}`,
    `fingerprint: ${plan.fingerprint}`,
    `provider: ${plan.provider}`,
    `instance: ${plan.instanceId ?? "(local)"}`,
    `work items: ${(plan.workItemIds ?? []).join(", ")}`,
    `repositories: ${(plan.repositories ?? []).join(", ") || "(none)"}`,
    `operations: ${(plan.operations ?? []).join(", ")}`,
    `in scope: ${(plan.inScope ?? []).join("; ")}`,
    `out of scope: ${(plan.outOfScope ?? []).join("; ") || "(none)"}`,
    `risks: ${(plan.risks ?? []).join("; ") || "(none)"}`,
    `preview: ${plan.previewFingerprint ?? "(none)"}`,
  ].join("\n");
}

function commitIfConfirmed(event, tool, input) {
  if (tool !== "praxis_approval_confirm") return;
  if (/bypass/i.test(String(event.permission_mode ?? ""))) return;
  const repo = typeof input.repo === "string" ? input.repo : String(event.cwd ?? "");
  const planId = typeof input.planId === "string" ? input.planId : "";
  const plan = loadPlan(repo, planId);
  if (!plan || plan.state !== "AWAITING_APPROVAL") return;
  const claimed = typeof input.planFingerprint === "string" ? input.planFingerprint : "";
  if (!claimed || claimed !== plan.fingerprint) return;
  const now = new Date();
  plan.state = "APPROVED";
  plan.approvedAt = now.toISOString();
  plan.expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const file = join(repo, ".praxis", "approvals", `${planId}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.plan = plan;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function ask(summary, fingerprint) {
  const updatedInput = fingerprint ? { ...input, planFingerprint: fingerprint } : undefined;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hookEvent === "PermissionRequest" ? "PermissionRequest" : "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: summary,
      ...(updatedInput ? { updatedInput } : {}),
    },
  }) + "\n");
  process.exit(0);
}

function deny(code, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hookEvent === "PermissionRequest" ? "PermissionRequest" : "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${code}: ${reason}`,
    },
  }) + "\n");
  process.exit(0);
}
