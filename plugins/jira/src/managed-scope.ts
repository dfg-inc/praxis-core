import type { JiraIssueLite, JiraProvider } from "./provider.js";
import { findWriteOpByArtifact } from "./write-journal.js";

export const ARTIFACT_PROP = "praxis.artifactId";
export const SUPERSEDED_PROP = "praxis.superseded";
export const SUPERSEDED_BY_PROP = "praxis.supersededBy";
export const DUPLICATE_LABEL = "praxis-duplicate";

const HISTORICAL_DUP =
  /\[DUPLICATE[^\]]*superseded by\s+([A-Z][A-Z0-9]+-\d+)/i;

import type { JiraIssueSemanticType } from "./issue-types.js";

export type IssueScopeFlags = {
  key: string;
  artifactId?: string;
  superseded: boolean;
  supersededBy?: string;
  issueType: string;
  semanticType: JiraIssueSemanticType;
  parentKey?: string;
  labels: string[];
  summary: string;
};

export function parseHistoricalSupersededBy(summary: string): string | undefined {
  const m = summary.match(HISTORICAL_DUP);
  return m?.[1];
}

export function isSupersededFlags(flags: IssueScopeFlags): boolean {
  return (
    flags.superseded ||
    Boolean(flags.supersededBy) ||
    flags.labels.includes(DUPLICATE_LABEL)
  );
}

export async function loadIssueScopeFlags(
  provider: JiraProvider,
  issue: JiraIssueLite,
): Promise<IssueScopeFlags> {
  const artifactId = await provider.getIssueProperty<string>(
    issue.key,
    ARTIFACT_PROP,
  );
  const supersededRaw = await provider.getIssueProperty<boolean>(
    issue.key,
    SUPERSEDED_PROP,
  );
  const supersededByProp = await provider.getIssueProperty<string>(
    issue.key,
    SUPERSEDED_BY_PROP,
  );
  const historical = parseHistoricalSupersededBy(issue.summary);
  const supersededBy = supersededByProp || historical;
  return {
    key: issue.key,
    artifactId: typeof artifactId === "string" ? artifactId : undefined,
    superseded: supersededRaw === true || Boolean(supersededBy),
    supersededBy,
    issueType: issue.issueType,
    semanticType: issue.semanticType,
    parentKey: issue.parentKey,
    labels: issue.labels,
    summary: issue.summary,
  };
}

export async function loadEpicIssueFlags(
  provider: JiraProvider,
  epicKey: string,
): Promise<IssueScopeFlags[]> {
  const children = await provider.getChildren(epicKey);
  const out: IssueScopeFlags[] = [];
  for (const c of children) {
    out.push(await loadIssueScopeFlags(provider, c));
  }
  return out;
}

export function artifactIdAliases(artifactId: string): string[] {
  const ba = artifactId.match(/^ba:([^:]+):(.+)$/);
  if (ba) return [artifactId, `story:${ba[1]}:${ba[2]}`];
  const story = artifactId.match(/^story:([^:]+):(.+)$/);
  if (story) return [artifactId, `ba:${story[1]}:${story[2]}`];
  return [artifactId];
}

