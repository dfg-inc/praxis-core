import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DeveloperCompletionEvidenceSchema,
  DeveloperToQualityHandoffSchema,
  type AcceptanceCheck,
  type DeveloperCompletionEvidence,
  type DeveloperToQualityHandoff,
  type PraxisWorkPackage,
  type WorkPackageClaim,
} from "@praxis/contracts";
import type { JiraProvider } from "./provider.js";
import { assertRole } from "./role-policy.js";
import {
  applySemanticIssueTransition,
  isSemanticStatusSatisfied,
} from "./transitions.js";
import {
  readWpManifest,
  resolveLocalWorkPackage,
  resolveRemoteWpKey,
  writeWpManifest,
} from "./work-package-local.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { headingParagraphs } from "./rich-text.js";

const COMPLETE_COMMENT_MARK = "Praxis: implementation complete, ready for Quality";

export class DeveloperCompleteError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "DeveloperCompleteError";
    this.code = code;
    this.details = details;
  }
}

export type ProjectVerification = {
  command: string;
  exitCode: number;
  ok: boolean;
  stdout: string;
  passed?: number;
  failed?: number;
  total?: number;
  timestamp: string;
};

export type DeveloperCompleteResult = {
  completed: true;
  workPackageId: string;
  jiraWorkPackageKey: string;
  implementationState: "complete";
  readyForQuality: true;
  qualityStarted: false;
  qualityApproved: false;
  claimState: "active";
  jiraStatus?: string;
  jiraStatusCategory?: string;
  verification: {
    command: string;
    passed?: number;
    failed?: number;
    exitCode: number;
    ok: boolean;
  };
  evidencePath: string;
  qualityHandoffPath: string;
  idempotent: boolean;
};

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function loadQualityTestCommand(repo: string): string | undefined {
  const names = [".project", ".project.yaml", ".project.yml"];
  for (const name of names) {
    const p = join(repo, name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    let inQ = false;
    for (const line of raw.split("\n")) {
      if (/^quality:\s*$/.test(line)) {
        inQ = true;
        continue;
      }
      if (inQ && line.length && !/^\s/.test(line)) break;
      if (!inQ) continue;
      const m = line.match(/^\s+test:\s*(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  const pkgPath = join(repo, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: { test?: string } };
      if (pkg.scripts?.test) return "npm test";
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function parseTestCounts(output: string): {
  passed?: number;
  failed?: number;
  total?: number;
} {
  const vitest = output.match(/Tests\s+(\d+)\s+passed(?:\s+\((\d+)\))?/i);
  if (vitest) {
    const passed = Number(vitest[1]);
    const failedMatch = output.match(/(\d+)\s+failed/i);
    const failed = failedMatch ? Number(failedMatch[1]) : 0;
    return { passed, failed, total: Number(vitest[2] ?? passed + failed) };
  }
  const jest = output.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(\d+)\s+passed/i);
  if (jest) {
    const failed = jest[1] ? Number(jest[1]) : 0;
    const passed = Number(jest[2]);
    return { passed, failed, total: passed + failed };
  }
  const tap = [...output.matchAll(/^ok\s+\d+/gm)].length;
  const tapNot = [...output.matchAll(/^not ok\s+\d+/gm)].length;
  if (tap || tapNot) return { passed: tap, failed: tapNot, total: tap + tapNot };
  return {};
}

export function runProjectVerification(repo: string): ProjectVerification {
  const command = loadQualityTestCommand(repo);
  if (!command) {
    throw new DeveloperCompleteError(
      "VERIFICATION_FAILED",
      "no quality.test command in .project and no npm test script",
    );
  }
  const r = spawnSync(command, {
    cwd: repo,
    shell: true,
    encoding: "utf8",
    env: process.env,
  });
  const stdout = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const exitCode = r.status ?? 1;
  const counts = parseTestCounts(stdout);
  const timestamp = new Date().toISOString();
  const ok = exitCode === 0 && (counts.failed === undefined || counts.failed === 0);
  return { command, exitCode, ok, stdout, timestamp, ...counts };
}

export function completionPaths(repo: string, workPackageId: string) {
  const design = join(repo, "design", workPackageId);
  const dev = join(design, "dev");
  return {
    designDir: design,
    evidencePath: join(dev, "completion-evidence.json"),
    qualityHandoffPath: join(dev, "quality-handoff.json"),
    changeSpecPath: join(design, "change-spec.json"),
    architectHandoffPath: join(design, "architect-developer.handoff.json"),
  };
}

function readChangeSpec(repo: string, id: string) {
  const p = completionPaths(repo, id).changeSpecPath;
  return readJson(p) ?? {};
}

function acceptanceFromSpec(spec: Record<string, unknown>): AcceptanceCheck[] {
  const raw = spec.acceptanceChecks;
  if (Array.isArray(raw) && raw.length) return raw as AcceptanceCheck[];
  return [{ type: "npm-test" }];
}

export function inspectDeveloperCompletion(repo: string, workPackageId: string) {
  const paths = completionPaths(repo, workPackageId);
  const evidence = readJson(paths.evidencePath);
  const handoff = readJson(paths.qualityHandoffPath);
  const local = readWpManifest(repo, workPackageId);
  return {
    evidencePath: paths.evidencePath,
    qualityHandoffPath: paths.qualityHandoffPath,
    hasEvidence: Boolean(evidence),
    hasHandoff: Boolean(handoff),
    localClaim: (local?.claim as WorkPackageClaim | null | undefined) ?? null,
    localStatus: local?.status,
    implementationState: local?.implementationState ?? evidence?.implementationStatus,
    readyForQuality: local?.readyForQuality === true || evidence?.readyForQuality === true,
  };
}

function persistLocalComplete(opts: {
  repo: string;
  workPackageId: string;
  wpKey: string;
  claim: WorkPackageClaim | undefined;
  verification: ProjectVerification;
}) {
  const local = resolveLocalWorkPackage(opts.repo, opts.workPackageId);
  if (!local) return;
  const prev = readWpManifest(opts.repo, local.id) ?? {};
  writeWpManifest(opts.repo, {
    ...prev,
    id: local.id,
    jiraIssueKey: opts.wpKey,
    status: "ready-for-qa",
    implementationState: "complete",
    readyForQuality: true,
    qualityState: "pending",
    claim: opts.claim
      ? { ...opts.claim, state: "active", expectedState: "ready-for-qa" }
      : (prev.claim ?? null),
  });
  const claimFile = join(opts.repo, ".praxis-jira", "claims", `${opts.wpKey}.json`);
  if (opts.claim) {
    mkdirSync(join(opts.repo, ".praxis-jira", "claims"), { recursive: true });
    writeFileSync(claimFile, `${JSON.stringify({ ...opts.claim, state: "active" }, null, 2)}\n`);
  }
  void opts.verification;
}

export async function developerCompleteWp(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
  evidence?: {
    branch?: string;
    commits?: string[];
    tests?: string;
    verification?: { ok?: boolean };
  };
}): Promise<DeveloperCompleteResult> {
  const wpKey = resolveRemoteWpKey(opts.repo, opts.wpKey);
  assertRole("developer", "developer-evidence");

  if (opts.evidence?.verification?.ok === false) {
    throw new DeveloperCompleteError(
      "VERIFICATION_FAILED",
      "cannot mark implementation complete: verification failed",
    );
  }

  const localWp = resolveLocalWorkPackage(opts.repo, opts.wpKey);
  const workPackageId = localWp?.id ?? opts.wpKey;
  const paths = completionPaths(opts.repo, workPackageId);

  const issue = await opts.provider.getIssue(wpKey);
  if (isSemanticStatusSatisfied("QUALITY_APPROVED", issue)) {
    throw new DeveloperCompleteError(
      "PREMATURE_JIRA_DONE",
      `Jira ${wpKey} is already in a Done category; use developer complete recovery preview/apply`,
      {
        issueKey: wpKey,
        currentStatus: issue.status,
        currentStatusCategory: issue.statusCategory,
      },
    );
  }

  const verification = runProjectVerification(opts.repo);
  if (!verification.ok) {
    throw new DeveloperCompleteError(
      "VERIFICATION_FAILED",
      `verification command failed (exit ${verification.exitCode})`,
      {
        command: verification.command,
        exitCode: verification.exitCode,
        passed: verification.passed,
        failed: verification.failed,
      },
    );
  }

  const manifest =
    (await opts.provider.getIssueProperty<PraxisWorkPackage>(
      wpKey,
      "praxis.workPackageManifest",
    )) ?? null;
  if (!manifest) {
    throw new DeveloperCompleteError(
      "WORK_PACKAGE_INVALID_STATE",
      `missing work package manifest on ${wpKey}`,
    );
  }

  const existing = inspectDeveloperCompletion(opts.repo, workPackageId);
  const already = existing.hasEvidence && existing.hasHandoff;
  const spec = readChangeSpec(opts.repo, workPackageId);
  const requirementIds = Array.isArray(spec.requirementIds)
    ? (spec.requirementIds as string[])
    : Array.isArray(manifest.storyKeys)
      ? manifest.storyKeys
      : [];
  const files = [
    ...(Array.isArray(spec.files) ? (spec.files as string[]) : []),
    ...(Array.isArray(spec.changes)
      ? (spec.changes as Array<{ file?: string }>).map((c) => c.file).filter((f): f is string => Boolean(f))
      : []),
  ];
  const arch = readJson(paths.architectHandoffPath) ?? {};
  const features = Array.isArray(spec.features)
    ? (spec.features as Array<{ id: string; title?: string }>)
    : Array.isArray(arch.features)
      ? (arch.features as Array<{ id: string; title?: string }>)
      : [];
  const acceptanceChecks = acceptanceFromSpec(spec);

  mkdirSync(join(paths.designDir, "dev"), { recursive: true });
  let evidence: DeveloperCompletionEvidence;
  let handoff: DeveloperToQualityHandoff;
  try {
    evidence = DeveloperCompletionEvidenceSchema.parse({
      contract: "developer.completion.evidence",
      version: "1.0.0",
      workPackageId,
      jiraWorkPackageKey: wpKey,
      canonicalStoryKeys: manifest.storyKeys ?? [],
      requirementIds,
      implementationScope: features.map((f) => f.id),
      changedProductFiles: files,
      acceptanceChecks,
      verification: {
        command: verification.command,
        exitCode: verification.exitCode,
        ok: true,
        passed: verification.passed,
        failed: verification.failed,
        total: verification.total,
        timestamp: verification.timestamp,
      },
      implementationStatus: "complete",
      readyForQuality: true,
    });
    writeJsonAtomic(paths.evidencePath, evidence);
  } catch (err) {
    throw new DeveloperCompleteError(
      "EVIDENCE_PERSIST_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    handoff = DeveloperToQualityHandoffSchema.parse({
      contract: "developer.quality.handoff",
      version: "1.0.0",
      workPackageId,
      mergeRequestRef: `local/${workPackageId}`,
      intention: `Implementation complete for ${workPackageId}; ready for Quality review`,
      requirementIds,
      decisionIds: Array.isArray(arch.decisionIds) ? (arch.decisionIds as string[]) : [],
      verification: {
        build: { status: "skipped", required: false },
        tests: { status: "passed", required: true },
        lint: { status: "skipped", required: false },
        packageCriteria: { status: "passed", required: true },
      },
      acceptanceChecks,
      jiraWorkPackageKey: wpKey,
      canonicalStoryKeys: manifest.storyKeys ?? [],
      evidencePath: paths.evidencePath,
    });
    writeJsonAtomic(paths.qualityHandoffPath, handoff);
  } catch (err) {
    throw new DeveloperCompleteError(
      "HANDOFF_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }

  const claim = await opts.provider.getIssueProperty<WorkPackageClaim>(wpKey, "praxis.claim");
  const nextClaim = claim
    ? { ...claim, state: "active" as const, expectedState: "ready-for-qa" as const }
    : undefined;
  try {
    if (nextClaim) {
      await opts.provider.setIssueProperty(wpKey, "praxis.claim", nextClaim);
    }
    await opts.provider.setIssueProperty(wpKey, "praxis.workPackageManifest", {
      ...manifest,
      status: "ready-for-qa",
      claim: nextClaim ?? manifest.claim,
    });
    await opts.provider.writePraxisState(wpKey, {
      lifecycle: "ready-for-qa",
      implementationState: "complete",
      readyForQuality: true,
      qualityState: "pending",
    });
    persistLocalComplete({
      repo: opts.repo,
      workPackageId,
      wpKey,
      claim: nextClaim,
      verification,
    });
  } catch (err) {
    throw new DeveloperCompleteError(
      "JIRA_PROPERTY_UPDATE_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!already) {
    await opts.provider.addComment(
      wpKey,
      opts.provider.renderDescription(
        headingParagraphs([
          { heading: COMPLETE_COMMENT_MARK, body: `verification: ${verification.command}` },
          {
            heading: "Evidence",
            body: `${paths.evidencePath}\n${paths.qualityHandoffPath}`,
          },
        ]),
      ),
    );
  }

  const after = await opts.provider.getIssue(wpKey);
  return {
    completed: true,
    workPackageId,
    jiraWorkPackageKey: wpKey,
    implementationState: "complete",
    readyForQuality: true,
    qualityStarted: false,
    qualityApproved: false,
    claimState: "active",
    jiraStatus: after.status,
    jiraStatusCategory: after.statusCategory,
    verification: {
      command: verification.command,
      passed: verification.passed,
      failed: verification.failed,
      exitCode: verification.exitCode,
      ok: true,
    },
    evidencePath: paths.evidencePath,
    qualityHandoffPath: paths.qualityHandoffPath,
    idempotent: already,
  };
}

export type CompleteRecoveryPreview = {
  needed: boolean;
  workPackageId: string;
  jiraWorkPackageKey: string;
  currentStatus?: string;
  currentStatusCategory?: string;
  missingEvidence: boolean;
  missingHandoff: boolean;
  prematureDone: boolean;
  proposed: Array<{ action: string; detail: string }>;
  previewFingerprint: string;
};

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function previewDeveloperCompleteRecovery(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
}): Promise<CompleteRecoveryPreview> {
  const wpKey = resolveRemoteWpKey(opts.repo, opts.wpKey);
  const local = resolveLocalWorkPackage(opts.repo, opts.wpKey);
  const workPackageId = local?.id ?? opts.wpKey;
  const issue = await opts.provider.getIssue(wpKey);
  const inspection = inspectDeveloperCompletion(opts.repo, workPackageId);
  const prematureDone = isSemanticStatusSatisfied("QUALITY_APPROVED", issue);
  const missingEvidence = !inspection.hasEvidence;
  const missingHandoff = !inspection.hasHandoff;
  const needed = prematureDone || missingEvidence || missingHandoff;
  const proposed: Array<{ action: string; detail: string }> = [];
  if (prematureDone) {
    proposed.push({
      action: "RESTORE_DEVELOPMENT",
      detail: `Transition ${wpKey} from ${issue.status} to development (START_DEVELOPMENT); do not leave Done without Quality approval`,
    });
  }
  if (missingEvidence) {
    proposed.push({
      action: "WRITE_EVIDENCE",
      detail: completionPaths(opts.repo, workPackageId).evidencePath,
    });
  }
  if (missingHandoff) {
    proposed.push({
      action: "WRITE_QUALITY_HANDOFF",
      detail: completionPaths(opts.repo, workPackageId).qualityHandoffPath,
    });
  }
  if (needed) {
    proposed.push({
      action: "RECONCILE_STATE",
      detail: "implementationState=complete, readyForQuality=true, claim.state=active, Jira stays In Progress",
    });
  }
  const preview = {
    needed,
    workPackageId,
    jiraWorkPackageKey: wpKey,
    currentStatus: issue.status,
    currentStatusCategory: issue.statusCategory,
    missingEvidence,
    missingHandoff,
    prematureDone,
    proposed,
    previewFingerprint: "",
  };
  preview.previewFingerprint = fingerprint({
    wpKey,
    workPackageId,
    prematureDone,
    missingEvidence,
    missingHandoff,
    proposed,
  });
  return preview;
}

export async function applyDeveloperCompleteRecovery(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
  previewFingerprint: string;
}): Promise<DeveloperCompleteResult> {
  const preview = await previewDeveloperCompleteRecovery(opts);
  if (preview.previewFingerprint !== opts.previewFingerprint) {
    throw new DeveloperCompleteError(
      "CONFLICT",
      "previewFingerprint mismatch; re-run recovery preview",
      { expected: preview.previewFingerprint, got: opts.previewFingerprint },
    );
  }
  if (preview.prematureDone) {
    assertRole("developer", "transition-in-progress");
    await applySemanticIssueTransition(opts.provider, preview.jiraWorkPackageKey, "START_DEVELOPMENT");
  }
  return developerCompleteWp({
    provider: opts.provider,
    wpKey: opts.wpKey,
    repo: opts.repo,
  });
}

export function discoverQualityInputs(repo: string, workPackageId: string) {
  const inspection = inspectDeveloperCompletion(repo, workPackageId);
  const handoff = readJson(inspection.qualityHandoffPath);
  const evidence = readJson(inspection.evidencePath);
  return {
    workPackageId,
    jiraWorkPackageKey: (evidence?.jiraWorkPackageKey ?? handoff?.jiraWorkPackageKey) as string | undefined,
    canonicalStoryKeys: (evidence?.canonicalStoryKeys ?? handoff?.canonicalStoryKeys) as string[] | undefined,
    requirementIds: (evidence?.requirementIds ?? handoff?.requirementIds) as string[] | undefined,
    acceptanceChecks: (handoff?.acceptanceChecks ?? evidence?.acceptanceChecks) as unknown,
    evidence,
    handoff,
    readyForQuality: inspection.readyForQuality,
    hasHandoff: inspection.hasHandoff,
    hasEvidence: inspection.hasEvidence,
    evidencePath: inspection.evidencePath,
    qualityHandoffPath: inspection.qualityHandoffPath,
  };
}
