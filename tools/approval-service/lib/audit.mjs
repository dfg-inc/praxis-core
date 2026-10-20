/**
 * Append-only, hash-chained audit log in the service's protected state directory. Each entry commits to the one
 * before it, so removing or editing an entry is detectable by verifyChain(). It records decisions and outcomes, never
 * tokens, keys, credentials or the content of files.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const GENESIS = "sha256:" + "0".repeat(64);
const SECRET_SHAPED = /(token|secret|password|authorization|private)/i;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashOf = (prev, entry) => `sha256:${createHash("sha256").update(prev).update("\n").update(canonical(entry)).digest("hex")}`;

/** Drops anything that looks like a secret before it can reach the log. */
export function scrub(data) {
  if (Array.isArray(data)) return data.map(scrub);
  if (data && typeof data === "object") return Object.fromEntries(Object.entries(data).filter(([k]) => !SECRET_SHAPED.test(k)).map(([k, v]) => [k, scrub(v)]));
  if (typeof data === "string") return data.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]").replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//[redacted]@");
  return data;
}

export function createAudit(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const lastOnDisk = () => {
    if (!existsSync(file)) return undefined;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : undefined;
  };
  /** Several writers (the service and the enrollment command) share one chain, so each append takes a short file lock and re-reads the tail. */
  const withLock = (fn) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
        } catch {
          /* raced with the holder */
        }
        if (Date.now() > deadline) throw new Error("audit log is locked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  };
  return {
    file,
    append(event, data = {}) {
      return withLock(() => {
        const last = lastOnDisk();
        const entry = { seq: (last?.seq ?? 0) + 1, at: new Date().toISOString(), event, data: scrub(data) };
        const record = { ...entry, prev: last?.hash ?? GENESIS };
        record.hash = hashOf(record.prev, entry);
        appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        return record;
      });
    },
    verify() {
      let prev = GENESIS;
      const entries = read();
      for (const [index, record] of entries.entries()) {
        const { prev: recordedPrev, hash, ...entry } = record;
        if (recordedPrev !== prev || entry.seq !== index + 1 || hashOf(prev, entry) !== hash) {
          return { ok: false, entries: entries.length, brokenAt: index + 1 };
        }
        prev = hash;
      }
      return { ok: true, entries: entries.length };
    },
    entries: read,
  };
}
