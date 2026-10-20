import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAudit } from "./audit.mjs";

/**
 * Opens a short enrollment window by writing a one-time code into the service's private state directory. Only the
 * service principal (or root) can write there, so the agent can neither read the code nor open the window. This does
 * not start a service instance and does not touch the ledger of a running one.
 */
export function openEnrollmentWindow(stateDir, origin, minutes = 15) {
  const trusted = join(stateDir, "trusted");
  mkdirSync(trusted, { recursive: true, mode: 0o700 });
  const code = randomUUID().replaceAll("-", "").slice(0, 16);
  const file = join(trusted, "enroll.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ code, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  createAudit(join(stateDir, "audit", "chain.jsonl")).append("enrollment-opened", { minutes });
  return { code, origin, minutes };
}
