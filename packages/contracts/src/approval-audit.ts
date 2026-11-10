import { z } from "zod";
import type { UserApproval } from "./user-approval.js";

/**
 * A durable record of every decision that needed a person: what, which revision and content, when, through which channel,
 * and how much that channel proves. The record is written by the contract at the moment the decision is verified, never from
 * anything in a command. It says what the CLIENT vouched for; no client identifies the person yet, so `actor` stays empty.
 *
 *   independent-human  the client's own approval dialog answered (the Runtime asked, the client answered). The name is
 *                      historical and kept for saved work items: it says which channel answered, not that a person was
 *                      verified; no channel verifies one
 *   review-page        a click in a page the Runtime served on loopback and opened itself: Save in a review page, or
 *                      Approve in the approval page (a browser, no client vouching; who or what clicked is not known)
 *   host-attested      the host's own permission prompt or Trusted Client mode (the host, not a dialog, vouched)
 *   test-only          the test harness (PRAXIS_TEST_APPROVALS): never a person, never production
 * States written before this record existed carry decisions with no record: they are reported as "unverified provenance".
 */
export const APPROVAL_TRUST = ["independent-human", "review-page", "host-attested", "test-only"] as const;
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
  if (approval.assurance === "client-ui") return "independent-human";
  // the same trust as a review-page Save: a click in a page the Runtime opened, whose link the agent's tools never had
  if (approval.assurance === "approval-page") return "review-page";
  return "host-attested";
}

/** What an approval is, in words that do not claim more than the channel proved. */
export function describeApproval(approval: Pick<UserApproval, "channel" | "assurance"> | "review-page"): string {
  if (approval === "review-page") return "saved from the review page (a click in the browser page Praxis opened; the client did not vouch for it, and who clicked is not verified)";
  switch (trustOfApproval(approval)) {
    case "independent-human":
      return "approved in the client's approval dialog (the dialog answered; a person is not verified)";
    case "review-page":
      return "approved in the Praxis approval page (a click in the browser page Praxis opened; the client did not vouch for it, and who clicked is not verified)";
    case "host-attested":
      return approval.channel === "trusted-client" ? "approved in Trusted Client mode (the host's own permission, no dialog was shown)" : "approved through the host's permission prompt (no Praxis dialog)";
    default:
      return "TEST harness approval (not a person)";
  }
}

/** Counts by trust, and the decisions that exist without any record. */
export function approvalSummary(state: { approvals?: ApprovalRecord[]; stories: Array<{ id: string; revision: number; confirmedBehavior: boolean; status: string }>; decisions: Array<{ id: string; confirmed?: boolean }>; services: Array<{ id: string; status: string }> }) {
  const records = state.approvals ?? [];
  const has = (action: string, type: ApprovalSubject["type"], id: string) => records.some((r) => r.action === action && r.subjects.some((s) => s.type === type && s.id === id));
  const unverified = [
    ...state.stories.filter((s) => s.confirmedBehavior && s.status !== "superseded" && !has("confirm-story", "story", s.id)).map((s) => `story ${s.id}`),
    ...state.decisions.filter((d) => d.confirmed && !has("confirm-decision", "decision", d.id)).map((d) => `decision ${d.id}`),
    ...state.services.filter((s) => (s.status === "approved" || s.status === "completed") && !has("approve-service", "service", s.id)).map((s) => `service ${s.id}`),
  ];
  const by = (trust: ApprovalRecord["trust"]) => records.filter((r) => r.trust === trust).length;
  return { total: records.length, independentHuman: by("independent-human"), reviewPage: by("review-page"), hostAttested: by("host-attested"), testOnly: by("test-only"), unverifiedProvenance: unverified };
}
