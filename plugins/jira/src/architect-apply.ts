import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PraxisWorkPackage } from "@praxis/contracts";
import { textDocument } from "./rich-text.js";
import type { JiraProvider } from "./provider.js";
import { assertRole } from "./role-policy.js";
import { ARTIFACT_PROP, assertCanonicalMembers, isSupersededFlags, loadEpicIssueFlags } from "./managed-scope.js";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  discoverLocalWorkPackages,
  writeWpManifest,
  type LocalWorkPackage,
} from "./work-package-local.js";

export type ArchitectPlanItem = {
  action: "CREATE" | "UPDATE" | "UNCHANGED" | "LINK" | "IGNORED";
  kind: "work-package" | "architecture-comment" | "story" | "superseded";
  artifactId: string;
  jiraIssueKey?: string;
  localWorkPackageId?: string;
  summary: string;
};

const WP_PROP = "praxis.workPackage";
const ARCH_COMMENT_PROP = "praxis.architectCommentId";

function clip(text: string, max = 4000): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n…`;
}

function designSummary(local: LocalWorkPackage, storyKeys: string[]): string {
  const body = local.indexMd ?? `Work package ${local.id}`;
  return [
    `# ${local.id}`,
    "",
    "## Scope",
    `Canonical stories: ${storyKeys.join(", ") || "none"}`,
    "",
    "## Technical summary",
    clip(body, 2500),
    "",
    "## Architecture refs",
    local.designDir ?? local.canonWpDir ?? "",
    "",
    "## Definition of Done",
    "- Implementation matches change-spec",
    "- Tests pass",
    "- Ready for QA",
  ].join("\n");
}

async function findExistingWp(
  provider: JiraProvider,
  epicKey: string,
  localId: string,
): Promise<string | undefined> {
  const artifactId = `wp:${localId}`;
  const children = await provider.getChildren(epicKey);
  for (const c of children) {
    const aid = await provider.getIssueProperty<string>(c.key, ARTIFACT_PROP);
    if (aid === artifactId) return c.key;
    const wp = await provider.getIssueProperty<{ id?: string } | boolean>(
      c.key,
      WP_PROP,
    );
    if (wp && typeof wp === "object" && wp.id === localId) return c.key;
  }
  return undefined;
}

async function ensureManagedComment(
  provider: JiraProvider,
  storyKey: string,
  body: string,
  dryRun: boolean,
): Promise<{ action: "CREATE" | "UPDATE" | "UNCHANGED"; commentId?: string }> {
  const existingId = await provider.getIssueProperty<string>(
    storyKey,
    ARCH_COMMENT_PROP,
  );
  if (dryRun) {
    return { action: existingId ? "UPDATE" : "CREATE", commentId: existingId };
  }
  const rendered = provider.renderDescription(textDocument(body));
  if (existingId) {
    const comments = await provider.getComments(storyKey);
    const hit = comments.find((c) => c.id === existingId);
    if (hit) {
      await provider.updateComment(storyKey, existingId, rendered);
      await provider.setIssueProperty(storyKey, ARCH_COMMENT_PROP, existingId);
      return { action: "UPDATE", commentId: existingId };
    }
  }
  const created = await provider.addComment(storyKey, rendered);
  await provider.setIssueProperty(storyKey, ARCH_COMMENT_PROP, created.id);
  return { action: "CREATE", commentId: created.id };
}

