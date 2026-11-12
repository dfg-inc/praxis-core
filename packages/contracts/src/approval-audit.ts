import { z } from "zod";
import { annotationOf, integrityReport, integritySummary } from "./acceptance-integrity.js";
import type { UserApproval } from "./user-approval.js";
import type { WorkflowState } from "./workflow.js";

/**
 * A durable record of every decision that needed a person: what, which revision and content, when, through which channel,
 * and how much that channel proves. The record is written by the contract at the moment the decision is verified, never from
 * anything in a command. It says what the CLIENT vouched for; no client identifies the person yet, so `actor` stays empty.
 *
 *   client-response    the client's own approval dialog answered (the Runtime asked, the client answered, and nothing was
 *                      configured to answer it). A client response, not independently authenticated: no channel on the
 *                      person's computer can prove a person, rather than automation or an agent, answered
 * Kept only so saved work items stay readable; nothing new is recorded with them:
 *   independent-human  what 0.1.0-alpha.49.1 and earlier recorded for a dialog answer: the same class as client-response
 *                      (the name overstated it)
 *   review-page        a click in a page the Runtime served on loopback (review page Save, the approval page): released
 *                      alpha.48 to alpha.49.1 accepted it as the person's decision; it is no longer a channel
 *   host-attested      the host's own permission prompt or Trusted Client mode: removed
 *   test-only          the test harness (PRAXIS_TEST_APPROVALS): never a person, never production
 * States written before this record existed carry decisions with no record: they are reported as "unverified provenance".
 */
export const APPROVAL_TRUST = ["client-response", "independent-human", "review-page", "host-attested", "test-only"] as const;
export const ApprovalSubjectSchema = z.object({
  type: z.enum(["story", "decision", "service", "requirement", "criterion", "review", "work-item"]),
  id: z.string(),
  revision: z.number().int().optional(),
  contentFingerprint: z.string().optional(),
});
export const ApprovalRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  subjects: z.array(ApprovalSubjectSchema).default([]),
  summary: z.string(),
  /** Digest of the exact content the person was shown and approved (dialog channels). */
  subjectDigest: z.string().optional(),
  channel: z.string(),
  assurance: z.string(),
  trust: z.enum(APPROVAL_TRUST),
  /** Reserved: clients do not identify the person today. */
  actor: z.string().optional(),
  /** Work item revision after this decision was applied: the link to its history entry. */
  workItemRevision: z.number().int(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;

export function trustOfApproval(approval: Pick<UserApproval, "channel" | "assurance">): ApprovalRecord["trust"] {
  if (approval.channel === "test") return "test-only";
  if (approval.assurance === "client-ui") return "client-response";
  // not produced by a shipped Runtime any more; classified for what they are if a test or an old caller makes one
  if (approval.assurance === "approval-page") return "review-page";
  return "host-attested";
}

/** What an approval is, in words that do not claim more than the channel proved. */
export function describeApproval(approval: Pick<UserApproval, "channel" | "assurance"> | "review-page"): string {
  if (approval === "review-page") return "saved from the review page (a click in a page served on this computer; not accepted as a decision since 0.1.0-alpha.49.2)";
  switch (trustOfApproval(approval)) {
    case "client-response":
      return "approved in the client's approval dialog (a client response; not independently authenticated)";
    case "review-page":
      return "a click in a page served on this computer (not a decision of the user since 0.1.0-alpha.49.2)";
    case "host-attested":
      return "a standing permission (removed in 0.1.0-alpha.49.2)";
    default:
      return "TEST harness approval (not a person)";
  }
}

/** How a saved record's trust reads today: the earlier name for a dialog answer is the same class as client-response. */
export const currentTrust = (trust: ApprovalRecord["trust"]): ApprovalRecord["trust"] => (trust === "independent-human" ? "client-response" : trust);

/**
 * Counts by trust, and the decisions that exist without any record. The approvals[] records live in the same repository file
 * as the decisions, so on their own they prove nothing (T-repo can write both): for a work item read from a file, a record
 * counts only when the decision ledger outside the repository carries the same approval, and a decision counts only when
 * its own ledger record backs it (acceptance-integrity.ts). An in-memory state keeps the earlier cross-check.
 */
export function approvalSummary(state: WorkflowState) {
  const records = state.approvals ?? [];
  const annotation = annotationOf(state);
  const backed = (r: ApprovalRecord) => !annotation || annotation.records[r.id] === "accepted";
  const counted = records.filter(backed);
  const has = (action: string, type: ApprovalSubject["type"], id: string) => counted.some((r) => r.action === action && r.subjects.some((s) => s.type === type && s.id === id));
  const unverified = annotation
    ? integrityReport(state)
        .filter((s) => s.status !== "accepted")
        .map((s) => `${s.label}: ${s.status}`)
    : [
        ...state.stories.filter((s) => s.confirmedBehavior && s.status !== "superseded" && !has("confirm-story", "story", s.id)).map((s) => `story ${s.id}`),
        ...state.decisions.filter((d) => d.confirmed && !has("confirm-decision", "decision", d.id)).map((d) => `decision ${d.id}`),
        ...state.services.filter((s) => (s.status === "approved" || s.status === "completed") && !has("approve-service", "service", s.id)).map((s) => `service ${s.id}`),
      ];
  const by = (trust: ApprovalRecord["trust"]) => counted.filter((r) => currentTrust(r.trust) === trust).length;
  return {
    total: records.length,
    clientResponse: by("client-response"),
    // no record is independently authenticated; kept at 0 so readers of the earlier field are not misled by its old meaning
    independentHuman: 0,
    reviewPage: by("review-page"),
    hostAttested: by("host-attested"),
    testOnly: by("test-only"),
    legacyIndependentHumanLabel: records.filter((r) => r.trust === "independent-human").length,
    /** Records in the file that no decision-ledger record on this computer carries: they are not counted above. */
    recordsWithoutLedger: records.length - counted.length,
    unverifiedProvenance: unverified,
    ...integritySummary(state),
  };
}
