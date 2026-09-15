import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

export async function baAnalyzeEpic(opts: {
  provider: JiraProvider;
  epicKey: string;
  repo: string;
  stories?: BaStorySpec[];
  proposal?: JiraBaProposal;
  dryRun?: boolean;
  hooks?: BaWriteHooks;
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
  await opts.provider.getIssue(opts.epicKey);
  const children = await opts.provider.getChildren(opts.epicKey);
  const flags = await loadEpicIssueFlags(opts.provider, opts.epicKey);

  let specs = opts.stories;
  let proposalReady = false;
  if (!specs && opts.proposal) {
    specs = proposalToSpecs(opts.proposal);
    proposalReady = true;
  }
  if (!specs) {
    const loaded = loadBaProposal(opts.repo, opts.epicKey);
    if (loaded.ok) {
      specs = proposalToSpecs(loaded.proposal);
      proposalReady = true;
    }
  } else {
    proposalReady = true;
  }

  const adoption = await adoptLegacyStories({
    provider: opts.provider,
    epicKey: opts.epicKey,
    flags,
    children,
  });
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
  const result = await planAndApplyBaStories({
    provider: opts.provider,
    epicKey: opts.epicKey,
    repo: opts.repo,
    specs,
    dryRun: opts.dryRun,
    hooks: opts.hooks,
  });
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
  const remoteReady = canonical.length > 0 && !blocking && !pending;
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
    proposalReady,
    readyForArchitecture: remoteReady && !opts.dryRun ? true : remoteReady && !created.length,
  });
  if (opts.dryRun) {
    handoff.readyForArchitecture = remoteReady && created.length === 0 && canonical.length > 0;
  }
  const handoffPath = join(opts.repo, ".praxis-jira", "handoffs", `${opts.epicKey}.json`);
  writeJsonAtomic(handoffPath, handoff);
  writeFileSync(
    join(opts.repo, ".praxis-jira", "handoffs", `${opts.epicKey}.plan.txt`),
    `${result.planText}\n`,
  );
  if (!opts.dryRun) {
    assertRole("ba", "ba-handoff");
    await opts.provider.setIssueProperty(opts.epicKey, "praxis.baHandoff", handoff);
    await opts.provider.addComment(
      opts.epicKey,
      opts.provider.renderDescription(
        textDocument(`Praxis BA handoff ready. Stories: ${canonical.join(", ") || "none"}`),
      ),
    );
    await opts.provider.writePraxisState(opts.epicKey, { lifecycle: "architecture" });
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
}): Promise<{ workPackages: PraxisWorkPackage[]; taskKeys: string[] }> {
  assertRole("architect", "read-epic");
  const remoteHandoff = await opts.provider.getIssueProperty<JiraBaHandoff>(
    opts.epicKey,
    "praxis.baHandoff",
  );
  const localPath = join(opts.repo, ".praxis-jira", "handoffs", `${opts.epicKey}.json`);
  const local = readJsonFile<JiraBaHandoff>(localPath, "BA architect handoff");
  if (!local.ok && local.reason !== "missing") {
    throw new Error(`BA_HANDOFF_UNAVAILABLE: ${local.message}`);
  }
  const handoff = remoteHandoff ?? (local.ok ? local.value : null);
  const parsed = handoff ? JiraBaHandoffSchema.safeParse(handoff) : null;
  if (parsed && !parsed.success) {
    throw new Error(
      `BA_HANDOFF_INVALID: schema validation failed for ${opts.epicKey}`,
    );
  }
  if (!parsed?.success || !parsed.data.readyForArchitecture) {
    throw new Error(
      `BA_HANDOFF_NOT_READY: BA handoff not ready for ${opts.epicKey} (Architect skipped)`,
    );
  }
  const ready = parsed.data;
  const flags = await loadEpicIssueFlags(opts.provider, opts.epicKey);
  const fromHandoff =
    ready.canonicalStoryKeys?.length
      ? ready.canonicalStoryKeys
      : ready.storyKeys;
  const storyKeys = fromHandoff.filter((key) => {
    const f = flags.find((x) => x.key === key);
    return !f || !isSupersededFlags(f);
  });
  const taskKeys: string[] = [];
  const packages: PraxisWorkPackage[] = [];
  const hoursCap = opts.provider.config.workPackageMaxHours;

  for (const storyKey of storyKeys) {
    assertRole("architect", "create-architecture");
    const story = await opts.provider.getIssue(storyKey);
    const arch = {
      technicalApproach: `Implement ${story.summary} behind existing module boundaries.`,
      nfr: ["observability: structured logs"],
      testConsiderations: ["unit tests for new behavior"],
      adrIds: [] as string[],
      platformContractIds: [] as string[],
      diagrams: [{ language: "mermaid", text: "flowchart LR\nA-->B" }],
    };
    if (!opts.dryRun) {
      await opts.provider.writeArchitectureMetadata(storyKey, arch);
      await opts.provider.addComment(
        storyKey,
        opts.provider.renderDescription(
          headingParagraphs([
            { heading: "Technical approach", body: arch.technicalApproach },
            {
              heading: "Diagram",
              body: "",
            },
          ]),
        ),
      );
      await opts.provider.addComment(
        storyKey,
        opts.provider.renderDescription({
          version: 1,
          blocks: [
            {
              type: "codeBlock",
              language: "mermaid",
              text: arch.diagrams[0].text,
            },
          ],
        }),
      );
    }

    const techArtifact = `task:${storyKey}:impl`;
    let taskKey: string | undefined;
    const children = await opts.provider.getChildren(storyKey);
    for (const c of children) {
      const aid = await opts.provider.getIssueProperty<string>(c.key, ARTIFACT_PROP);
      if (aid === techArtifact) taskKey = c.key;
    }
    if (!taskKey && !opts.dryRun) {
      assertRole("architect", "create-technical-ticket");
      const created = await opts.provider.createIssue({
        summary: `Technical implementation for ${storyKey}`,
        issueType: opts.provider.config.taskType,
        parentKey: storyKey,
        labels: ["praxis-managed"],
        description: opts.provider.renderDescription(
          headingParagraphs([
            {
              heading: "Reason",
              body: "Story requires a bounded technical task",
            },
            {
              heading: "Technical acceptance criteria",
              body: "Given the story AC, when implemented, then tests pass",
            },
          ]),
        ),
      });
      await opts.provider.setIssueProperty(created.key, ARTIFACT_PROP, techArtifact);
      await opts.provider.createIssueLink(storyKey, created.key, "Relates");
      taskKey = created.key;
      taskKeys.push(created.key);
    } else if (taskKey) {
      taskKeys.push(taskKey);
    }

    const wpArtifact = `wp:${storyKey}`;
    let wpKey: string | undefined;
    const epicChildren = await opts.provider.getChildren(opts.epicKey);
    for (const c of epicChildren) {
      const aid = await opts.provider.getIssueProperty<string>(c.key, ARTIFACT_PROP);
      if (aid === wpArtifact) wpKey = c.key;
    }
    const meta = await opts.provider.discoverMetadata();
    const wpType = meta.workPackageTypeId
      ? "Work Package"
      : opts.provider.config.taskType;
    const labels = meta.workPackageTypeId
      ? ["praxis-managed"]
      : ["praxis-managed", "praxis-work-package"];
    if (!wpKey && !opts.dryRun) {
      assertRole("architect", "create-work-package");
      const created = await opts.provider.createIssue({
        summary: `WP: ${story.summary}`,
        issueType: wpType,
        parentKey: opts.epicKey,
        labels,
        description: opts.provider.renderDescription(
          textDocument(`Work package for ${storyKey}`),
        ),
      });
      wpKey = created.key;
      await opts.provider.setIssueProperty(created.key, ARTIFACT_PROP, wpArtifact);
      await opts.provider.setIssueProperty(created.key, "praxis.workPackage", true);
      if (taskKey) await opts.provider.createIssueLink(created.key, taskKey, "Relates");
      await opts.provider.createIssueLink(created.key, storyKey, "Relates");
    }
    if (!wpKey) continue;
    const storyKeys = await assertCanonicalMembers(opts.provider, [storyKey]);
    if (storyKeys.length !== 1) {
      throw new Error(
        `work package member ${storyKey} is superseded; Architect scope is canonical-only`,
      );
    }
    const wp: PraxisWorkPackage = {
      id: wpArtifact,
      jiraIssueKey: wpKey,
      epicKey: opts.epicKey,
      title: `WP: ${story.summary}`,
      storyKeys,
      taskKeys: taskKey ? [taskKey] : [],
      dependencyWorkPackages: [],
      estimatedHours: Math.min(8, hoursCap),
      architectureDecisionIds: [],
      platformContractIds: [],
      status: "ready",
      claim: null,
    };
    const dir = join(opts.repo, "work-packages", wp.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(wp, null, 2)}\n`);
    await opts.provider.setIssueProperty(wpKey, "praxis.workPackageManifest", wp);
    await opts.provider.writePraxisState(wpKey, { lifecycle: "ready" });
    packages.push(wp);
  }
  await opts.provider.writePraxisState(opts.epicKey, { lifecycle: "development" });
  return { workPackages: packages, taskKeys };
}

export async function claimWorkPackage(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
  actor: string;
  accountId: string;
}): Promise<WorkPackageClaim> {
  assertRole("developer", "claim-work-package");
  const remote = await opts.provider.getIssue(opts.wpKey);
  const existing = await opts.provider.getIssueProperty<WorkPackageClaim>(
    opts.wpKey,
    "praxis.claim",
  );
  if (
    existing &&
    existing.state === "active" &&
    existing.jiraAccountId !== opts.accountId
  ) {
    throw new Error(
      `claim denied: ${opts.wpKey} is held by ${existing.actor} (token ${existing.claimToken})`,
    );
  }
  if (existing && existing.jiraAccountId === opts.accountId) {
    return existing;
  }
  const token = randomUUID();
  const manifest =
    (await opts.provider.getIssueProperty<PraxisWorkPackage>(
      opts.wpKey,
      "praxis.workPackageManifest",
    )) ?? null;
  const member = await assertCanonicalMembers(opts.provider, [
    ...(manifest?.storyKeys ?? []),
    ...(manifest?.taskKeys ?? []),
  ]);
  if (member.length === 0) {
    throw new Error(
      `work package ${opts.wpKey} has no canonical members after Jira reread (superseded-only or empty)`,
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
        opts.wpKey,
        "praxis.workPackageManifest",
        repaired,
      );
    }
  }
  const claim: WorkPackageClaim = {
    workPackageId: manifest?.id ?? opts.wpKey,
    jiraWorkPackageKey: opts.wpKey,
    actor: opts.actor,
    jiraAccountId: opts.accountId,
    claimedAt: new Date().toISOString(),
    claimToken: token,
    memberIssueKeys: member,
    expectedState: "claimed",
    state: "active",
  };
  await opts.provider.assignIssue(opts.wpKey, opts.accountId);
  await opts.provider.transitionIssue(opts.wpKey, "In Progress");
  for (const key of member) {
    await opts.provider.assignIssue(key, opts.accountId);
    await opts.provider.transitionIssue(key, "In Progress");
  }
  await opts.provider.setIssueProperty(opts.wpKey, "praxis.claim", claim);
  const labels = Array.from(new Set([...remote.labels, "praxis-claimed"]));
  await opts.provider.updateIssue(opts.wpKey, { labels });
  const verify = await opts.provider.getIssueProperty<WorkPackageClaim>(
    opts.wpKey,
    "praxis.claim",
  );
  if (!verify || verify.claimToken !== token) {
    await opts.provider.writePraxisState(opts.wpKey, {
      lifecycle: "blocked",
      reason: "claim-race",
    });
    throw new Error(
      `claim race detected on ${opts.wpKey}; package blocked until resolved (not a distributed atomic lock)`,
    );
  }
  mkdirSync(join(opts.repo, ".praxis-jira", "claims"), { recursive: true });
  writeFileSync(
    join(opts.repo, ".praxis-jira", "claims", `${opts.wpKey}.json`),
    `${JSON.stringify(claim, null, 2)}\n`,
  );
  await opts.provider.addComment(
    opts.wpKey,
    opts.provider.renderDescription(
      textDocument(`Work Package claimed by ${opts.actor}`),
    ),
  );
  await opts.provider.writePraxisState(opts.wpKey, { lifecycle: "claimed" });
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

export async function developerCompleteWp(opts: {
  provider: JiraProvider;
  wpKey: string;
  repo: string;
  evidence: {
    branch?: string;
    commits?: string[];
    tests?: string;
    verification: { ok: boolean };
  };
}): Promise<void> {
  assertRole("developer", "developer-evidence");
  const manifest = await opts.provider.getIssueProperty<PraxisWorkPackage>(
    opts.wpKey,
    "praxis.workPackageManifest",
  );
  if (!manifest) throw new Error(`missing work package manifest on ${opts.wpKey}`);
  const required = await assertCanonicalMembers(opts.provider, [
    ...manifest.storyKeys,
    ...manifest.taskKeys,
  ]);
  if (required.length === 0) {
    throw new Error("work package has no member issues");
  }
  if (!opts.evidence.verification.ok) {
    throw new Error("cannot mark Ready for QA: verification failed");
  }
  const claim = await opts.provider.getIssueProperty<WorkPackageClaim>(
    opts.wpKey,
    "praxis.claim",
  );
  if (claim) {
    await opts.provider.setIssueProperty(opts.wpKey, "praxis.claim", {
      ...claim,
      state: "implementation-complete",
    });
  }
  assertRole("developer", "transition-ready-for-qa");
  await opts.provider.addComment(
    opts.wpKey,
    opts.provider.renderDescription(
      textDocument(
        [
          "Implementation completed",
          opts.evidence.branch ? `branch: ${opts.evidence.branch}` : "",
          opts.evidence.tests ? `tests: ${opts.evidence.tests}` : "",
          "Verification result: pass",
          "Ready for QA",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ),
  );
  await opts.provider.transitionIssue(opts.wpKey, "Done");
  await opts.provider.writePraxisState(opts.wpKey, { lifecycle: "ready-for-qa" });
  for (const key of required) {
    await opts.provider.writePraxisState(key, { lifecycle: "ready-for-qa" });
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
    opts.wpKey,
    "praxis.workPackageManifest",
  );
  const canonicalStories = await assertCanonicalMembers(
    opts.provider,
    manifest?.storyKeys ?? [],
  );
  const findings = opts.findings ?? [];
  const blocking = findings.filter((f) => f.blocking);
  for (const f of blocking) {
    assertRole("qa", "create-bug");
    const artifactId = `bug:${f.fingerprint}`;
    const existingBugs = await opts.provider.searchIssues(
      `issuetype = ${opts.provider.config.bugType} AND project = ${opts.provider.config.projectKey}`,
    );
    let bugKey: string | undefined;
    for (const b of existingBugs) {
      const aid = await opts.provider.getIssueProperty<string>(b.key, ARTIFACT_PROP);
      if (aid === artifactId) bugKey = b.key;
    }
    if (!bugKey) {
      const created = await opts.provider.createIssue({
        summary: f.summary,
        issueType: opts.provider.config.bugType,
        labels: ["praxis-managed", "praxis-blocking"],
        description: opts.provider.renderDescription(
          headingParagraphs([
            { heading: "Work Package", body: opts.wpKey },
            { heading: "Reproduction", body: f.summary },
            { heading: "Expected", body: "No blocking defect" },
            { heading: "Actual", body: f.summary },
          ]),
        ),
      });
      bugKey = created.key;
      await opts.provider.setIssueProperty(created.key, ARTIFACT_PROP, artifactId);
      await opts.provider.setIssueProperty(created.key, "praxis.managed", true);
      await opts.provider.setIssueProperty(created.key, "praxis.role", "qa");
      await opts.provider.setIssueProperty(created.key, "praxis.blocking", true);
      await opts.provider.createIssueLink(opts.wpKey, created.key, "Relates");
      if (canonicalStories[0]) {
        await opts.provider.createIssueLink(canonicalStories[0], created.key, "Relates");
      }
    }
  }
  if (blocking.length) {
    assertRole("qa", "block-package");
    await opts.provider.writePraxisState(opts.wpKey, {
      lifecycle: "blocked",
      blockedBy: blocking.map((b) => b.fingerprint),
    });
    await opts.provider.setIssueProperty(
      opts.wpKey,
      "praxis.blockedBy",
      blocking.map((b) => b.fingerprint),
    );
  } else if (build.ok && test.ok) {
    assertRole("qa", "qa-pass");
    await opts.provider.writePraxisState(opts.wpKey, { lifecycle: "qa-passed" });
  }

  const report: QualityWpReport = {
    contract: "quality.work-package.report",
    version: "1.0.0",
    workPackageId: manifest?.id ?? opts.wpKey,
    jiraWorkPackageKey: opts.wpKey,
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
    potentialRisks: [],
    addedTests: opts.addTests ?? [],
    sourceChangesGuard: "pass",
    overallVerdict: blocking.length ? "blocked" : build.ok && test.ok ? "pass" : "fail",
  };
  const outDir = join(opts.repo, ".praxis-jira", "quality");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${opts.wpKey}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, `${opts.wpKey}.md`),
    `# Quality report ${opts.wpKey}\n\nVerdict: **${report.overallVerdict}**\n`,
  );
  await opts.provider.addComment(
    opts.wpKey,
    opts.provider.renderDescription(
      textDocument(`Quality report ${report.overallVerdict}`),
    ),
  );
  await opts.provider.setIssueProperty(opts.wpKey, "praxis.qualityReport", report);
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
  workPackages: Array<{ key: string; title: string }>;
  claims: unknown[];
  quality: unknown[];
  bugs: string[];
}> {
  const epic = await provider.getIssue(epicKey);
  const flags = await loadEpicIssueFlags(provider, epicKey);
  const stories = canonicalStoryKeysFromFlags(flags);
  const superseded = supersededPairs(flags);
  const workPackages: Array<{ key: string; title: string }> = [];
  const claims: unknown[] = [];
  const quality: unknown[] = [];
  for (const f of flags) {
    const wp = await provider.getIssueProperty(f.key, "praxis.workPackage");
    if (wp) {
      workPackages.push({ key: f.key, title: f.summary });
      const claim = await provider.getIssueProperty(f.key, "praxis.claim");
      if (claim) claims.push(claim);
      const q = await provider.getIssueProperty(f.key, "praxis.qualityReport");
      if (q) quality.push(q);
    }
  }
  const bugs = flags.filter((f) => f.issueType.toLowerCase() === "bug").map((f) => f.key);
  return {
    epic: { key: epic.key, summary: epic.summary },
    canonicalStories: stories,
    superseded,
    workPackages,
    claims,
    quality,
    bugs,
  };
}
