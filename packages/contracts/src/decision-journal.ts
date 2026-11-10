import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decisionLogPath, type DecidedBy, type DecisionLogEntry, type DecisionOutcome } from "./user-approval.js";

/**
 * Reading the decision journal back, and correcting it without rewriting it.
 *
 * The journal is append-only. An entry that claimed more than Praxis knew (an "approval rejected by the user" that was
 * really the agent's confirmation=NO, or a client that answered `decline` by itself in a few milliseconds) is never edited
 * or deleted: an amendment is appended that names the entry (line number and the SHA-256 of its exact text), says what it
 * claimed, what the evidence shows instead, by which rule and on what evidence. Readers apply amendments on top; the
 * original line stays exactly as it was written.
 *
 * Only two rules exist, and both only take a claim about the user away; nothing here can turn anything into an approval:
 *   agent-reported-decline         decision "rejected", channel "none", reason "reported by the agent" (confirmation=NO
 *                                  before journal v2): the agent withdrew the request; no decision of the user is known
 *   client-answered-without-dialog decision "rejected"/"dismissed" from the client dialog, answered faster than a person
 *                                  can read it (the timing comes from the Runtime's diagnostics log): the client's answer
 */

export type AmendmentRule = "agent-reported-decline" | "client-answered-without-dialog";

export type DecisionAmendment = {
  v: 2;
  type: "amendment";
  at: string;
  amends: { line: number; sha256: string };
  previous: { decision: string; channel: string; decidedBy?: string };
  corrected: { decision: DecisionOutcome; decidedBy: DecidedBy };
  rule: AmendmentRule;
  evidence: Record<string, string | number | boolean>;
  by: string;
  repository?: string;
};

export type JournalLine = {
  /** 1-based line number in the journal file. */
  line: number;
  sha256: string;
  entry?: DecisionLogEntry;
  amendment?: DecisionAmendment;
  /** The line is not JSON or not a journal record; it is kept and reported, never dropped. */
  unreadable?: true;
};

