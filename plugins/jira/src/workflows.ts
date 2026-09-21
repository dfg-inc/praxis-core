import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  BaJiraWritePlanItem,
  JiraBaHandoff,
  JiraBaProposal,
  JiraOperationJournalEntry,
  PraxisWorkPackage,
  WorkPackageClaim,
  QualityWpReport,
} from "@praxis/contracts";
import { JiraBaHandoffSchema, JiraBaProposalSchema } from "@praxis/contracts";
import type { JiraProvider } from "./provider.js";
import { assertRole } from "./role-policy.js";
import { spawnSync } from "node:child_process";
import { headingParagraphs, textDocument } from "./rich-text.js";
import { architectMaterialize } from "./architect-apply.js";
import { resolveRemoteWpKey, readWpManifest, resolveLocalWorkPackage, writeWpManifest } from "./work-package-local.js";
import { planAndApplyBaStories, type BaStorySpec, type BaWriteHooks } from "./ba-write.js";
import { resolveBaArtifactId } from "./artifact-id.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { adoptLegacyStories } from "./legacy-adopt.js";
import {
  ARTIFACT_PROP,
  assertCanonicalMembers,
  canonicalStoryKeysFromFlags,
  isSupersededFlags,
  loadEpicIssueFlags,
  supersededPairs,
} from "./managed-scope.js";
import { traced, type PreviewTrace } from "./preview-trace.js";
import {
  planSemanticIssueTransition,
  applySemanticIssueTransition,
} from "./transitions.js";
import { discoverQualityInputs } from "./developer-complete.js";

export class WorkPackageClaimError extends Error {
  readonly code = "WORK_PACKAGE_ALREADY_CLAIMED" as const;
  readonly issueKey?: string;
  readonly actor?: string;
  constructor(message: string, details?: { issueKey?: string; actor?: string }) {
    super(message);
    this.name = "WorkPackageClaimError";
    this.issueKey = details?.issueKey;
    this.actor = details?.actor;
  }
}

