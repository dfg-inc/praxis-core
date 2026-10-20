import { approvedContentDigest, decisionContentFingerprint, encodeAuthorization, generateApprovalKeyPair, humanGrantContent, serviceGrantSubject, signAuthorization, storyContentFingerprint, type AuthorizationBody, type HumanGrantAction, HUMAN_GRANT_KIND, type WorkflowState } from "./index.js";

/** Test-only: an ephemeral key pair standing in for the broker, installed as the verifying key. */
export function useEphemeralBroker() {
  const keys = generateApprovalKeyPair();
  const previous = { pub: process.env.PRAXIS_APPROVAL_PUBLIC_KEY, priv: process.env.PRAXIS_APPROVAL_PRIVATE_KEY };
  process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
  delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
  return {
    keys,
    restore() {
      if (previous.pub === undefined) delete process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
      else process.env.PRAXIS_APPROVAL_PUBLIC_KEY = previous.pub;
      if (previous.priv !== undefined) process.env.PRAXIS_APPROVAL_PRIVATE_KEY = previous.priv;
    },
  };
}

/** A grant token shaped like a real broker's: one action, one target, exact content, the right kind. */
export function grantToken(
  privateKeyPem: string,
  input: { action: HumanGrantAction; targetId: string; content: string; ttlMs?: number; kind?: string; consumptionId?: string },
): string {
  const body: AuthorizationBody = {
    contract: "praxis.approval.authorization",
    version: 1,
    planFingerprint: `sha256:${"ee".repeat(32)}`,
    provider: "local",
    instanceId: "local",
    operations: ["repository_edit"],
    workItemIds: ["WI-1"],
    repositories: [],
    action: input.action,
    approver: "owner@example.com",
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + (input.ttlMs ?? 60_000)).toISOString(),
    consumptionId: input.consumptionId ?? `g-${Math.random().toString(36).slice(2, 10)}`,
    planId: `plan-${input.targetId}`,
    targets: [input.targetId],
    content: input.content,
    contentDigest: approvedContentDigest(input.content),
    decisionKind: input.kind ?? HUMAN_GRANT_KIND[input.action],
  };
  return encodeAuthorization(signAuthorization(body, privateKeyPem));
}

export function storyGrant(state: WorkflowState, storyId: string, privateKeyPem: string) {
  const story = state.stories.find((item) => item.id === storyId)!;
  const contentFingerprint = storyContentFingerprint(story);
  return {
    revision: story.revision,
    contentFingerprint,
    authorization: grantToken(privateKeyPem, {
      action: "confirm-story",
      targetId: story.id,
      content: humanGrantContent("confirm-story", { storyId: story.id, revision: story.revision, contentFingerprint }),
    }),
  };
}

export function decisionGrant(state: WorkflowState, decisionId: string, privateKeyPem: string) {
  const decision = state.decisions.find((item) => item.id === decisionId)!;
  const contentFingerprint = decisionContentFingerprint(decision);
  return {
    revision: decision.revision,
    contentFingerprint,
    authorization: grantToken(privateKeyPem, {
      action: "confirm-decision",
      targetId: decision.id,
      content: humanGrantContent("confirm-decision", { decisionId: decision.id, revision: decision.revision, contentFingerprint }),
    }),
  };
}

export function serviceGrant(state: WorkflowState, service: WorkflowState["services"][number], privateKeyPem: string) {
  return grantToken(privateKeyPem, {
    action: "approve-service",
    targetId: service.id,
    content: humanGrantContent("approve-service", serviceGrantSubject(state, service)),
  });
}
