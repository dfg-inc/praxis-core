import { runApprovedForTest } from "@praxis/contracts";
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

/**
 * Test-only: runs each Jira write as if the user had approved that action (the Praxis apply tool does this after the
 * user's decision). The library functions refuse to write outside such an approval.
 */
const INSTANCE = "https://praxis-test.example";
const approved = <T>(action: string, write: () => T): T => {
  if (!process.env.PRAXIS_JIRA_BASE_URL) process.env.PRAXIS_JIRA_BASE_URL = INSTANCE;
  return runApprovedForTest(action, write);
};

export function baAnalyzeEpic(opts: Parameters<typeof baAnalyzeEpicRaw>[0]) {
  return opts.dryRun ? baAnalyzeEpicRaw(opts) : approved("praxis_ba_apply", () => baAnalyzeEpicRaw(opts));
}

export function architectPlanEpic(opts: Parameters<typeof architectPlanEpicRaw>[0]) {
  return opts.dryRun ? architectPlanEpicRaw(opts) : approved("praxis_architect_apply", () => architectPlanEpicRaw(opts));
}

export function claimWorkPackage(opts: Parameters<typeof claimWorkPackageRaw>[0]) {
  return approved("praxis_developer_claim", () => claimWorkPackageRaw(opts));
}

export function developerCompleteWp(opts: Parameters<typeof developerCompleteWpRaw>[0]) {
  return approved("praxis_developer_complete", () => developerCompleteWpRaw(opts));
}

export function applyDeveloperCompleteRecovery(opts: Parameters<typeof applyDeveloperCompleteRecoveryRaw>[0]) {
  return approved("praxis_developer_complete_recovery_apply", () => applyDeveloperCompleteRecoveryRaw(opts));
}

export function applyQualityReview(opts: Parameters<typeof applyQualityReviewRaw>[0]) {
  return approved("praxis_quality_apply", () => applyQualityReviewRaw(opts));
}