export async function architectMaterialize(opts: {
  provider: JiraProvider;
  epicKey: string;
  repo: string;
  dryRun?: boolean;
}): Promise<{
  ok: boolean;
  reason?: string;
  plan: ArchitectPlanItem[];
  planText: string;
  workPackages: PraxisWorkPackage[];
  taskKeys: string[];
  readyForDevelopment: boolean;
}> {
  assertRole("architect", "read-epic");
  const remoteHandoff = await opts.provider.getIssueProperty<{
    readyForArchitecture?: boolean;
    canonicalStoryKeys?: string[];
    storyKeys?: string[];
  }>(opts.epicKey, "praxis.baHandoff");
  if (!remoteHandoff?.readyForArchitecture) {
    throw new Error(
      `BA_REMOTE_APPLY_INCOMPLETE: remote BA apply is not complete for ${opts.epicKey} (Architect skipped)`,
    );
  }
  const flags = await loadEpicIssueFlags(opts.provider, opts.epicKey);
  const fromHandoff =
    remoteHandoff.canonicalStoryKeys?.length
      ? remoteHandoff.canonicalStoryKeys
      : remoteHandoff.storyKeys ?? [];
  const storyKeys = fromHandoff.filter((key) => {
    const f = flags.find((x) => x.key === key);
    return !f || !isSupersededFlags(f);
  });
  const plan: ArchitectPlanItem[] = [];
  for (const f of flags.filter((x) => isSupersededFlags(x))) {
    plan.push({
      action: "IGNORED",
      kind: "superseded",
      artifactId: f.artifactId ?? f.key,
      jiraIssueKey: f.key,
      summary: `superseded ${f.key} -> ${f.supersededBy ?? "?"}`,
    });
  }

  const locals = discoverLocalWorkPackages(opts.repo);
  if (locals.length === 0) {
    return {
      ok: false,
      reason: "ARCHITECT_DESIGN_MISSING",
      plan,
      planText:
        "Architect Jira write plan\n\nCREATE:\n  none\n\nreason: ARCHITECT_DESIGN_MISSING\nNo generic technical task will be invented.\n",
      workPackages: [],
      taskKeys: [],
      readyForDevelopment: false,
    };
  }

  const hoursCap = opts.provider.config.workPackageMaxHours;
  const packages: PraxisWorkPackage[] = [];
  const meta = await opts.provider.discoverMetadata();
  const wpTypeId = meta.workPackageTypeId || meta.taskTypeId;
  const labels = meta.workPackageTypeId
    ? ["praxis-managed"]
    : ["praxis-managed", "praxis-work-package"];

  for (const local of locals) {
    const artifactId = `wp:${local.id}`;
    const existing = await findExistingWp(
      opts.provider,
      opts.epicKey,
      local.id,
    );
    const title = `[${local.id}] ${clip(local.indexMd?.split("\n")[0]?.replace(/^#\s*/, "") || "Work package", 80)}`;
    const members = await assertCanonicalMembers(opts.provider, storyKeys);
    if (!existing) {
      plan.push({
        action: "CREATE",
        kind: "work-package",
        artifactId,
        localWorkPackageId: local.id,
        summary: title,
      });
    } else {
      plan.push({
        action: "UNCHANGED",
        kind: "work-package",
        artifactId,
        jiraIssueKey: existing,
        localWorkPackageId: local.id,
        summary: title,
      });
    }
    const usefulMermaid = local.mermaid.filter(
      (m) =>
        !/^flowchart\s+LR\s*A\s*-->\s*B\s*$/i.test(
          m.replace(/\s+/g, " ").trim(),
        ),
    );
    for (const storyKey of members) {
      const story = await opts.provider.getIssue(storyKey);
      const approach = clip(
        local.indexMd ??
          `Implement ${story.summary} per ${local.id} design package.`,
        2000,
      );
      const commentBody = [
        `Praxis architecture (${local.id})`,
        "",
        "## Technical approach",
        approach,
        usefulMermaid[0]
          ? `\n## Diagram\n\n\`\`\`mermaid\n${usefulMermaid[0]}\n\`\`\``
          : "",
      ].join("\n");
      const comment = await ensureManagedComment(
        opts.provider,
        storyKey,
        commentBody,
        Boolean(opts.dryRun),
      );
      plan.push({
        action: comment.action,
        kind: "architecture-comment",
        artifactId: `arch-comment:${storyKey}`,
        jiraIssueKey: storyKey,
        localWorkPackageId: local.id,
        summary: "managed architecture section",
      });
      if (!opts.dryRun) {
        assertRole("architect", "create-architecture");
        await opts.provider.writeArchitectureMetadata(storyKey, {
          localWorkPackageId: local.id,
          technicalApproach: approach,
          nfr: [],
          testConsiderations: ["unit tests for new behavior"],
          adrIds: [],
          platformContractIds: [],
          diagrams: usefulMermaid.map((text) => ({
            language: "mermaid",
            text,
          })),
        });
      }
    }

    let wpKey = existing;
    if (!existing && !opts.dryRun) {
      assertRole("architect", "create-work-package");
      const created = await opts.provider.createIssue({
        summary: title,
        issueType: opts.provider.config.taskType,
        issueTypeId: wpTypeId || undefined,
        parentKey: opts.epicKey,
        labels,
        description: opts.provider.renderDescription(
          textDocument(designSummary(local, members)),
        ),
      });
      wpKey = created.key;
      await opts.provider.setIssueProperty(created.key, ARTIFACT_PROP, artifactId);
      await opts.provider.setIssueProperty(created.key, WP_PROP, {
        id: local.id,
      });
      for (const storyKey of members) {
        await opts.provider.createIssueLink(created.key, storyKey, "Relates");
        plan.push({
          action: "LINK",
          kind: "work-package",
          artifactId,
          jiraIssueKey: created.key,
          localWorkPackageId: local.id,
          summary: `${created.key} <-> ${storyKey}`,
        });
      }
    } else if (!existing && opts.dryRun) {
      plan.push({
        action: "LINK",
        kind: "work-package",
        artifactId,
        localWorkPackageId: local.id,
        summary: `(planned WP) <-> ${members.join(", ")}`,
      });
    }

    if (!wpKey && opts.dryRun) {
      packages.push({
        id: local.id,
        jiraIssueKey: "PLANNED",
        epicKey: opts.epicKey,
        title,
        storyKeys: members,
        taskKeys: [],
        dependencyWorkPackages: [],
        estimatedHours: Math.min(8, hoursCap),
        architectureDecisionIds: [],
        platformContractIds: [],
        status: "ready",
        claim: null,
      });
      continue;
    }
    if (!wpKey) continue;

    const wp: PraxisWorkPackage = {
      id: local.id,
      jiraIssueKey: wpKey,
      epicKey: opts.epicKey,
      title,
      storyKeys: members,
      taskKeys: [],
      dependencyWorkPackages: [],
      estimatedHours: Math.min(8, hoursCap),
      architectureDecisionIds: [],
      platformContractIds: [],
      status: "ready",
      claim: null,
    };
    if (!opts.dryRun) {
      writeWpManifest(opts.repo, wp);
      await opts.provider.setIssueProperty(wpKey, "praxis.workPackageManifest", wp);
      await opts.provider.writePraxisState(wpKey, {
        lifecycle: "ready-for-development",
      });
      const handoffPath =
        local.handoffPath ??
        join(local.designDir ?? local.manifestDir, "architect-developer.handoff.json");
      const prev = existsSync(handoffPath)
        ? JSON.parse(readFileSync(handoffPath, "utf8"))
        : {};
      writeJsonAtomic(handoffPath, {
        ...prev,
        contract: prev.contract ?? "architect.developer.handoff",
        version: prev.version ?? "1.0.0",
        workPackageId: local.id,
        jiraWorkPackageKey: wpKey,
        epicKey: opts.epicKey,
        canonicalStoryKeys: members,
        technicalTaskKeys: [],
        changeSpecPath: local.changeSpecPath,
        designPackagePath: local.designDir ?? local.canonWpDir,
        readyForDevelopment: true,
      });
      await opts.provider.writePraxisState(opts.epicKey, {
        lifecycle: "development",
      });
    }
    packages.push(wp);
  }

  const lines = ["Architect Jira write plan", ""];
  for (const action of ["UNCHANGED", "UPDATE", "CREATE", "LINK", "IGNORED"] as const) {
    const rows = plan.filter((p) => p.action === action);
    lines.push(`${action}:`);
    if (!rows.length) lines.push("  none");
    else for (const r of rows) lines.push(`  ${r.jiraIssueKey ?? "(new)"}  ${r.summary}`);
    lines.push("");
  }
  lines.push("CREATE TECHNICAL TASKS:");
  lines.push("  none");
  const ready = !opts.dryRun && packages.every((p) => p.jiraIssueKey && p.jiraIssueKey !== "PLANNED");
  return {
    ok: true,
    plan,
    planText: lines.join("\n"),
    workPackages: packages.filter((p) => p.jiraIssueKey !== "PLANNED" || Boolean(opts.dryRun)),
    taskKeys: [],
    readyForDevelopment: ready,
  };
}
