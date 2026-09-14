import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JiraWriteJournalEntry, JiraWriteOpState } from "@praxis/contracts";

export function writeJournalPath(repo: string): string {
  return join(repo, ".praxis-jira", "write-journal.json");
}

export function loadWriteJournal(repo: string): JiraWriteJournalEntry[] {
  const p = writeJournalPath(repo);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as JiraWriteJournalEntry[];
}

export function saveWriteJournal(
  repo: string,
  journal: JiraWriteJournalEntry[],
): void {
  const p = writeJournalPath(repo);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(journal, null, 2)}\n`);
}

export function upsertWriteOp(
  repo: string,
  entry: JiraWriteJournalEntry,
): JiraWriteJournalEntry {
  const journal = loadWriteJournal(repo);
  const i = journal.findIndex((e) => e.operationId === entry.operationId);
  if (i >= 0) journal[i] = entry;
  else journal.push(entry);
  saveWriteJournal(repo, journal);
  return entry;
}

export function findWriteOp(
  repo: string,
  operationId: string,
): JiraWriteJournalEntry | undefined {
  return loadWriteJournal(repo).find((e) => e.operationId === operationId);
}

export function findWriteOpByArtifact(
  repo: string,
  artifactId: string,
): JiraWriteJournalEntry | undefined {
  const rows = loadWriteJournal(repo).filter((e) => e.artifactId === artifactId);
  return (
    rows.find((e) => e.state === "committed" && e.jiraIssueKey) ??
    rows.find((e) => e.jiraIssueKey) ??
    rows[0]
  );
}

export function advanceWriteOp(
  repo: string,
  operationId: string,
  patch: Partial<JiraWriteJournalEntry> & { state: JiraWriteOpState },
): JiraWriteJournalEntry {
  const cur = findWriteOp(repo, operationId);
  if (!cur) throw new Error(`write-journal missing ${operationId}`);
  const next: JiraWriteJournalEntry = {
    ...cur,
    ...patch,
    completedAt:
      patch.state === "committed"
        ? (patch.completedAt ?? new Date().toISOString())
        : cur.completedAt,
  };
  return upsertWriteOp(repo, next);
}
