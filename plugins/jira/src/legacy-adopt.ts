import type { JiraIssueLite, JiraProvider } from "./provider.js";
import {
  isSupersededFlags,
  loadIssueScopeFlags,
  parseHistoricalSupersededBy,
  type IssueScopeFlags,
} from "./managed-scope.js";

const BA_SECTION =
  /User Story|Acceptance Criteria|Requirement IDs|Business context/i;
const HANDOFF_STORIES = /Praxis BA handoff ready\.\s*Stories:\s*([A-Z][A-Z0-9]+-\d+(?:\s*,\s*[A-Z][A-Z0-9]+-\d+)*)/i;
const REQ_ID = /\b((?:REQ|FR|E\d+-FR)\b[-A-Z0-9]*)/gi;

export function descriptionText(description: unknown): string {
  if (typeof description === "string") return description;
  return JSON.stringify(description ?? "");
}

export function looksLikePraxisBaStory(issue: JiraIssueLite): boolean {
  if (issue.properties?.["praxis.managed"] === true) return true;
  if (issue.properties?.["praxis.role"] === "ba") return true;
  if (typeof issue.properties?.["praxis.artifactId"] === "string") return true;
  const text = `${issue.summary}\n${descriptionText(issue.description)}`;
  return BA_SECTION.test(text);
}

export function extractRequirementIds(issue: JiraIssueLite): string[] {
  const fromProp = issue.properties?.["praxis.requirementIds"];
  if (Array.isArray(fromProp)) return fromProp.map(String);
  const text = descriptionText(issue.description);
  const ids = [...text.matchAll(REQ_ID)].map((m) => m[1]);
  return [...new Set(ids)];
}

export function extractLogicalId(
  epicKey: string,
  issue: JiraIssueLite,
): string {
  const aid = issue.properties?.["praxis.artifactId"];
  if (typeof aid === "string" && aid.startsWith(`ba:${epicKey}:`)) {
    return aid.slice(`ba:${epicKey}:`.length);
  }
  const req = extractRequirementIds(issue)[0];
  if (req) return req;
  return "story-core";
}

export async function parseEpicHandoffStoryKeys(
  provider: JiraProvider,
  epicKey: string,
): Promise<string[]> {
  const comments = await provider.getComments(epicKey);
  const keys: string[] = [];
  for (const c of comments) {
    const text = descriptionText(c.body);
    const m = text.match(HANDOFF_STORIES);
    if (!m?.[1]) continue;
    for (const k of m[1].split(",")) keys.push(k.trim());
  }
  return [...new Set(keys)];
}

export type LegacyAdoption =
  | {
      status: "adopted";
      canonicalKey: string;
      supersededKeys: string[];
      logicalId: string;
      confidence: "metadata" | "handoff+structure" | "structure";
    }
  | { status: "none" }
  | { status: "conflict"; candidates: string[]; reason: "MIGRATION_CONFLICT" };

export async function adoptLegacyStories(opts: {
  provider: JiraProvider;
  epicKey: string;
  flags: IssueScopeFlags[];
  children: JiraIssueLite[];
}): Promise<LegacyAdoption> {
  const handoffKeys = await parseEpicHandoffStoryKeys(
    opts.provider,
    opts.epicKey,
  );
  const byKey = new Map(opts.children.map((c) => [c.key, c]));
  const flagged = new Map(opts.flags.map((f) => [f.key, f]));

  const superseded = opts.flags.filter((f) => isSupersededFlags(f));
  const active = opts.flags.filter(
    (f) =>
      !isSupersededFlags(f) &&
      f.issueType.toLowerCase() !== "epic" &&
      f.key !== opts.epicKey,
  );

  const praxisShaped = active.filter((f) => {
    const issue = byKey.get(f.key);
    return issue ? looksLikePraxisBaStory(issue) : false;
  });

  if (handoffKeys.length === 1) {
    const canonical = handoffKeys[0]!;
    const issue = byKey.get(canonical);
    const flagsFor = flagged.get(canonical);
    if (
      issue &&
      looksLikePraxisBaStory(issue) &&
      (!flagsFor || !isSupersededFlags(flagsFor))
    ) {
      return {
        status: "adopted",
        canonicalKey: canonical,
        supersededKeys: superseded.map((s) => s.key),
        logicalId: extractLogicalId(opts.epicKey, issue),
        confidence: "handoff+structure",
      };
    }
  }

  if (praxisShaped.length > 1) {
    const ids = new Set(
      praxisShaped.map((p) => p.artifactId).filter((x): x is string => Boolean(x)),
    );
    if (!(ids.size === 1 && praxisShaped.every((p) => p.artifactId))) {
      return {
        status: "conflict",
        candidates: praxisShaped.map((p) => p.key),
        reason: "MIGRATION_CONFLICT",
      };
    }
  }

  if (praxisShaped.length === 1) {
    const canonical = praxisShaped[0]!;
    const issue = byKey.get(canonical.key)!;
    const meta =
      typeof issue.properties?.["praxis.artifactId"] === "string"
        ? "metadata"
        : "structure";
    return {
      status: "adopted",
      canonicalKey: canonical.key,
      supersededKeys: [
        ...new Set([
          ...superseded.map((s) => s.key),
          ...active
            .filter((a) => a.key !== canonical.key)
            .filter((a) => parseHistoricalSupersededBy(a.summary) === canonical.key)
            .map((a) => a.key),
        ]),
      ],
      logicalId: extractLogicalId(opts.epicKey, issue),
      confidence: meta,
    };
  }

  return { status: "none" };
}

export async function hydrateFlags(
  provider: JiraProvider,
  children: JiraIssueLite[],
): Promise<IssueScopeFlags[]> {
  const out: IssueScopeFlags[] = [];
  for (const c of children) {
    if (c.properties && Object.keys(c.properties).length) {
      const historical = parseHistoricalSupersededBy(c.summary);
      const supersededBy =
        (typeof c.properties["praxis.supersededBy"] === "string"
          ? c.properties["praxis.supersededBy"]
          : undefined) || historical;
      out.push({
        key: c.key,
        artifactId:
          typeof c.properties["praxis.artifactId"] === "string"
            ? c.properties["praxis.artifactId"]
            : undefined,
        superseded:
          c.properties["praxis.superseded"] === true || Boolean(supersededBy),
        supersededBy,
        issueType: c.issueType,
        parentKey: c.parentKey,
        labels: c.labels,
        summary: c.summary,
      });
      continue;
    }
    out.push(await loadIssueScopeFlags(provider, c));
  }
  return out;
}
