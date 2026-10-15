import { existsSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installHostApproval,
  proposePlan,
  rejectStoredApproval,
  revokeStoredApproval,
  saveProposal,
} from "@praxis/contracts";
import { developerGitMergeRequestOp, developerGitPublishOp, projectInitApplyOp } from "./operations.js";

const fingerprint = `sha256:${"ab".repeat(32)}`;

function repo() {
  return mkdtempSync(join(tmpdir(), "praxis-guard-"));
}

function approveInit(root: string, patch: Record<string, unknown> = {}) {
  return installHostApproval(root, {
    planId: "init-1",
    role: "ba",
    provider: "local",
    workItemIds: ["local"],
    repositories: [resolve(root)],
    operations: ["repository_edit"],
    inScope: ["praxis_project_init_apply"],
    outOfScope: ["git push"],
    assumptions: [],
    risks: ["writes .project"],
    ...patch,
  });
}

describe("mutation approval enforcement", () => {
  it("does not write when confirmation=YES has no stored approval", async () => {
    const root = repo();
    await expect(projectInitApplyOp({
      repo: root,
      confirmation: "YES",
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(existsSync(join(root, ".project"))).toBe(false);
  });

  it("does not treat a rejected or revoked approval as permission to write", async () => {
    const root = repo();
    const plan = proposePlan({
      planId: "init-1",
      role: "ba",
      provider: "local",
      workItemIds: ["local"],
      repositories: [resolve(root)],
      operations: ["repository_edit"],
      inScope: ["praxis_project_init_apply"],
      outOfScope: [],
      assumptions: [],
      risks: ["writes .project"],
    });
    saveProposal(root, plan);
    rejectStoredApproval(root, plan.planId);
    await expect(projectInitApplyOp({ repo: root, confirmation: "YES", planId: plan.planId })).rejects.toMatchObject({
      code: "APPROVAL_REJECTED",
    });
    expect(existsSync(join(root, ".project"))).toBe(false);

    approveInit(root, { planId: "init-2" });
    revokeStoredApproval(root, "init-2");
    await expect(projectInitApplyOp({ repo: root, confirmation: "YES", planId: "init-2" })).rejects.toMatchObject({
      code: "APPROVAL_REVOKED",
    });
    expect(existsSync(join(root, ".project"))).toBe(false);
  });

  it("writes once for a matching approval and does not write again on replay", async () => {
    const root = repo();
    approveInit(root);
    const first = await projectInitApplyOp({ repo: root, confirmation: "YES", planId: "init-1" });
    expect(first.wrote).toBe(true);
    const path = first.path;
    expect(existsSync(path)).toBe(true);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(path, old, old);
    const second = await projectInitApplyOp({ repo: root, confirmation: "YES", planId: "init-1" });
    expect(second.replayed).toBe(true);
    expect(statSync(path).mtime.toISOString()).toBe(old.toISOString());
  });

  it("refuses git publish and merge request without that operation in the approval", async () => {
    const root = repo();
    approveInit(root);
    await expect(developerGitPublishOp({
      repo: root,
      wp: "WP-1",
      confirmation: "YES",
      planId: "init-1",
      previewFingerprint: fingerprint,
    })).rejects.toMatchObject({ code: "APPROVAL_SCOPE_SEPARATE" });
    await expect(developerGitMergeRequestOp({
      repo: root,
      wp: "WP-1",
      confirmation: "YES",
      planId: "init-1",
      previewFingerprint: fingerprint,
    })).rejects.toMatchObject({ code: "APPROVAL_SCOPE_SEPARATE" });
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});