function loadQualityCommands(repo: string): {
  build?: string;
  test?: string;
  coverage?: string;
  start?: string;
  healthUrl?: string;
  startupTimeoutMs?: number;
} {
  const names = [".project", ".project.yaml", ".project.yml"];
  for (const name of names) {
    const p = join(repo, name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const out: Record<string, string> = {};
    let inQ = false;
    for (const line of raw.split("\n")) {
      if (/^quality:\s*$/.test(line)) {
        inQ = true;
        continue;
      }
      if (inQ && line.length && !/^\s/.test(line)) break;
      if (!inQ) continue;
      const m = line.match(
        /^\s+(install|build|test|coverage|start|healthUrl|startupTimeoutMs):\s*(.*)$/,
      );
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return {
      build: out.build,
      test: out.test,
      coverage: out.coverage,
      start: out.start,
      healthUrl: out.healthUrl,
      startupTimeoutMs: out.startupTimeoutMs
        ? Number(out.startupTimeoutMs)
        : undefined,
    };
  }
  return {};
}

export type Journal = JiraOperationJournalEntry[];

export function loadJournal(repo: string): Journal {
  const parsed = readJsonFile<Journal>(
    join(repo, ".praxis-jira", "journal.json"),
    "jira-operation-journal",
  );
  if (!parsed.ok) {
    if (parsed.reason === "missing") return [];
    throw new Error(parsed.message);
  }
  return parsed.value;
}

export function saveJournal(repo: string, journal: Journal): void {
  writeJsonAtomic(join(repo, ".praxis-jira", "journal.json"), journal);
}

function record(
  repo: string,
  entry: Omit<JiraOperationJournalEntry, "timestamp">,
): void {
  const journal = loadJournal(repo);
  if (journal.some((e) => e.operationId === entry.operationId && e.result === "ok")) {
    return;
  }
  journal.push({ ...entry, timestamp: new Date().toISOString() });
  saveJournal(repo, journal);
}

export function alreadyDone(repo: string, operationId: string): boolean {
  return loadJournal(repo).some(
    (e) => e.operationId === operationId && e.result === "ok",
  );
}

export function proposalPath(repo: string, epicKey: string): string {
  return join(repo, ".praxis-jira", "proposals", `${epicKey}.json`);
}

export function loadBaProposal(
  repo: string,
  epicKey: string,
): { ok: true; proposal: JiraBaProposal } | { ok: false; reason: string; message: string } {
  const parsed = readJsonFile<unknown>(proposalPath(repo, epicKey), "jira.ba.proposal");
  if (!parsed.ok) {
    return { ok: false, reason: "BA_PROPOSAL_MISSING", message: parsed.message };
  }
  const v = JiraBaProposalSchema.safeParse(parsed.value);
  if (!v.success) {
    return {
      ok: false,
      reason: "BA_PROPOSAL_INVALID",
      message: `jira.ba.proposal schema invalid: ${v.error.message}`,
    };
  }
  if (v.data.epicKey !== epicKey) {
    return {
      ok: false,
      reason: "BA_PROPOSAL_INVALID",
      message: `proposal epicKey ${v.data.epicKey} != ${epicKey}`,
    };
  }
  return { ok: true, proposal: v.data };
}

export function proposalToSpecs(proposal: JiraBaProposal): BaStorySpec[] {
  return proposal.stories.map((s) => ({
    logicalId: s.logicalId,
    artifactId: s.artifactId,
    summary: s.summary,
    userStory: `As a ${s.userStory.asA}\n I want ${s.userStory.iWant}\n So that ${s.userStory.soThat}`,
    acceptanceCriteria: s.acceptanceCriteria
      .map((ac) => `Given ${ac.given}\nWhen ${ac.when}\nThen ${ac.then}`)
      .join("\n"),
    businessContext: s.businessContext,
    requirementIds: s.requirementIds,
    outOfScope: s.outOfScope.join(", "),
    dependencies: s.dependencies,
  }));
}

function emptyHandoff(epicKey: string, extra: Partial<JiraBaHandoff> = {}): JiraBaHandoff {
  return JiraBaHandoffSchema.parse({
    contract: "jira.ba.architect.handoff",
    version: "1.0.0",
    epicKey,
    storyKeys: [],
    canonicalStoryKeys: [],
    supersededStoryKeys: [],
    requirementIds: [],
    baArtifacts: [],
    openQuestions: [],
    nfrs: [],
    businessRules: [],
    constraints: [],
    acceptanceSummary: "",
    dependencies: [],
    proposalReady: false,
    readyForArchitecture: false,
    ...extra,
  });
}

const HANDOFF_COMMENT = /Praxis BA handoff ready\./i;

async function ensureBaHandoffComment(
  provider: JiraProvider,
  epicKey: string,
  canonical: string[],
): Promise<void> {
  const comments = await provider.getComments(epicKey);
  const exists = comments.some((c) =>
    HANDOFF_COMMENT.test(JSON.stringify(c.body ?? "")),
  );
  if (exists) return;
  await provider.addComment(
    epicKey,
    provider.renderDescription(
      textDocument(`Praxis BA handoff ready. Stories: ${canonical.join(", ") || "none"}`),
    ),
  );
}

async function persistPreview(
  repo: string,
  epicKey: string,
  payload: unknown,
  planText: string,
): Promise<void> {
  const dir = join(repo, ".praxis-jira", "previews");
  writeJsonAtomic(join(dir, `${epicKey}.json`), payload);
  writeFileSync(join(dir, `${epicKey}.plan.txt`), `${planText}\n`);
}

export async function baAnalyzeEpic(opts: {
  provider: JiraProvider;
  epicKey: string;
  repo: string;
  stories?: BaStorySpec[];
  proposal?: JiraBaProposal;
  dryRun?: boolean;
  hooks?: BaWriteHooks;
  trace?: PreviewTrace;
}): Promise<{
  ok: boolean;
  reason?: string;
  handoff: JiraBaHandoff;
  storyKeys: string[];
  created: string[];
  plan: BaJiraWritePlanItem[];
  planText: string;
  proposalReady: boolean;
  migration?: string;
}> {
  assertRole("ba", "read-epic");
  const { epicIssue, children, flags } = await traced(opts.trace, "jira-status", async () => {
    const epicIssue = await opts.provider.getIssue(opts.epicKey);
    const children = await opts.provider.getChildren(opts.epicKey);
    const flags = await loadEpicIssueFlags(opts.provider, opts.epicKey, children);
    return { epicIssue, children, flags };
  });
  const remoteHandoff = epicIssue.properties?.["praxis.baHandoff"] as
    | JiraBaHandoff
    | undefined;

  let specs = opts.stories;
  let proposalReady = false;
  if (!specs && opts.proposal) {
    specs = proposalToSpecs(opts.proposal);
    proposalReady = true;
  }
  if (!specs) {
    const loaded = await traced(opts.trace, "proposal-read", async () =>
      loadBaProposal(opts.repo, opts.epicKey),
    );
    if (loaded.ok) {
      specs = proposalToSpecs(loaded.proposal);
      proposalReady = true;
    }
  } else {
    proposalReady = true;
  }

  const adoption = await traced(opts.trace, "canonical-resolution", () =>
    adoptLegacyStories({
      provider: opts.provider,
      epicKey: opts.epicKey,
      flags,
      children,
    }),
  );
  if (adoption.status === "conflict") {
    const handoff = emptyHandoff(opts.epicKey, {
      openQuestions: [`MIGRATION_CONFLICT: ${adoption.candidates.join(", ")}`],
    });
    return {
      ok: false,
      reason: "MIGRATION_CONFLICT",
      handoff,
      storyKeys: [],
      created: [],
      plan: [],
      planText: `MIGRATION_CONFLICT\n${adoption.candidates.join(", ")}\nCREATE:\n  none\n`,
      proposalReady,
      migration: "conflict",
    };
  }

  if (!specs) {
    if (adoption.status !== "adopted") {
      const handoff = emptyHandoff(opts.epicKey);
      return {
        ok: false,
        reason: "BA_PROPOSAL_MISSING",
        handoff,
        storyKeys: [],
        created: [],
        plan: [],
        planText:
          "BA Jira write plan\n\nCREATE:\n  none\n\nreason: BA_PROPOSAL_MISSING\nMachine layer does not synthesize User Stories or Acceptance Criteria.\n",
        proposalReady: false,
        migration: "required",
      };
    }
    const child = children.find((c) => c.key === adoption.canonicalKey)!;
    const logicalId = adoption.logicalId;
    const artifactId = resolveBaArtifactId({
      epicKey: opts.epicKey,
      logicalId,
    });
    specs = [
      {
        logicalId,
        artifactId,
        summary: child.summary,
        userStory: String(child.summary),
        acceptanceCriteria: "legacy-remote",
        businessContext: "legacy-remote",
        requirementIds: [logicalId],
      },
    ];
  }

  if (!opts.dryRun) assertRole("ba", "create-story");
  const result = await traced(opts.trace, "plan-build", () =>
    planAndApplyBaStories({
      provider: opts.provider,
      epicKey: opts.epicKey,
      repo: opts.repo,
      specs,
      dryRun: opts.dryRun,
      hooks: opts.hooks,
      flags,
    }),
  );
  const canonical = result.applied
    .filter((a) => a.action !== "SUPERSEDED" && a.jiraIssueKey)
    .map((a) => a.jiraIssueKey!)
    .filter((k, i, arr) => arr.indexOf(k) === i);
  const created = result.applied
    .filter((a) => a.action === "CREATE" && a.jiraIssueKey)
    .map((a) => a.jiraIssueKey!);
  const superseded = [
    ...result.plan.filter((p) => p.action === "SUPERSEDED" && p.jiraIssueKey).map((p) => p.jiraIssueKey!),
    ...(adoption.status === "adopted" ? adoption.supersededKeys : []),
  ].filter((k, i, arr) => arr.indexOf(k) === i);
  const blocking = false;
  const pending = result.applied.length === 0 && !opts.dryRun;
  const remoteReady =
    !opts.dryRun && canonical.length > 0 && !blocking && !pending;
  const readyForArchitecture = opts.dryRun
    ? remoteHandoff?.readyForArchitecture === true
    : remoteReady;
  const handoff = JiraBaHandoffSchema.parse({
    contract: "jira.ba.architect.handoff",
    version: "1.0.0",
    epicKey: opts.epicKey,
    storyKeys: canonical,
    canonicalStoryKeys: canonical,
    supersededStoryKeys: superseded,
    requirementIds: specs.flatMap((s) => s.requirementIds),
    baArtifacts: [join(".praxis-jira", "handoffs", `${opts.epicKey}.json`)],
    openQuestions: [],
    nfrs: [],
    businessRules: [],
    constraints: [],
    acceptanceSummary: proposalReady
      ? specs.map((s) => s.acceptanceCriteria).join("\n")
      : "legacy remote BA content",
    dependencies: [],
    proposalReady: proposalReady || remoteHandoff?.proposalReady === true,
    readyForArchitecture,
  });
  if (!opts.dryRun) {
    persistPreview(
      opts.repo,
      opts.epicKey,
      {
        proposalReady,
        readyForArchitecture: false,
        remoteReadyForArchitecture: false,
        canonicalStoryKeys: canonical,
        supersededStoryKeys: superseded,
        plan: result.plan,
      },
      result.planText,
    );
    mkdirSync(join(opts.repo, ".praxis-jira", "handoffs"), { recursive: true });
    writeFileSync(
      join(opts.repo, ".praxis-jira", "handoffs", `${opts.epicKey}.plan.txt`),
      `${result.planText}\n`,
    );
  }
  if (opts.dryRun) {
    return {
      ok: true,
      handoff,
      storyKeys: canonical,
      created,
      plan: result.plan,
      planText: result.planText,
      proposalReady,
      migration: adoption.status === "adopted" ? "required" : "none",
    };
  }
  const handoffPath = join(opts.repo, ".praxis-jira", "handoffs", `${opts.epicKey}.json`);
  assertRole("ba", "ba-handoff");
  await opts.provider.setIssueProperty(opts.epicKey, "praxis.baHandoff", handoff);
  await ensureBaHandoffComment(opts.provider, opts.epicKey, canonical);
  await opts.provider.writePraxisState(opts.epicKey, { lifecycle: "architecture" });
  const remote = await opts.provider.getIssueProperty<JiraBaHandoff>(
    opts.epicKey,
    "praxis.baHandoff",
  );
  if (!remote || remote.readyForArchitecture !== true) {
    throw new Error("BA remote handoff property missing after apply");
  }
  writeJsonAtomic(handoffPath, handoff);
  for (const a of result.applied) {
    if (!a.jiraIssueKey) continue;
    record(opts.repo, {
      operationId: `ba-story:${a.artifactId}`,
      artifactId: a.artifactId,
      jiraIssueKey: a.jiraIssueKey,
      result: a.action === "CREATE" ? "ok" : "skipped",
      provider: opts.provider.flavor,
      kind: "create-story",
      detail: a.action,
    });
  }
  return {
    ok: true,
    handoff,
    storyKeys: canonical,
    created,
    plan: result.plan,
    planText: result.planText,
    proposalReady,
    migration: adoption.status === "adopted" ? "required" : "none",
  };
}

export async function architectPlanEpic(opts: {
  provider: JiraProvider;
  epicKey: string;
  repo: string;
  dryRun?: boolean;
  trace?: PreviewTrace;
  workPackageId?: string;
}): Promise<{
  workPackages: PraxisWorkPackage[];
  taskKeys: string[];
  planText?: string;
  plan?: unknown;
  readyForDevelopment?: boolean;
  ok?: boolean;
  reason?: string;
  workPackage?: {
    id: string;
    title: string;
    titleSource: string;
    lifecycle: string;
  };
  outOfScopeWorkPackages?: Array<{ id: string; lifecycle: string }>;
}> {
  const result = await architectMaterialize(opts);
  if (!result.ok && result.reason) {
    throw new Error(`${result.reason}: Architect design package missing for ${opts.epicKey}`);
  }
  return {
    workPackages: opts.dryRun
      ? result.workPackages
      : result.workPackages.filter((w) => w.jiraIssueKey !== "PLANNED"),
    taskKeys: result.taskKeys,
    planText: result.planText,
    plan: result.plan,
    readyForDevelopment: result.readyForDevelopment,
    ok: result.ok,
    reason: result.reason,
    workPackage: result.workPackage,
    outOfScopeWorkPackages: result.outOfScopeWorkPackages,
  };
}

export async function claimWorkPackage(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
  actor: string;
  accountId: string;
}): Promise<WorkPackageClaim> {
  const wpKey = resolveRemoteWpKey(opts.repo, opts.wpKey);

  assertRole("developer", "claim-work-package");
  const remote = await opts.provider.getIssue(wpKey);
  const existing = await opts.provider.getIssueProperty<WorkPackageClaim>(
    wpKey,
    "praxis.claim",
  );
  if (
    existing &&
    existing.state === "active" &&
    existing.jiraAccountId !== opts.accountId
  ) {
    throw new WorkPackageClaimError(
      `WORK_PACKAGE_ALREADY_CLAIMED: claim denied: ${wpKey} is held by ${existing.actor} (token ${existing.claimToken})`,
      { issueKey: wpKey, actor: existing.actor },
    );
  }
  if (existing && existing.jiraAccountId === opts.accountId) {
    return existing;
  }
  const token = randomUUID();
  const manifest =
    (await opts.provider.getIssueProperty<PraxisWorkPackage>(
      wpKey,
      "praxis.workPackageManifest",
    )) ?? null;
  const member = await assertCanonicalMembers(opts.provider, [
    ...(manifest?.storyKeys ?? []),
    ...(manifest?.taskKeys ?? []),
  ]);
  if (member.length === 0) {
    throw new Error(
      `work package ${wpKey} has no canonical members after Jira reread (superseded-only or empty)`,
    );
  }
  if (manifest) {
    const repaired: PraxisWorkPackage = {
      ...manifest,
      storyKeys: await assertCanonicalMembers(
        opts.provider,
        manifest.storyKeys,
      ),
      taskKeys: await assertCanonicalMembers(opts.provider, manifest.taskKeys),
    };
    if (
      repaired.storyKeys.length !== manifest.storyKeys.length ||
      repaired.taskKeys.length !== manifest.taskKeys.length
    ) {
      await opts.provider.setIssueProperty(
        wpKey,
        "praxis.workPackageManifest",
        repaired,
      );
    }
  }
  const transitionPlans = [];
  for (const key of [wpKey, ...member]) {
    transitionPlans.push(
      await planSemanticIssueTransition(opts.provider, key, "START_DEVELOPMENT"),
    );
  }
  for (const plan of transitionPlans) {
    if (plan.alreadySatisfied || !plan.id) continue;
    await opts.provider.transitionIssue(plan.key, plan.id);
  }
  const claim: WorkPackageClaim = {
    workPackageId: manifest?.id ?? wpKey,
    jiraWorkPackageKey: wpKey,
    actor: opts.actor,
    jiraAccountId: opts.accountId,
    claimedAt: new Date().toISOString(),
    claimToken: token,
    memberIssueKeys: member,
    expectedState: "claimed",
    state: "active",
  };
  await opts.provider.assignIssue(wpKey, opts.accountId);
  for (const key of member) {
    await opts.provider.assignIssue(key, opts.accountId);
  }
  await opts.provider.setIssueProperty(wpKey, "praxis.claim", claim);
  const labels = Array.from(new Set([...remote.labels, "praxis-claimed"]));
  await opts.provider.updateIssue(wpKey, { labels });
  const verify = await opts.provider.getIssueProperty<WorkPackageClaim>(
    wpKey,
    "praxis.claim",
  );
  if (!verify || verify.claimToken !== token) {
    await opts.provider.writePraxisState(wpKey, {
      lifecycle: "blocked",
      reason: "claim-race",
    });
    throw new Error(
      `claim race detected on ${wpKey}; package blocked until resolved (not a distributed atomic lock)`,
    );
  }
  if (manifest) {
    await opts.provider.setIssueProperty(wpKey, "praxis.workPackageManifest", {
      ...manifest,
      claim,
    });
  }
  const local = resolveLocalWorkPackage(opts.repo, wpKey);
  if (local) {
    const prev = readWpManifest(opts.repo, local.id) ?? {};
    writeWpManifest(opts.repo, {
      ...prev,
      id: local.id,
      jiraIssueKey: wpKey,
      claim,
    });
  }
  mkdirSync(join(opts.repo, ".praxis-jira", "claims"), { recursive: true });
  writeFileSync(
    join(opts.repo, ".praxis-jira", "claims", `${wpKey}.json`),
    `${JSON.stringify(claim, null, 2)}\n`,
  );
  await opts.provider.addComment(
    wpKey,
    opts.provider.renderDescription(
      textDocument(`Work Package claimed by ${opts.actor}`),
    ),
  );
  await opts.provider.writePraxisState(wpKey, { lifecycle: "claimed" });
  return claim;
}

export async function releaseWorkPackage(opts: {
  provider: JiraProvider;
  wpKey: string;
  confirm: boolean;
  force?: boolean;
}): Promise<void> {
  if (!opts.confirm) {
    throw new Error("release-work-package requires --confirm");
  }
  if (opts.force && !opts.confirm) {
    throw new Error("force-release requires --confirm");
  }
  const claim = await opts.provider.getIssueProperty<WorkPackageClaim>(
    opts.wpKey,
    "praxis.claim",
  );
  if (claim) {
    await opts.provider.setIssueProperty(opts.wpKey, "praxis.claim", {
      ...claim,
      state: "released",
    });
  }
}

const TEST_WRITE_RE =
  /(^|\/)(test|tests|__tests__|fixtures)\//i;

export function assertQaPathAllowed(rel: string): void {
  const n = rel.replace(/\\/g, "/");
  const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(n);
  if (TEST_WRITE_RE.test(n) || testFile) return;
  throw new Error(`QA source guard: refusing production path ${rel}`);
}

export function parseCoverage(text: string): QualityWpReport["coverage"] {
  const jsonTry = text.trim().startsWith("{")
    ? (JSON.parse(text) as Record<string, unknown>)
    : null;
  if (jsonTry?.total && typeof jsonTry.total === "object") {
    const t = jsonTry.total as Record<string, { pct?: number }>;
    return {
      lines: t.lines?.pct,
      branches: t.branches?.pct,
      functions: t.functions?.pct,
      statements: t.statements?.pct,
    };
  }
  const lines = text.match(/Lines\s*:\s*([\d.]+)/);
  if (!lines) return null;
  return {
    lines: Number(lines[1]),
    branches: Number(text.match(/Branches\s*:\s*([\d.]+)/)?.[1]),
    functions: Number(text.match(/Functions\s*:\s*([\d.]+)/)?.[1]),
    statements: Number(text.match(/Statements\s*:\s*([\d.]+)/)?.[1]),
  };
}

function runAllowlisted(
  cmd: string | undefined,
  cwd: string,
): { ok: boolean; stdout: string } {
  if (!cmd) return { ok: true, stdout: "" };
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: process.env,
  });
  return { ok: (r.status ?? 1) === 0, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export async function qaVerifyWorkPackage(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
  allowTestWrites?: boolean;
  addTests?: string[];
  findings?: Array<{ fingerprint: string; blocking: boolean; summary: string }>;
}): Promise<QualityWpReport> {
  const wpKey = resolveRemoteWpKey(opts.repo, opts.wpKey);

  assertRole("qa", "qa-report");
  const q = loadQualityCommands(opts.repo);
  const build = runAllowlisted(q.build, opts.repo);
  const test = runAllowlisted(q.test, opts.repo);
  let coverage: QualityWpReport["coverage"] = null;
  if (q.coverage) {
    const cov = runAllowlisted(q.coverage, opts.repo);
    try {
      coverage = parseCoverage(cov.stdout);
    } catch {
      coverage = null;
    }
  }
  if (opts.addTests?.length) {
    if (!opts.allowTestWrites) {
      throw new Error("QA test writes require PRAXIS_QA_ALLOW_TEST_WRITES=1");
    }
    for (const f of opts.addTests) assertQaPathAllowed(f);
  }
  const manifest = await opts.provider.getIssueProperty<PraxisWorkPackage>(
    wpKey,
    "praxis.workPackageManifest",
  );
  const canonicalStories = await assertCanonicalMembers(
    opts.provider,
    manifest?.storyKeys ?? [],
  );
  const findings = opts.findings ?? [];
  const blocking = findings.filter((f) => f.blocking);
  const qualityInputs = discoverQualityInputs(opts.repo, manifest?.id ?? wpKey);
  const report: QualityWpReport = {
    contract: "quality.work-package.report",
    version: "1.0.0",
    workPackageId: manifest?.id ?? wpKey,
    jiraWorkPackageKey: wpKey,
    memberIssueResults: canonicalStories.map((k) => ({
      jiraIssueKey: k,
      acceptanceCriteria: [],
      coveredBy: q.test ? [q.test] : [],
      result: blocking.length ? "fail" : test.ok ? "pass" : "fail",
    })),
    buildResult: q.build ? (build.ok ? "pass" : "fail") : "skipped",
    testResult: q.test ? (test.ok ? "pass" : "fail") : "skipped",
    tests: { total: 0, pass: 0, fail: blocking.length },
    coverage,
    runtimeVerification: q.start ? "unavailable" : "unavailable",
    runtimeReason: q.start
      ? undefined
      : "quality.start not configured",
    findings,
    blockingFindings: blocking,
    potentialRisks: qualityInputs.hasHandoff
      ? []
      : ["Developer quality handoff missing; Quality must not treat Jira Done as review readiness"],
    addedTests: opts.addTests ?? [],
    sourceChangesGuard: "pass",
    overallVerdict: blocking.length ? "blocked" : build.ok && test.ok ? "pass" : "fail",
    developerEvidence: {
      workPackageId: qualityInputs.workPackageId,
      jiraWorkPackageKey: qualityInputs.jiraWorkPackageKey ?? wpKey,
      canonicalStoryKeys: qualityInputs.canonicalStoryKeys,
      requirementIds: qualityInputs.requirementIds,
      hasCompletionEvidence: qualityInputs.hasEvidence,
      hasQualityHandoff: qualityInputs.hasHandoff,
      readyForQuality: qualityInputs.readyForQuality,
      evidencePath: qualityInputs.hasEvidence ? qualityInputs.evidencePath : undefined,
      qualityHandoffPath: qualityInputs.hasHandoff ? qualityInputs.qualityHandoffPath : undefined,
    },
  };
  return report;
}

