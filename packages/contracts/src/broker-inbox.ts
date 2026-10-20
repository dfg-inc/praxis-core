import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ActionPlanSchema, type ActionPlan } from "./action-plan.js";

/**
 * The broker's shared inbox, as the Runtime sees it.
 *
 *   pending/<planId>.json         plans the agent (or the Runtime on its behalf) proposed. Anyone may write here;
 *                                 a plan in pending/ is a request, never an approval.
 *   approved/<planId>.json        the plan as the owner approved it (the broker moves it from pending/)
 *   rejected/<planId>.json        plans the owner rejected
 *   authorizations/<planId>.token the broker-signed token. Only the broker identity may write here; the Runtime
 *                                 reads it, verifies it against the trust anchor, and never returns it to the agent.
 *
 * Nothing in this module trusts a file's content: callers verify the signature before they act on a token.
 */

export const INBOX_PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export type InboxStatus = "approved" | "awaiting-operator" | "rejected" | "broker-not-configured";

export const brokerSharedDir = (): string | undefined => {
  const dir = process.env.PRAXIS_BROKER_SHARED_DIR?.trim();
  return dir ? resolve(dir) : undefined;
};

export const operatorPageUrl = (planId: string): string =>
  `${process.env.PRAXIS_OPERATOR_URL?.trim() || "http://localhost:8780"}/plan/${encodeURIComponent(planId)}`;

function inboxPath(kind: "pending" | "approved" | "rejected" | "authorizations", planId: string, ext = "json"): string | undefined {
  const dir = brokerSharedDir();
  if (!dir || !INBOX_PLAN_ID.test(planId)) return undefined;
  return join(dir, kind, `${planId}.${ext}`);
}

export function readInboxToken(planId: string): string | undefined {
  const path = inboxPath("authorizations", planId, "token");
  if (!path || !existsSync(path)) return undefined;
  const token = readFileSync(path, "utf8").trim();
  return token || undefined;
}

export function inboxStatus(planId: string): InboxStatus {
  if (!brokerSharedDir()) return "broker-not-configured";
  if (readInboxToken(planId)) return "approved";
  const rejected = inboxPath("rejected", planId);
  if (rejected && existsSync(rejected)) return "rejected";
  return "awaiting-operator";
}

/** The plan as the broker holds it: approved/ first (what the owner signed), then pending/. Malformed files are ignored. */
export function readInboxPlan(planId: string): { plan: ActionPlan; where: "approved" | "pending" } | undefined {
  for (const where of ["approved", "pending"] as const) {
    const path = inboxPath(where, planId);
    if (!path || !existsSync(path)) continue;
    try {
      return { plan: ActionPlanSchema.parse(JSON.parse(readFileSync(path, "utf8"))), where };
    } catch {
      /* a malformed plan is not a plan */
    }
  }
  return undefined;
}

/**
 * Puts a plan in pending/. An existing pending plan is kept (so a repeated request does not reset the owner's
 * view) unless it has expired, in which case it is replaced by the fresh one. Never touches approved/ or
 * authorizations/.
 */
export function proposeInboxPlan(plan: ActionPlan, now = new Date(), opts: { replace?: (existing: ActionPlan) => boolean } = {}): { written: boolean; path: string } {
  const pending = inboxPath("pending", plan.planId);
  if (!pending) throw new Error("no broker shared directory is configured");
  const existing = readInboxPlan(plan.planId);
  // Keep a live pending plan unless the caller says it is not the plan it would propose: anyone can write to
  // pending/, so the owner must be shown the Runtime's plan, not a look-alike with the same id.
  if (existing?.where === "pending" && Date.parse(existing.plan.expiresAt) > now.getTime() && !opts.replace?.(existing.plan)) {
    return { written: false, path: pending };
  }
  mkdirSync(join(brokerSharedDir() as string, "pending"), { recursive: true });
  const tmp = `${pending}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(tmp, pending);
  return { written: true, path: pending };
}
