import type { DecisionKind } from "./authority.js";
import type { HumanActRequest } from "./workflow.js";
import type { ApprovalRequest } from "./user-approval.js";

/**
 * Acts only a person may perform: confirming a Story, confirming an architecture decision, approving a service for
 * completion. An agent can write any record it likes; it cannot make one of these true. Each needs the user's
 * approval (see user-approval.ts) that names the act, the thing acted on and its exact content, and each is its own
 * kind of decision, so approving one never authorizes another.
 */
export type HumanAct = "confirm-story" | "confirm-decision" | "approve-service";

export const HUMAN_ACT_KIND = {
  "confirm-story": "story_behavior",
  "confirm-decision": "architecture_decision",
  "approve-service": "quality_verdict",
} as const satisfies Record<HumanAct, DecisionKind>;

export function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalText((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The exact content an approval of this act binds. The Runtime computes it from its own state. */
export function humanActContent(act: HumanAct, subject: Record<string, unknown>): string {
  return canonicalText({ kind: act, ...subject });
}

/** What the user is asked, and what their approval binds, for one human act. Shared by the Runtime and by tests. */
export function humanActApprovalRequest(request: HumanActRequest): ApprovalRequest {
  return {
    action: request.action,
    kind: HUMAN_ACT_KIND[request.action],
    summary: request.summary,
    description: request.description,
    subject: request.content,
    risks: request.risks,
  };
}
