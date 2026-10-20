import { createHash, createPublicKey, verify } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { assertSecureDeploymentAssessment, assessApprovalDeployment, testIdentityOverrideActive } from "./deployment.js";
import { canonicalValue, WorkflowError } from "./workflow.js";

// Deliberately independent of broker.ts and approval.ts: those evaluate workflow schemas when loaded, and the
// workflow loads this module, so depending on them would make the import cycle fatal. The token format is the
// broker's (praxis.approval.authorization v1); this checks the same signature over the same canonical bytes.
const approvedContentDigest = (content: string): string => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

type GrantBody = {
  contract?: string;
  version?: number;
  action?: string;
  decisionKind?: string;
  targets?: string[];
  workItemIds?: string[];
  contentDigest?: string;
  planFingerprint?: string;
  issuedAt?: string;
  expiresAt?: string;
};

function verifyToken(token: string, publicKeyPem: string, now: Date): GrantBody {
  let parsed: { body?: GrantBody; signature?: string };
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization artifact is malformed");
  }
  if (!parsed?.body || typeof parsed.signature !== "string") {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization artifact is malformed");
  }
  const body = parsed.body;
  if (body.contract !== "praxis.approval.authorization" || body.version !== 1) {
    throw new WorkflowError("APPROVAL_REQUIRED", "authorization contract is not accepted");
  }
  let ok = false;
  try {
    ok = verify(null, Buffer.from(JSON.stringify(canonicalValue(body))), createPublicKey(publicKeyPem), Buffer.from(parsed.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new WorkflowError("APPROVAL_REQUIRED", "authorization signature is not valid");
  const expires = Date.parse(body.expiresAt ?? "");
  const issued = Date.parse(body.issuedAt ?? "");
  if (!Number.isFinite(expires) || !Number.isFinite(issued) || now.getTime() > expires || issued > expires) {
    throw new WorkflowError("APPROVAL_EXPIRED", "authorization has expired");
  }
  return body;
}

/**
 * Human grants: acts only a person may perform. Confirming a Story, confirming an architecture decision and
 * approving a service for completion each need a broker-signed token that names the act, the thing acted on
 * and its exact content. An agent can write any record it likes; it cannot make one of these true.
 *
 * The token is the broker's signature over a plan whose single action is the grant's action, whose target is
 * the subject, and whose `content` is the canonical subject description. The Runtime recomputes that content
 * from its own state, so a token for a different story, revision, decision or service (or for the same one
 * after it changed) does not verify.
 */
export type HumanGrantAction = "confirm-story" | "confirm-decision" | "approve-service";

/** Each grant is a different kind of decision, so approving one never authorizes another. */
export const HUMAN_GRANT_KIND = {
  "confirm-story": "story_behavior",
  "confirm-decision": "architecture_decision",
  "approve-service": "quality_verdict",
} as const satisfies Record<HumanGrantAction, string>;

function canonicalText(value: unknown): string {
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

/** The exact content a grant must bind. Clients (the Runtime, the broker plan builder) use the same function. */
export function humanGrantContent(action: HumanGrantAction, subject: Record<string, unknown>): string {
  return canonicalText({ kind: action, ...subject });
}

function publicKey(): string {
  const inline = process.env.PRAXIS_APPROVAL_PUBLIC_KEY?.trim();
  if (inline) return inline;
  const path = process.env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH?.trim();
  if (path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      throw new WorkflowError("APPROVAL_ISOLATION_UNAVAILABLE", "the approval public key file cannot be read");
    }
  }
  throw new WorkflowError("APPROVAL_ISOLATION_UNAVAILABLE", "a human grant requires the approval public key (PRAXIS_APPROVAL_PUBLIC_KEY or _PATH)");
}

function assertSigningKeyHiddenFromThisProcess(): void {
  const refuse = () => {
    throw new WorkflowError("APPROVAL_ISOLATION_UNAVAILABLE", "approval signing key is visible to this process; secure mode refuses");
  };
  if (process.env.PRAXIS_APPROVAL_PRIVATE_KEY?.trim()) refuse();
  const keyPath = process.env.PRAXIS_APPROVAL_PRIVATE_KEY_PATH?.trim();
  if (keyPath) {
    try {
      accessSync(keyPath, constants.R_OK);
    } catch {
      return;
    }
    refuse();
  }
}

export function verifyHumanGrant(input: {
  token: string;
  action: HumanGrantAction;
  /** Story id, decision id or service id. */
  targetId: string;
  /** What this Runtime computes the grant must bind. */
  content: string;
  /**
   * Older tokens (before grants bound content) carried this digest as the plan fingerprint. Still accepted
   * for confirm-story, still signature-checked and still expiring; a real broker never produces them.
   */
  legacyPlanFingerprint?: string;
  now?: Date;
}): void {
  assertSigningKeyHiddenFromThisProcess();
  const compatibility = process.env.PRAXIS_SECURITY_MODE?.trim() === "compatibility";
  if (!compatibility && !testIdentityOverrideActive()) {
    // A signature proves nothing when the signer's trust chain is in the agent's reach.
    assertSecureDeploymentAssessment(assessApprovalDeployment());
  }
  const body = verifyToken(input.token, publicKey(), input.now ?? new Date());
  const kind = HUMAN_GRANT_KIND[input.action];
  if (body.action !== input.action) {
    throw new WorkflowError("APPROVAL_SCOPE_MISMATCH", `this approval is for ${body.action}, not ${input.action}`);
  }
  if (body.decisionKind !== undefined && body.decisionKind !== kind) {
    throw new WorkflowError("APPROVAL_SCOPE_SEPARATE", `this approval is for ${body.decisionKind}, not ${kind}; one kind of approval never authorizes another`);
  }
  const bindsContent =
    Array.isArray(body.targets) && body.targets.includes(input.targetId) && body.contentDigest === approvedContentDigest(input.content);
  if (bindsContent && body.decisionKind === kind) return;
  const legacy =
    input.legacyPlanFingerprint !== undefined &&
    body.planFingerprint === input.legacyPlanFingerprint &&
    Array.isArray(body.workItemIds) &&
    body.workItemIds.includes(input.targetId);
  if (legacy) return;
  throw new WorkflowError(
    "APPROVAL_SCOPE_MISMATCH",
    `this approval is not for ${input.targetId} as it is now: the ${input.action} content differs from what was approved, or the approval does not name it`,
  );
}
