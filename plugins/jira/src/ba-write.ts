import { createHash } from "node:crypto";
import type {
  BaJiraWritePlanItem,
  JiraWriteJournalEntry,
} from "@praxis/contracts";
import type { JiraProvider } from "./provider.js";
import { resolveBaArtifactId } from "./artifact-id.js";
import {
  ARTIFACT_PROP,
  loadEpicIssueFlags,
  lookupByArtifactId,
  unmatchedCanonicalStories,
  type IssueScopeFlags,
} from "./managed-scope.js";
import {
  advanceWriteOp,
  findWriteOp,
  upsertWriteOp,
} from "./write-journal.js";
import { headingParagraphs } from "./rich-text.js";

export type BaStorySpec = {
  logicalId?: string;
  artifactId?: string;
  summary: string;
  userStory: string;
  acceptanceCriteria: string;
  businessContext?: string;
  requirementIds: string[];
  outOfScope?: string;
  dependencies?: string[];
};

export type BaWriteHooks = {
  crashAfterCreate?: boolean;
  crashAfterProperty?: boolean;
  crashBeforeCommit?: boolean;
};

export type AppliedStory = {
  action: BaJiraWritePlanItem["action"];
  artifactId: string;
  jiraIssueKey?: string;
  superseded?: string[];
};

function contentFingerprint(spec: BaStorySpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        summary: spec.summary,
        userStory: spec.userStory,
        acceptanceCriteria: spec.acceptanceCriteria,
        businessContext: spec.businessContext ?? "",
        requirementIds: spec.requirementIds,
        outOfScope: spec.outOfScope ?? "",
        dependencies: spec.dependencies ?? [],
      }),
    )
    .digest("hex");
}

function storyDescription(provider: JiraProvider, spec: BaStorySpec, epicKey: string) {
  return provider.renderDescription(
    headingParagraphs([
      { heading: "User Story", body: spec.userStory },
      { heading: "Business context", body: spec.businessContext ?? "" },
      { heading: "Acceptance Criteria", body: spec.acceptanceCriteria },
      { heading: "Out of scope", body: spec.outOfScope ?? "None" },
      {
        heading: "Dependencies",
        body: (spec.dependencies ?? []).join(", ") || "None",
      },
      { heading: "Requirement IDs", body: spec.requirementIds.join(", ") },
      { heading: "Parent Epic", body: epicKey },
      { heading: "Source", body: "Praxis BA" },
    ]),
  );
}

async function applyPraxisMetadata(
  provider: JiraProvider,
  key: string,
  spec: BaStorySpec,
  artifactId: string,
  epicKey: string,
  fingerprint: string,
): Promise<void> {
  await provider.setIssueProperty(key, ARTIFACT_PROP, artifactId);
  await provider.setIssueProperty(key, "praxis.managed", true);
  await provider.setIssueProperty(key, "praxis.role", "ba");
  await provider.setIssueProperty(key, "praxis.requirementIds", spec.requirementIds);
  await provider.setIssueProperty(key, "praxis.sourceEpic", epicKey);
  await provider.setIssueProperty(key, "praxis.contentFingerprint", fingerprint);
  await provider.writePraxisState(key, { lifecycle: "ready-for-architecture" });
  const stored = await provider.getIssueProperty<string>(key, ARTIFACT_PROP);
  if (stored !== artifactId) {
    throw new Error(`property verify failed for ${ARTIFACT_PROP} on ${key}`);
  }
}

async function verifyCreated(
  provider: JiraProvider,
  key: string,
  artifactId: string,
  epicKey: string,
): Promise<void> {
  const issue = await provider.getIssue(key);
  const aid = await provider.getIssueProperty<string>(key, ARTIFACT_PROP);
  if (issue.key !== key) throw new Error(`verify key mismatch ${issue.key}`);
  if (issue.parentKey && issue.parentKey !== epicKey) {
    throw new Error(`verify parent mismatch ${issue.parentKey}`);
  }
  if (aid !== artifactId) throw new Error(`verify artifactId mismatch on ${key}`);
  if (!issue.key.startsWith(`${provider.config.projectKey}-`)) {
    throw new Error(`verify project mismatch ${issue.key}`);
  }
}

