import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLocalWorkPackage } from "@praxis/jira/workflow";

/**
 * The four identities Praxis tools take, kept apart. A value is never converted from one kind to another:
 *
 *   work-item-id     a local Praxis Work Item (WI-...). Lives in .praxis/workflow. Never a Jira key.
 *   work-package-id  a local Work Package (WP-20260914-002) under work-packages/.
 *   jira-issue-key   an external Jira issue key (PRX-12). A work package or an epic may carry one.
 *   unknown          none of the above.
 */
export type IdentifierKind = "work-item-id" | "work-package-id" | "jira-issue-key" | "unknown";

export type ResolvedIdentifier = {
  kind: IdentifierKind;
  input: string;
  /** Set only when a local work package was actually found. */
  workPackageId?: string;
  /** Set only when the identifier IS a Jira key, or a found local work package records one. Never invented. */
  jiraIssueKey: string | null;
};

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

function workItemIds(repo: string): string[] {
  const dir = join(repo, ".praxis", "workflow");
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(join(dir, "items"))) if (name.endsWith(".json")) ids.add(name.slice(0, -5));
  } catch {
    /* no items directory */
  }
  try {
    const legacy = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { workItem?: { id?: string } };
    if (typeof legacy.workItem?.id === "string") ids.add(legacy.workItem.id);
  } catch {
    /* no legacy state */
  }
  return [...ids];
}

export function isWorkItemId(repo: string, value: string): boolean {
  return existsSync(join(repo, ".praxis", "workflow")) && workItemIds(repo).includes(value);
}

/** Classifies a work-package argument. Local work packages win, then Work Items, then Jira key shape. */
export function resolveWorkPackageRef(repo: string, value: string): ResolvedIdentifier {
  const local = resolveLocalWorkPackage(repo, value);
  if (local) {
    const key = readManifestKey(local.manifestDir);
    return {
      kind: local.id === value ? "work-package-id" : "jira-issue-key",
      input: value,
      workPackageId: local.id,
      jiraIssueKey: local.id === value ? key : value,
    };
  }
  if (isWorkItemId(repo, value)) return { kind: "work-item-id", input: value, jiraIssueKey: null };
  if (JIRA_KEY_RE.test(value)) return { kind: "jira-issue-key", input: value, jiraIssueKey: value };
  return { kind: "unknown", input: value, jiraIssueKey: null };
}

function readManifestKey(manifestDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(manifestDir, "manifest.json"), "utf8")) as { jiraIssueKey?: unknown };
    return typeof manifest.jiraIssueKey === "string" && manifest.jiraIssueKey.length > 0 ? manifest.jiraIssueKey : null;
  } catch {
    return null;
  }
}
