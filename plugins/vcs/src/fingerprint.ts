import { createHash } from "node:crypto";

export function deliveryFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;
}