export function issueNumber(key: string): number {
  const m = key.match(/-(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function selectCanonicalKey(
  candidates: IssueScopeFlags[],
  journalCanonical?: string,
): string | undefined {
  const active = candidates.filter((c) => !isSupersededFlags(c));
  if (journalCanonical && active.some((c) => c.key === journalCanonical)) {
    return journalCanonical;
  }
  const sorted = [...active].sort((a, b) => issueNumber(a.key) - issueNumber(b.key));
  return sorted[0]?.key;
}

export async function markSuperseded(
  provider: JiraProvider,
  duplicateKey: string,
  canonicalKey: string,
): Promise<void> {
  await provider.setIssueProperty(duplicateKey, SUPERSEDED_PROP, true);
  await provider.setIssueProperty(duplicateKey, SUPERSEDED_BY_PROP, canonicalKey);
  const issue = await provider.getIssue(duplicateKey);
  const labels = Array.from(new Set([...issue.labels, DUPLICATE_LABEL]));
  await provider.updateIssue(duplicateKey, { labels });
  await provider.addComment(
    duplicateKey,
    provider.renderDescription({
      version: 1,
      blocks: [
        {
          type: "paragraph",
          inlines: [
            {
              type: "text",
              text: `Superseded by ${canonicalKey} due to Praxis duplicate-write recovery.`,
            },
          ],
        },
      ],
    }),
  );
}

export async function recoverDuplicatesForArtifact(
  provider: JiraProvider,
  flags: IssueScopeFlags[],
  artifactId: string,
  repo: string,
): Promise<{ canonical?: string; superseded: string[] }> {
  const matches = flags.filter((f) => f.artifactId === artifactId);
  if (matches.length === 0) return { superseded: [] };
  const journal = findWriteOpByArtifact(repo, artifactId);
  const canonical = selectCanonicalKey(matches, journal?.jiraIssueKey);
  const superseded: string[] = [];
  if (!canonical) return { superseded };
  for (const m of matches) {
    if (m.key === canonical) continue;
    if (!isSupersededFlags(m)) {
      await markSuperseded(provider, m.key, canonical);
    }
    superseded.push(m.key);
  }
  return { canonical, superseded };
}

export async function lookupByArtifactId(
  provider: JiraProvider,
  flags: IssueScopeFlags[],
  artifactId: string,
  repo: string,
  epicKey: string,
): Promise<{ canonical?: string; superseded: string[] }> {
  const recovered = await recoverDuplicatesForArtifact(
    provider,
    flags,
    artifactId,
    repo,
  );
  if (recovered.canonical) return recovered;
  const aliases = artifactIdAliases(artifactId);
  if (aliases.length > 1) {
    for (const alt of aliases.slice(1)) {
      const viaLegacy = await recoverDuplicatesForArtifact(
        provider,
        flags,
        alt,
        repo,
      );
      if (viaLegacy.canonical) return viaLegacy;
    }
  }
  const journal = findWriteOpByArtifact(repo, artifactId);
  if (journal?.jiraIssueKey) {
    try {
      const issue = await provider.getIssue(journal.jiraIssueKey);
      const f = await loadIssueScopeFlags(provider, issue);
      if (!isSupersededFlags(f) && (f.parentKey === epicKey || !f.parentKey)) {
        return { canonical: journal.jiraIssueKey, superseded: [] };
      }
    } catch {
      /* remote gone */
    }
  }
  return { superseded: [] };
}

export function unmatchedCanonicalStories(
  flags: IssueScopeFlags[],
  claimedKeys: Set<string>,
): IssueScopeFlags[] {
  return flags.filter(
    (f) =>
      !isSupersededFlags(f) &&
      !claimedKeys.has(f.key) &&
      f.semanticType === "story",
  );
}

export function canonicalStoryKeysFromFlags(flags: IssueScopeFlags[]): string[] {
  return flags
    .filter(
      (f) =>
        !isSupersededFlags(f) && f.semanticType === "story",
    )
    .map((f) => f.key);
}

export function supersededPairs(flags: IssueScopeFlags[]): Array<{
  from: string;
  to: string;
}> {
  return flags
    .filter((f) => isSupersededFlags(f))
    .map((f) => ({ from: f.key, to: f.supersededBy ?? "?" }));
}

export async function assertCanonicalMembers(
  provider: JiraProvider,
  keys: string[],
): Promise<string[]> {
  const active: string[] = [];
  for (const key of keys) {
    const issue = await provider.getIssue(key);
    const flags = await loadIssueScopeFlags(provider, issue);
    if (isSupersededFlags(flags)) continue;
    active.push(key);
  }
  return active;
}
