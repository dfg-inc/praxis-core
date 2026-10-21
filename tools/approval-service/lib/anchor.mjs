/**
 * Independent pinning of the audit chain's head.
 *
 * A hash chain detects an edit or removal in the middle, but not a truncated tail or a rolled-back file: the shorter
 * chain is still internally consistent. So after every audit append the service writes a SIGNED record of the head
 * (sequence number, hash, number of consumed approvals in the ledger) to one or more independent sinks, and at start
 * and before each execution compares the chain and the ledger with them:
 *
 *   chain shorter than an anchor, or a different hash at the anchored sequence   -> truncation or rollback
 *   ledger with fewer consumptions than an anchor                                -> ledger rollback (replay risk)
 *   one sink anchored and another empty or behind                                -> a sink was deleted or restored
 *
 * Sinks: `<state>/anchors` always, plus every directory in config `auditAnchorDirs` (put those on a different
 * protected location). An attacker who can rewrite ALL sinks together with the chain and the signing key defeats it;
 * `exportWitness` produces a signed head the owner can keep off the machine, and `verifyWitness` checks a chain against it.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const body = (a) => Buffer.from(canonical({ seq: a.seq, hash: a.hash, ledgerCount: a.ledgerCount, at: a.at, kind: "praxis.audit.anchor.v1" }));

export function createAnchors({ sinks, privateKeyPem, publicKeyPem, audit, ledgerDir, now = () => new Date() }) {
  const ledgerCount = () => (existsSync(ledgerDir) ? readdirSync(ledgerDir).filter((f) => f.endsWith(".json")).length : 0);
  const latestPath = (dir) => join(dir, "latest.json");
  const read = (dir) => {
    try {
      return JSON.parse(readFileSync(latestPath(dir), "utf8"));
    } catch {
      return undefined;
    }
  };
  const valid = (anchor) => {
    try {
      return verify(null, body(anchor), createPublicKey(publicKeyPem), Buffer.from(anchor.signature, "base64"));
    } catch {
      return false;
    }
  };

  function write() {
    const entries = audit.entries();
    const last = entries.at(-1);
    if (!last) return undefined;
    const anchor = { seq: last.seq, hash: last.hash, ledgerCount: ledgerCount(), at: now().toISOString() };
    anchor.signature = sign(null, body(anchor), createPrivateKey(privateKeyPem)).toString("base64");
    for (const dir of sinks) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${latestPath(dir)}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(anchor)}\n`, { mode: 0o600 });
      renameSync(tmp, latestPath(dir));
    }
    return anchor;
  }

  /** @returns {{ok: boolean, problems: string[], anchored: number}} */
  function check() {
    const problems = [];
    const chain = audit.verify();
    if (!chain.ok) problems.push(`audit chain is broken at entry ${chain.brokenAt}`);
    const entries = audit.entries();
    const anchors = sinks.map((dir) => ({ dir, anchor: read(dir) }));
    const present = anchors.filter((a) => a.anchor);
    for (const { dir, anchor } of present) {
      if (!valid(anchor)) {
        problems.push(`anchor in ${dir} has an invalid signature`);
        continue;
      }
      const at = entries[anchor.seq - 1];
      if (entries.length < anchor.seq) problems.push(`audit chain has ${entries.length} entries but ${dir} anchors sequence ${anchor.seq}: truncated or rolled back`);
      else if (at.hash !== anchor.hash) problems.push(`audit entry ${anchor.seq} differs from the anchor in ${dir}: rewritten or rolled back`);
      if (ledgerCount() < anchor.ledgerCount) problems.push(`ledger has ${ledgerCount()} consumed approvals but ${dir} anchors ${anchor.ledgerCount}: ledger rolled back`);
    }
    if (present.length && present.length < anchors.length) {
      problems.push(`anchor missing in ${anchors.filter((a) => !a.anchor).map((a) => a.dir).join(", ")} while others have one: a sink was deleted or restored`);
    }
    // every consumption the audit chain records must still be in the ledger
    const consumed = entries.filter((e) => e.event === "execution-started").map((e) => e.data.consumptionId);
    const missing = consumed.filter((id) => !existsSync(join(ledgerDir, `${id}.json`)));
    if (missing.length) problems.push(`${missing.length} consumed approval(s) recorded in the audit are missing from the ledger (replay risk)`);
    return { ok: problems.length === 0, problems, anchored: present.length };
  }

  function exportWitness() {
    const anchor = write() ?? read(sinks[0]);
    return anchor ? { ...anchor, publicKeyPem } : undefined;
  }

  return { write, check, exportWitness, ledgerCount };
}

/** Checks an audit chain against a witness the owner exported earlier and stored elsewhere. */
export function verifyWitness(witness, entries) {
  const problems = [];
  let signatureOk = false;
  try {
    signatureOk = verify(null, body(witness), createPublicKey(witness.publicKeyPem), Buffer.from(witness.signature, "base64"));
  } catch {
    /* invalid */
  }
  if (!signatureOk) problems.push("the witness signature is not valid");
  if (entries.length < witness.seq) problems.push(`the chain has ${entries.length} entries; the witness was taken at ${witness.seq}`);
  else if (entries[witness.seq - 1].hash !== witness.hash) problems.push(`entry ${witness.seq} differs from the witness`);
  return { ok: problems.length === 0, problems };
}