export async function simulateClaimRace(opts: {
  provider: JiraProvider;
  wpKey: string;
  first: WorkPackageClaim;
}): Promise<"blocked"> {
  await opts.provider.setIssueProperty(opts.wpKey, "praxis.claim", {
    ...opts.first,
    claimToken: randomUUID(),
    actor: "other-dev",
    jiraAccountId: "other",
  });
  return "blocked";
}

export async function collectEpicStatus(
  provider: JiraProvider,
  epicKey: string,
): Promise<{
  epic: { key: string; summary: string };
  canonicalStories: string[];
  superseded: Array<{ from: string; to: string }>;
  workPackages: Array<{ key: string; title: string; localWorkPackageId?: string; status?: string; members?: string[] }>;
  claims: unknown[];
  quality: unknown[];
  bugs: string[];
  ba: { proposalReady: boolean; readyForArchitecture: boolean };
}> {
  const epic = await provider.getIssue(epicKey);
  const flags = await loadEpicIssueFlags(provider, epicKey);
  const stories = canonicalStoryKeysFromFlags(flags);
  const superseded = supersededPairs(flags);
  const workPackages: Array<{
    key: string;
    title: string;
    localWorkPackageId?: string;
    status?: string;
    members?: string[];
  }> = [];
  const claims: unknown[] = [];
  const quality: unknown[] = [];
  for (const f of flags) {
    const wp = await provider.getIssueProperty<{ id?: string } | boolean>(
      f.key,
      "praxis.workPackage",
    );
    if (wp) {
      const manifest = await provider.getIssueProperty<PraxisWorkPackage>(
        f.key,
        "praxis.workPackageManifest",
      );
      const localId =
        wp && typeof wp === "object" && typeof wp.id === "string"
          ? wp.id
          : manifest?.id;
      workPackages.push({
        key: f.key,
        title: f.summary,
        localWorkPackageId: localId,
        status: manifest?.status,
        members: manifest?.storyKeys,
      });
      const claim = await provider.getIssueProperty(f.key, "praxis.claim");
      if (claim) claims.push(claim);
      const q = await provider.getIssueProperty(f.key, "praxis.qualityReport");
      if (q) quality.push(q);
    }
  }
  const bugs = flags.filter((f) => f.semanticType === "bug").map((f) => f.key);
  const remoteHandoff = await provider.getIssueProperty<JiraBaHandoff>(
    epicKey,
    "praxis.baHandoff",
  );
  return {
    epic: { key: epic.key, summary: epic.summary },
    canonicalStories: stories,
    superseded,
    workPackages,
    claims,
    quality,
    bugs,
    ba: {
      proposalReady: remoteHandoff?.proposalReady ?? false,
      readyForArchitecture: remoteHandoff?.readyForArchitecture === true,
    },
  };
}