export function formatBaWritePlan(items: BaJiraWritePlanItem[]): string {
  const lines = ["BA Jira write plan", ""];
  for (const action of ["UNCHANGED", "UPDATE", "CREATE", "SUPERSEDED"] as const) {
    const rows = items.filter((i) => i.action === action);
    lines.push(`${action}:`);
    if (!rows.length) {
      lines.push("  none");
    } else {
      for (const r of rows) {
        const extra = r.supersededBy ? ` -> ${r.supersededBy}` : "";
        lines.push(
          `  ${r.jiraIssueKey ?? "(new)"}  artifactId: ${r.artifactId}${extra}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function planAndApplyBaStories(opts: {
  provider: JiraProvider;
  epicKey: string;
  repo: string;
  specs: BaStorySpec[];
  dryRun?: boolean;
  hooks?: BaWriteHooks;
}): Promise<{
  plan: BaJiraWritePlanItem[];
  planText: string;
  applied: AppliedStory[];
  flags: IssueScopeFlags[];
}> {
  const flags = await loadEpicIssueFlags(opts.provider, opts.epicKey);
  const claimed = new Set<string>();
  const plan: BaJiraWritePlanItem[] = [];
  const applied: AppliedStory[] = [];

  for (const spec of opts.specs) {
    const artifactId = resolveBaArtifactId({
      epicKey: opts.epicKey,
      logicalId: spec.logicalId,
      artifactId: spec.artifactId,
      requirementIds: spec.requirementIds,
    });
    const operationId = `ba-story:${artifactId}`;
    const fingerprint = contentFingerprint(spec);

    const looked = await lookupByArtifactId(
      opts.provider,
      flags,
      artifactId,
      opts.repo,
      opts.epicKey,
    );
    for (const s of looked.superseded) {
      plan.push({
        action: "SUPERSEDED",
        artifactId,
        jiraIssueKey: s,
        supersededBy: looked.canonical,
      });
      claimed.add(s);
    }

    let canonical = looked.canonical;
    if (!canonical) {
      const incomplete = findWriteOp(opts.repo, operationId);
      if (incomplete?.jiraIssueKey) canonical = incomplete.jiraIssueKey;
    }
    if (!canonical) {
      const unmatched = unmatchedCanonicalStories(flags, claimed);
      if (unmatched.length === 1 && opts.specs.length === 1) {
        canonical = unmatched[0]!.key;
      }
    }

    if (canonical) {
      claimed.add(canonical);
      const existingFp = await opts.provider.getIssueProperty<string>(
        canonical,
        "praxis.contentFingerprint",
      );
      const action: BaJiraWritePlanItem["action"] =
        existingFp === fingerprint ? "UNCHANGED" : "UPDATE";
      plan.push({ action, artifactId, jiraIssueKey: canonical, summary: spec.summary });
      if (opts.dryRun) {
        applied.push({ action, artifactId, jiraIssueKey: canonical, superseded: looked.superseded });
        continue;
      }
      const now = new Date().toISOString();
      upsertWriteOp(opts.repo, {
        operationId,
        role: "ba",
        operationType: "upsert-story",
        artifactId,
        epicKey: opts.epicKey,
        jiraIssueKey: canonical,
        state: "created",
        provider: opts.provider.flavor,
        projectKey: opts.provider.config.projectKey,
        startedAt: now,
      });
      if (action === "UPDATE") {
        await opts.provider.updateIssue(canonical, {
          summary: spec.summary,
          description: storyDescription(opts.provider, spec, opts.epicKey),
        });
      }
      await applyPraxisMetadata(
        opts.provider,
        canonical,
        spec,
        artifactId,
        opts.epicKey,
        fingerprint,
      );
      if (opts.hooks?.crashAfterProperty) {
        throw new Error("injected crash: after property");
      }
      await verifyCreated(opts.provider, canonical, artifactId, opts.epicKey);
      advanceWriteOp(opts.repo, operationId, { state: "verified" });
      if (opts.hooks?.crashBeforeCommit) {
        throw new Error("injected crash: before commit");
      }
      advanceWriteOp(opts.repo, operationId, { state: "committed" });
      applied.push({ action, artifactId, jiraIssueKey: canonical, superseded: looked.superseded });
      continue;
    }

    plan.push({
      action: "CREATE",
      artifactId,
      summary: spec.summary,
    });
    if (opts.dryRun) {
      applied.push({ action: "CREATE", artifactId, superseded: looked.superseded });
      continue;
    }

    const startedAt = new Date().toISOString();
    upsertWriteOp(opts.repo, {
      operationId,
      role: "ba",
      operationType: "upsert-story",
      artifactId,
      epicKey: opts.epicKey,
      state: "planned",
      provider: opts.provider.flavor,
      projectKey: opts.provider.config.projectKey,
      startedAt,
    });

    const recheck = await lookupByArtifactId(
      opts.provider,
      await loadEpicIssueFlags(opts.provider, opts.epicKey),
      artifactId,
      opts.repo,
      opts.epicKey,
    );
    if (recheck.canonical) {
      advanceWriteOp(opts.repo, operationId, {
        state: "committed",
        jiraIssueKey: recheck.canonical,
      });
      applied.push({
        action: "UNCHANGED",
        artifactId,
        jiraIssueKey: recheck.canonical,
        superseded: recheck.superseded,
      });
      continue;
    }

    advanceWriteOp(opts.repo, operationId, { state: "creating" });
    const createdIssue = await opts.provider.createIssue({
      summary: spec.summary,
      issueType: opts.provider.config.storyType,
      issueTypeId: (await opts.provider.discoverMetadata()).storyTypeId,
      description: storyDescription(opts.provider, spec, opts.epicKey),
      parentKey: opts.epicKey,
      labels: ["praxis-managed"],
    });
    advanceWriteOp(opts.repo, operationId, {
      state: "created",
      jiraIssueKey: createdIssue.key,
    });
    if (opts.hooks?.crashAfterCreate) {
      throw new Error("injected crash: after create");
    }
    await applyPraxisMetadata(
      opts.provider,
      createdIssue.key,
      spec,
      artifactId,
      opts.epicKey,
      fingerprint,
    );
    if (opts.hooks?.crashAfterProperty) {
      throw new Error("injected crash: after property");
    }
    await verifyCreated(
      opts.provider,
      createdIssue.key,
      artifactId,
      opts.epicKey,
    );
    advanceWriteOp(opts.repo, operationId, { state: "verified" });
    if (opts.hooks?.crashBeforeCommit) {
      throw new Error("injected crash: before commit");
    }
    advanceWriteOp(opts.repo, operationId, { state: "committed" });
    claimed.add(createdIssue.key);
    applied.push({
      action: "CREATE",
      artifactId,
      jiraIssueKey: createdIssue.key,
      superseded: looked.superseded,
    });
  }

  return {
    plan,
    planText: formatBaWritePlan(plan),
    applied,
    flags: await loadEpicIssueFlags(opts.provider, opts.epicKey),
  };
}
