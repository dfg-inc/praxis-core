import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { installHostApproval, type ApprovalOperation } from "@praxis/contracts";
import {
  architectPlanEpic as architectPlanEpicRaw,
  baAnalyzeEpic as baAnalyzeEpicRaw,
  claimWorkPackage as claimWorkPackageRaw,
} from "../src/workflows.js";
import {
  applyDeveloperCompleteRecovery as applyDeveloperCompleteRecoveryRaw,
  developerCompleteWp as developerCompleteWpRaw,
} from "../src/developer-complete.js";
import { applyQualityReview as applyQualityReviewRaw } from "../src/quality-apply.js";

const INSTANCE = "https://praxis-test.example";

export function permitMutation(
  repo: string,
  spec: {
    action: string;
    operation: ApprovalOperation;
    workItemId: string;
    role?: "ba" | "architect" | "developer" | "quality";
    previewFingerprint?: string;
    provider?: "jira" | "local";
  },
): void {
  const root = resolve(repo);
  const provider = spec.provider ?? "jira";
  if (provider === "jira" && !process.env.PRAXIS_JIRA_BASE_URL) {
    process.env.PRAXIS_JIRA_BASE_URL = INSTANCE;
  }
  if (spec.previewFingerprint && !/^sha256:[a-f0-9]{64}$/.test(spec.previewFingerprint)) return;
  rmSync(join(root, ".praxis", "approvals"), { recursive: true, force: true });
  installHostApproval(root, {
    planId: `t-${randomUUID()}`,
    role: spec.role ?? "developer",
    provider,
    instanceId: provider === "jira" ? process.env.PRAXIS_JIRA_BASE_URL : undefined,
    workItemIds: [spec.workItemId],
    repositories: [root],
    operations: [spec.operation],
    inScope: [spec.action],
    outOfScope: [],
    assumptions: [],
    risks: ["test fixture"],
    ...(spec.previewFingerprint ? { previewFingerprint: spec.previewFingerprint } : {}),
  });
}

export function baAnalyzeEpic(opts: Parameters<typeof baAnalyzeEpicRaw>[0]) {
  if (!opts.dryRun) {
    permitMutation(opts.repo, {
      action: "praxis_ba_apply",
      operation: "external_record_update",
      workItemId: opts.epicKey,
      role: "ba",
      previewFingerprint: opts.previewFingerprint,
    });
  }
  return baAnalyzeEpicRaw(opts);
}

export function architectPlanEpic(opts: Parameters<typeof architectPlanEpicRaw>[0]) {
  if (!opts.dryRun) {
    permitMutation(opts.repo, {
      action: "praxis_architect_apply",
      operation: "external_record_update",
      workItemId: opts.epicKey,
      role: "architect",
      previewFingerprint: opts.previewFingerprint,
    });
  }
  return architectPlanEpicRaw(opts);
}

export function claimWorkPackage(opts: Parameters<typeof claimWorkPackageRaw>[0]) {
  permitMutation(opts.repo, {
    action: "praxis_developer_claim",
    operation: "external_state_change",
    workItemId: opts.wpKey,
  });
  return claimWorkPackageRaw(opts);
}

export function developerCompleteWp(opts: Parameters<typeof developerCompleteWpRaw>[0]) {
  permitMutation(opts.repo, {
    action: "praxis_developer_complete",
    operation: "external_state_change",
    workItemId: opts.wpKey,
  });
  return developerCompleteWpRaw(opts);
}

export function applyDeveloperCompleteRecovery(opts: Parameters<typeof applyDeveloperCompleteRecoveryRaw>[0]) {
  permitMutation(opts.repo, {
    action: "praxis_developer_complete_recovery_apply",
    operation: "external_state_change",
    workItemId: opts.wpKey,
    previewFingerprint: opts.previewFingerprint,
  });
  return applyDeveloperCompleteRecoveryRaw(opts);
}

export function applyQualityReview(opts: Parameters<typeof applyQualityReviewRaw>[0]) {
  permitMutation(opts.repo, {
    action: "praxis_quality_apply",
    operation: "external_state_change",
    workItemId: opts.workPackageId,
    role: "quality",
    previewFingerprint: opts.previewFingerprint,
  });
  return applyQualityReviewRaw(opts);
}
