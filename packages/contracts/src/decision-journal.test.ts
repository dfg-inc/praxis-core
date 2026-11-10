import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDecisionAmendments, auditDecisionJournal, effectiveDecisions, readDecisionJournal } from "./decision-journal.js";
import { decisionLogPath } from "./user-approval.js";

/** Journal lines as Praxis wrote them before journal v2: the two misattributions the Desktop tester ran into, and real ones. */
const OLD = {
  agentNo: { at: "2026-10-28T10:00:00.000Z", action: "praxis_developer_git_commit", summary: "praxis_developer_git_commit declined", subjectDigest: "sha256:a", decision: "rejected", channel: "none", reason: "the user declined (reported by the agent)" },
  desktopDecline: { at: "2026-10-22T18:32:06.525Z", action: "praxis_project_init_apply", summary: "Write .project", subjectDigest: "sha256:b", decision: "rejected", channel: "client-elicitation" },
  personReject: { at: "2026-10-22T18:50:00.000Z", action: "praxis_project_init_apply", summary: "Write .project", subjectDigest: "sha256:c", decision: "rejected", channel: "client-elicitation" },
  unknownReject: { at: "2026-10-23T09:00:00.000Z", action: "confirm-story", summary: "Confirm US-1", subjectDigest: "sha256:d", decision: "rejected", channel: "client-elicitation" },
  approved: { at: "2026-10-22T18:54:52.637Z", action: "praxis_project_init_apply", summary: "Write .project", subjectDigest: "sha256:e", decision: "approved", channel: "client-elicitation" },
  noDialog: { at: "2026-10-22T09:22:34.787Z", action: "praxis_project_init_apply", summary: "Write .project", subjectDigest: "sha256:f", decision: "refused", channel: "none", reason: "no approval dialog in this client" },
};
/** The Runtime's diagnostics for the same calls: the Desktop decline came back 9 ms after the dialog was asked for, the person's after 95 s. */
const TRIPS = [
  { askedAt: "2026-10-22T18:32:06.516Z", answeredAt: "2026-10-22T18:32:06.525Z", tool: "praxis_project_init_apply", client: "claude-code" },
  { askedAt: "2026-10-22T18:48:25.000Z", answeredAt: "2026-10-22T18:50:00.000Z", tool: "praxis_project_init_apply", client: "claude-code" },
];

let repo: string;
let home: string | undefined;
beforeEach(() => {
  home = process.env.PRAXIS_STATE_HOME;
  process.env.PRAXIS_STATE_HOME = mkdtempSync(join(tmpdir(), "praxis-journal-home-"));
  repo = mkdtempSync(join(tmpdir(), "praxis-journal-repo-"));
  const path = decisionLogPath(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Object.values(OLD).map((entry) => JSON.stringify({ ...entry, repository: repo })).join("\n") + "\n");
});
afterEach(() => {
  rmSync(process.env.PRAXIS_STATE_HOME!, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  if (home === undefined) delete process.env.PRAXIS_STATE_HOME;
  else process.env.PRAXIS_STATE_HOME = home;
});

describe("auditing old journal entries", () => {
  it("finds the agent's confirmation=NO and the client's own decline, and leaves the person's answers alone", () => {
    const findings = auditDecisionJournal(readDecisionJournal(repo), { roundTrips: TRIPS, minAnswerMs: 1000 });
    const byLine = Object.fromEntries(findings.map((f) => [f.line, f]));
    expect(byLine[1]).toMatchObject({ kind: "amend", rule: "agent-reported-decline", corrected: { decision: "withdrawn", decidedBy: "agent" } });
    expect(byLine[2]).toMatchObject({ kind: "amend", rule: "client-answered-without-dialog", corrected: { decision: "auto-answered", decidedBy: "client" }, evidence: { latencyMs: 9 } });
    // answered after 95 s: nothing shows it was not the person; not amended
    expect(byLine[3]).toMatchObject({ kind: "unverified" });
    expect(byLine[3].corrected).toBeUndefined();
    // no timing at all: reported, never guessed
    expect(byLine[4]).toMatchObject({ kind: "unverified" });
    // approvals and "no dialog" entries claim no rejection by the user
    expect(byLine[5]).toBeUndefined();
    expect(byLine[6]).toBeUndefined();
  });
});

describe("amending without rewriting", () => {
  it("appends one amendment per wrong claim; every original line stays byte for byte", () => {
    const path = decisionLogPath(repo);
    const before = readFileSync(path, "utf8");
    const findings = auditDecisionJournal(readDecisionJournal(repo), { roundTrips: TRIPS, minAnswerMs: 1000 });
    const result = appendDecisionAmendments(repo, findings, "praxis test", new Date("2026-11-10T12:00:00.000Z"));
    expect(result).toMatchObject({ appended: 2, skipped: 0 });
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length).trim().split("\n").map((l) => JSON.parse(l));
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ type: "amendment", amends: { line: 1 }, previous: { decision: "rejected", channel: "none" }, corrected: { decision: "withdrawn", decidedBy: "agent" }, rule: "agent-reported-decline", by: "praxis test", at: "2026-11-10T12:00:00.000Z" });
    expect(added[1].amends.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const effective = effectiveDecisions(readDecisionJournal(repo));
    expect(effective.map((e) => [e.line, e.decision, e.decidedBy])).toEqual([
      [1, "withdrawn", "agent"],
      [2, "auto-answered", "client"],
      [3, "rejected", "unknown"],
      [4, "rejected", "unknown"],
      [5, "approved", "unknown"],
      [6, "refused", "unknown"],
    ]);
    // the original claim is still there for anyone who reads the file
    expect(effective[0].entry.decision).toBe("rejected");
  });

  it("is idempotent, and does not amend a line that changed after it was audited", () => {
    const findings = auditDecisionJournal(readDecisionJournal(repo), { roundTrips: TRIPS, minAnswerMs: 1000 });
    expect(appendDecisionAmendments(repo, findings, "praxis test").appended).toBe(2);
    expect(appendDecisionAmendments(repo, findings, "praxis test")).toMatchObject({ appended: 0, skipped: 2 });
    expect(auditDecisionJournal(readDecisionJournal(repo), { roundTrips: TRIPS, minAnswerMs: 1000 }).filter((f) => f.kind === "amend")).toHaveLength(0);

    // someone edits line 1 by hand after a fresh audit: the old finding no longer matches it and is skipped
    const other = mkdtempSync(join(tmpdir(), "praxis-journal-repo-"));
    try {
      const path = decisionLogPath(other);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...OLD.agentNo, repository: other })}\n`);
      const stale = auditDecisionJournal(readDecisionJournal(other), { minAnswerMs: 1000 });
      writeFileSync(path, `${JSON.stringify({ ...OLD.agentNo, reason: "edited", repository: other })}\n`);
      expect(appendDecisionAmendments(other, stale, "praxis test")).toMatchObject({ appended: 0, skipped: 1 });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("keeps lines it cannot read and never turns anything into an approval", () => {
    appendFileSync(decisionLogPath(repo), "not json\n");
    const lines = readDecisionJournal(repo);
    expect(lines.at(-1)).toMatchObject({ line: 7, unreadable: true });
    const findings = auditDecisionJournal(lines, { roundTrips: TRIPS, minAnswerMs: 1000 });
    expect(findings.every((f) => f.corrected?.decision !== "approved")).toBe(true);
  });
});