const lineHash = (raw: string): string => `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;

export function readDecisionJournal(repo: string): JournalLine[] {
  const path = decisionLogPath(repo);
  if (!existsSync(path)) return [];
  const raws = readFileSync(path, "utf8").split("\n");
  const lines: JournalLine[] = [];
  raws.forEach((raw, index) => {
    if (!raw.trim()) return;
    const base = { line: index + 1, sha256: lineHash(raw) };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type === "amendment") lines.push({ ...base, amendment: parsed as unknown as DecisionAmendment });
      else if (typeof parsed.decision === "string" && typeof parsed.action === "string") lines.push({ ...base, entry: parsed as unknown as DecisionLogEntry });
      else lines.push({ ...base, unreadable: true });
    } catch {
      lines.push({ ...base, unreadable: true });
    }
  });
  return lines;
}

/**
 * The only corrections an amendment may make. A line that claims anything else (for example that a rejection was really an
 * approval) is not applied: the journal is append-only text anyone with the user's account can write, so a reader accepts
 * an amendment only when its rule allows exactly that correction of exactly that kind of entry.
 */
const ALLOWED: Record<AmendmentRule, { from: readonly string[]; to: { decision: DecisionOutcome; decidedBy: DecidedBy } }> = {
  "agent-reported-decline": { from: ["rejected"], to: { decision: "withdrawn", decidedBy: "agent" } },
  "client-answered-without-dialog": { from: ["rejected", "dismissed"], to: { decision: "auto-answered", decidedBy: "client" } },
};

function validAmendment(amendment: DecisionAmendment, entry: DecisionLogEntry): boolean {
  const rule = ALLOWED[amendment.rule];
  return Boolean(rule) && rule.from.includes(entry.decision) && amendment.corrected?.decision === rule.to.decision && amendment.corrected?.decidedBy === rule.to.decidedBy;
}

/** Each decision with the amendment that applies to it (the last valid one), so a reader sees what is known now. */
export function effectiveDecisions(lines: JournalLine[]): Array<{ line: number; entry: DecisionLogEntry; decision: DecisionOutcome; decidedBy: DecidedBy | "unknown"; amendedBy?: DecisionAmendment }> {
  const entries = new Map(lines.filter((l) => l.entry).map((l) => [`${l.line}:${l.sha256}`, l.entry!]));
  const amendments = new Map<string, DecisionAmendment>();
  for (const line of lines) {
    if (!line.amendment) continue;
    const key = `${line.amendment.amends.line}:${line.amendment.amends.sha256}`;
    const entry = entries.get(key);
    if (entry && validAmendment(line.amendment, entry)) amendments.set(key, line.amendment);
  }
  return lines
    .filter((line): line is JournalLine & { entry: DecisionLogEntry } => Boolean(line.entry))
    .map((line) => {
      const amendment = amendments.get(`${line.line}:${line.sha256}`);
      return {
        line: line.line,
        entry: line.entry,
        decision: amendment?.corrected.decision ?? line.entry.decision,
        decidedBy: amendment?.corrected.decidedBy ?? line.entry.decidedBy ?? "unknown",
        ...(amendment ? { amendedBy: amendment } : {}),
      };
    });
}

/**
 * A round trip the Runtime observed: when the dialog was asked for, when the client's answer came back (the retry of the
 * call), and the code that retry finished with.
 */
export type ObservedRoundTrip = { askedAt: string; answeredAt: string; tool: string; client?: string; finishedCode?: string };

/** Tools through which a workflow act (confirm-story, review-decisions ...) is applied; other actions are tool names. */
const ACT_TOOLS = new Set(["praxis_workflow_apply", "praxis_review_apply", "praxis_quality_apply"]);
const tripMatches = (trip: ObservedRoundTrip, action: string): boolean => (action.startsWith("praxis_") ? trip.tool === action : ACT_TOOLS.has(trip.tool));

export type JournalFinding = {
  line: number;
  sha256: string;
  at: string;
  action: string;
  claimed: { decision: string; channel: string; decidedBy?: string };
  /** amend: the evidence shows the claim is wrong; unverified: a user decision is claimed and nothing shows it either way. */
  kind: "amend" | "unverified";
  rule?: AmendmentRule;
  corrected?: { decision: DecisionOutcome; decidedBy: DecidedBy };
  evidence?: Record<string, string | number | boolean>;
  note: string;
};

/**
 * Finds journal entries that attribute a decision to the user without evidence. `roundTrips` are the Runtime's observed
 * dialog round trips (from its diagnostics log); an entry is matched to the round trip whose answer arrived within two
 * seconds before it was written.
 */
export function auditDecisionJournal(lines: JournalLine[], options: { roundTrips?: ObservedRoundTrip[]; minAnswerMs: number }): JournalFinding[] {
  const amended = new Set(lines.filter((l) => l.amendment).map((l) => `${l.amendment!.amends.line}:${l.amendment!.amends.sha256}`));
  const findings: JournalFinding[] = [];
  for (const line of lines) {
    const entry = line.entry;
    if (!entry || amended.has(`${line.line}:${line.sha256}`)) continue;
    const claimed = { decision: entry.decision, channel: entry.channel, ...(entry.decidedBy ? { decidedBy: entry.decidedBy } : {}) };
    const common = { line: line.line, sha256: line.sha256, at: entry.at, action: entry.action, claimed };
    if (entry.decision === "rejected" && entry.channel === "none" && /reported by the agent/i.test(entry.reason ?? "")) {
      findings.push({
        ...common,
        kind: "amend",
        rule: "agent-reported-decline",
        corrected: { decision: "withdrawn", decidedBy: "agent" },
        evidence: { reason: entry.reason ?? "", channel: "none" },
        note: "confirmation=NO from the agent was recorded as the user's rejection; it is the agent withdrawing the request",
      });
      continue;
    }
    const userClaim = (entry.decision === "rejected" || entry.decision === "dismissed") && entry.channel === "client-elicitation";
    if (!userClaim) continue;
    const latency = entry.evidence?.latencyMs;
    if (typeof latency === "number") {
      // journal v2 entries carry their own timing; the Runtime already classified them when they were written
      continue;
    }
    const written = Date.parse(entry.at);
    // exactly one round trip of the same tool, answered just before this entry and finished as a rejection: anything less
    // certain leaves the entry as written
    const candidates = (options.roundTrips ?? []).filter(
      (t) => tripMatches(t, entry.action) && Date.parse(t.answeredAt) <= written && written - Date.parse(t.answeredAt) <= 2_000 && (t.finishedCode === undefined || t.finishedCode === "APPROVAL_REJECTED"),
    );
    const trip = candidates.length === 1 ? candidates[0] : undefined;
    if (trip) {
      const ms = Date.parse(trip.answeredAt) - Date.parse(trip.askedAt);
      if (ms < options.minAnswerMs) {
        findings.push({
          ...common,
          kind: "amend",
          rule: "client-answered-without-dialog",
          corrected: { decision: "auto-answered", decidedBy: "client" },
          evidence: { latencyMs: ms, askedAt: trip.askedAt, answeredAt: trip.answeredAt, tool: trip.tool, ...(trip.client ? { client: trip.client } : {}), minAnswerMs: options.minAnswerMs },
          note: `the client answered ${ms} ms after the dialog was requested, faster than a person can read it: no dialog reached the user`,
        });
        continue;
      }
    }
    findings.push({ ...common, kind: "unverified", note: "a decision of the user is claimed, and no timing was recorded for it; it is left as written" });
  }
  return findings;
}

/**
 * Appends one amendment per "amend" finding. Idempotent: an entry that already has an amendment is skipped. The journal
 * lines it amends are not touched.
 */
export function appendDecisionAmendments(repo: string, findings: JournalFinding[], by: string, now: Date = new Date()): { appended: number; skipped: number; path: string } {
  const path = decisionLogPath(repo);
  const lines = readDecisionJournal(repo);
  const already = new Set(lines.filter((l) => l.amendment).map((l) => `${l.amendment!.amends.line}:${l.amendment!.amends.sha256}`));
  const current = new Map(lines.map((l) => [l.line, l.sha256]));
  let appended = 0;
  let skipped = 0;
  for (const finding of findings) {
    if (finding.kind !== "amend" || !finding.rule || !finding.corrected) continue;
    const key = `${finding.line}:${finding.sha256}`;
    // the entry must still be exactly what was audited: a journal edited since then is not amended blindly
    if (already.has(key) || current.get(finding.line) !== finding.sha256) {
      skipped += 1;
      continue;
    }
    const amendment: DecisionAmendment = {
      v: 2,
      type: "amendment",
      at: now.toISOString(),
      amends: { line: finding.line, sha256: finding.sha256 },
      previous: finding.claimed,
      corrected: finding.corrected,
      rule: finding.rule,
      evidence: finding.evidence ?? {},
      by,
      repository: resolve(repo),
    };
    appendFileSync(path, `${JSON.stringify(amendment)}\n`, { mode: 0o600 });
    already.add(key);
    appended += 1;
  }
  return { appended, skipped, path };
}