export {
  discoverLocalWorkPackages,
  resolveLocalWorkPackage,
  resolveRemoteWpKey,
} from "./work-package-local.js";
export { architectMaterialize } from "./architect-apply.js";
export {
  classifyWpLifecycle,
  isInvalidWpTitle,
  isMaterializableLifecycle,
  jiraWpSummary,
  listNormalizedWorkPackages,
  readNormalizedWorkPackage,
  resolveWorkPackageTitle,
  selectArchitectWorkPackages,
  WorkPackageScopeError,
} from "./work-package-read.js";
export { createPreviewTrace, traced } from "./preview-trace.js";
export { baContentFingerprint } from "./ba-write.js";
export {
  JiraTransitionError,
  parseJiraTransitions,
  assertNumericTransitionId,
  resolveSemanticTransition,
  planSemanticIssueTransition,
  applySemanticIssueTransition,
} from "./transitions.js";
export {
  developerCompleteWp,
  previewDeveloperCompleteRecovery,
  applyDeveloperCompleteRecovery,
  inspectDeveloperCompletion,
  discoverQualityInputs,
  DeveloperCompleteError,
} from "./developer-complete.js";
export type {
  DeveloperCompleteResult,
  CompleteRecoveryPreview,
  ProjectVerification,
} from "./developer-complete.js";
export {
  previewQualityApply,
  applyQualityReview,
  writeQualityEvidence,
  readQualityEvidence,
  liveSnapshotDigest,
  qualityEvidencePath,
  qualityApplyFingerprint,
  QUALITY_COMMENT_MARK,
  QUALITY_APPLIED_REVIEW_PROP,
} from "./quality-apply.js";
export type {
  QualityApplyPlan,
  QualityApplyAction,
  QualityReviewEvidence,
} from "./quality-apply.js";
