import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authorizeOperation, proposePlan } from "./approval.js";
import {
  commitHostApproval,
  inspectMutation,
  installHostApproval,
  readApproval,
  rejectStoredApproval,
  revokeStoredApproval,
  reviseStoredApproval,
  saveProposal,
} from "./approval-store.js";
import { WorkflowError } from "./workflow.js";

const preview = `sha256:${"ab".repeat(32)}`;

function repo() {
  return mkdtempSync(join(tmpdir(), "praxis-approval-"));
}

function proposal(root: string, patch: Record<string, unknown> = {}) {
  return proposePlan({
    planId: "plan-1",
    role: "developer",
    provider: "jira",
    instanceId: "https://acme.atlassian.net",
    workItemIds: ["PRX-1"],
    repositories: [root],
    operations: ["external_record_update"],
    inScope: ["praxis_ba_apply"],
    outOfScope: ["git push"],
    assumptions: [],
    risks: ["writes the epic"],
    previewFingerprint: preview,
    ...patch,
  });
}

describe("persisted approval", () => {
  it("refuses to store an approved plan and ignores a model grant", () => {
    const root = repo();
    const plan = proposal(root);
    expect(() => saveProposal(root, { ...plan, state: "APPROVED" })).toThrow(WorkflowError);
    expect(() => inspectMutation({
      repo: root,
      operation: "external_record_update",
      provider: "jira",
      instanceId: "https://acme.atlassian.net",
      workItemId: "PRX-1",
      repository: root,
      previewFingerprint: preview,
      action: "praxis_ba_apply",
    })).toThrow(WorkflowError);
  });

  it("fails closed for the negative matrix", () => {
    const root = repo();
    const plan = proposal(root);
    saveProposal(root, plan);
    const now = new Date("2026-10-15T12:00:00.000Z");
    commitHostApproval(root, plan.planId, plan.fingerprint, now, 60_000);
    const base = {
      repo: root,
      planId: plan.planId,
      operation: "external_record_update" as const,
      provider: "jira" as const,
      instanceId: "https://acme.atlassian.net",
      workItemId: "PRX-1",
      repository: root,
      previewFingerprint: preview,
      action: "praxis_ba_apply",
      now,
    };
    expect(inspectMutation(base).kind).toBe("ready");
    expect(() => inspectMutation({ ...base, planId: "other-plan" })).toThrow(/no stored approval/);
    expect(() => inspectMutation({ ...base, planFingerprint: `sha256:${"cd".repeat(32)}` })).toThrow(WorkflowError);
    expect(() => inspectMutation({ ...base, provider: "local" })).toThrow(/provider/);
    expect(() => inspectMutation({ ...base, instanceId: "https://other.example" })).toThrow(/instance/);
    expect(() => inspectMutation({ ...base, workItemId: "PRX-9" })).toThrow(/work item/);
    expect(() => inspectMutation({ ...base, repository: "/other" })).toThrow(/repository/);
    expect(() => inspectMutation({ ...base, action: "praxis_developer_claim" })).toThrow(/praxis_developer_claim/);
    expect(() => inspectMutation({ ...base, operation: "git_push", action: "praxis_developer_git_publish" })).toThrow(WorkflowError);
    expect(() => inspectMutation({ ...base, now: new Date(now.getTime() + 120_000) })).toThrow(/expired/i);

    revokeStoredApproval(root, plan.planId);
    expect(() => inspectMutation(base)).toThrow(/revoked/);
  });

  it("rejects, revises, and does not let publication ride along", () => {
    const root = repo();
    const plan = proposal(root);
    saveProposal(root, plan);
    rejectStoredApproval(root, plan.planId);
    expect(() => inspectMutation({
      repo: root,
      planId: plan.planId,
      operation: "external_record_update",
      provider: "jira",
      instanceId: "https://acme.atlassian.net",
      workItemId: "PRX-1",
      repository: root,
      previewFingerprint: preview,
      action: "praxis_ba_apply",
    })).toThrow(/rejected/);

    const approved = installHostApproval(root, {
      planId: "plan-2",
      role: "developer",
      provider: "local",
      workItemIds: ["WI-1"],
      repositories: ["backend"],
      operations: ["repository_edit"],
      inScope: ["repository_edit"],
      outOfScope: [],
      assumptions: [],
      risks: [],
    });
    const revised = reviseStoredApproval(root, "plan-2", { operations: ["repository_edit", "external_record_update"] });
    expect(revised.version).toBe(approved.version + 1);
    expect(revised.state).toBe("AWAITING_APPROVAL");
    expect(() => authorizeOperation(approved, "deploy", { repository: "backend" })).toThrow(/own approval/);
    expect(() => authorizeOperation(approved, "release", { repository: "backend" })).toThrow(/own approval/);
    expect(() => authorizeOperation(approved, "merge", { repository: "backend" })).toThrow(/own approval/);
  });

  it("records approval from the host hook only when the displayed fingerprint matches", () => {
    const root = repo();
    const plan = proposal(root);
    saveProposal(root, plan);
    const hook = join(dirname(fileURLToPath(import.meta.url)), "../../../tools/hooks/praxis-approval-guard.mjs");
    const skipped = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "praxis_approval_confirm",
        tool_input: { repo: root, planId: plan.planId, planFingerprint: `sha256:${"cd".repeat(32)}` },
      }),
      encoding: "utf8",
    });
    expect(skipped.status).toBe(0);
    expect(readApproval(root, plan.planId).plan.state).toBe("AWAITING_APPROVAL");
    const committed = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "praxis_approval_confirm",
        tool_input: { repo: root, planId: plan.planId, planFingerprint: plan.fingerprint },
      }),
      encoding: "utf8",
    });
    expect(committed.status).toBe(0);
    expect(readApproval(root, plan.planId).plan.state).toBe("APPROVED");
    const bypassed = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        permission_mode: "bypassPermissions",
        tool_name: "praxis_approval_confirm",
        tool_input: { repo: root, planId: "plan-bypass", planFingerprint: plan.fingerprint },
      }),
      encoding: "utf8",
    });
    expect(bypassed.status).toBe(0);
  });
});
