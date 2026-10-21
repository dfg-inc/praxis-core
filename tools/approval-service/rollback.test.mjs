/**
 * Rollback, tampering and replay, as three separate questions about an approval that has ALREADY been used.
 *   rollback  : the owner goes back to an older CODE version (what `ctl.sh rollback` does: code only, state untouched).
 *   tampering : somebody edits or restores STATE (ledger, audit, anchors) to make the used approval look unused.
 *   replay    : the used approval is presented again, with the service restarted in between.
 * Real service logic, real Git, real WebAuthn verification (software authenticator, TEST ONLY); one OS identity, so this proves
 * the service's behaviour, not isolation.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { git, makeRepo, stage, startService } from "./test-harness.mjs";

process.env.PRAXIS_APPROVAL_PLAN_TTL_MS = "60000";
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
});

const commitRequest = (repo, message = "add file") => ({ op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-1", params: { message } });
const count = (repo) => Number(git(repo, "rev-list", "--count", "HEAD"));

/** A service with an external anchor sink and ONE approval already used for ONE commit. */
async function used() {
  const root = mkdtempSync("/tmp/pas-rb-");
  const sink = mkdtempSync("/tmp/pas-rb-sink-");
  const a = makeRepo(root, "repo-a");
  const repos = [{ path: a.dir, remotes: { origin: a.remote }, branches: ["main", "feature/*"] }];
  const extraConfig = { auditAnchorDirs: [sink] };
  const h = await startService({ root, repos, extraConfig });
  await h.enroll();
  cleanups.push(async () => {
    await h.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    rmSync(sink, { recursive: true, force: true });
  });
  // a copy of the state taken BEFORE the approval was used: what an attacker would restore
  const before = mkdtempSync("/tmp/pas-rb-before-");
  cpSync(h.stateDir, join(before, "state"), { recursive: true });
  stage(a.dir, "n.txt", "n\n");
  const s = await h.call(commitRequest(a.dir));
  await h.decide(s.requestId);
  const first = await h.call({ op: "execute", requestId: s.requestId });
  assert.equal(first.ok, true, JSON.stringify(first));
  const restart = async (state) => {
    const next = await startService({ root: mkdtempSync("/tmp/pas-rb2-"), state: state ?? h.stateDir, repos, extraConfig: { ...extraConfig, operator: { port: h.port, origin: h.origin } } });
    cleanups.push(() => next.close().catch(() => undefined));
    return next;
  };
  return { root, sink, a, h, s, first, before: join(before, "state"), restart, extraConfig, repos };
}
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).filter((f) => /\.json$|\.jsonl$/.test(f)).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));

describe("rollback: going back to older CODE leaves a used approval used", () => {
  test("a service restarted on the same state (older code, new process) neither re-executes nor un-consumes the approval", async () => {
    const { a, h, s, first, restart } = await used();
    const commits = count(a.dir);
    await h.close();
    const older = await restart(); // same state directory, a different process: what a code rollback produces
    const again = await older.call({ op: "execute", requestId: s.requestId });
    assert.equal(again.ok, true);
    assert.deepEqual(again.result, first.result, "the recorded result is returned");
    assert.equal(count(a.dir), commits, "no second commit");
    // a NEW commit needs a NEW human approval; the old one grants nothing
    stage(a.dir, "m.txt", "m\n");
    const fresh = await older.call(commitRequest(a.dir, "another"));
    const blocked = await older.call({ op: "execute", requestId: fresh.requestId });
    assert.equal(blocked.ok, false, "an undecided request cannot run on the strength of an earlier approval");
    assert.equal(count(a.dir), commits);
  });

  test("the state a code rollback must not touch is byte-identical after a restart (ledger, audit chain, anchors)", async () => {
    const { h, restart, sink } = await used();
    await h.close();
    const stateBefore = snapshot(h.stateDir);
    const sinkBefore = snapshot(sink);
    await restart();
    const stateAfter = snapshot(h.stateDir);
    for (const [file, text] of Object.entries(stateBefore)) {
      if (/\.jsonl$/.test(file)) assert.ok(stateAfter[file].startsWith(text.trimEnd()), `${file}: only appended to, never rewritten`);
      else if (/anchor/.test(file)) assert.ok(JSON.parse(stateAfter[file]).seq >= JSON.parse(text).seq, `${file}: an anchor never goes backwards`);
      else if (/ledger/.test(file)) assert.equal(stateAfter[file], text, `${file}: the consumed ledger entry is untouched`);
    }
    assert.ok(Object.keys(sinkBefore).length > 0, "the external sink holds an anchor");
  });
});

describe("tampering: making a used approval look unused is detected", () => {
  test("restoring an OLDER state directory is refused because the external sink is newer", async () => {
    const { h, before, restart } = await used();
    await h.close();
    rmSync(h.stateDir, { recursive: true, force: true });
    cpSync(before, h.stateDir, { recursive: true });
    await assert.rejects(() => restart(), /truncated or rolled back|INTEGRITY_FAILED|anchor/);
  });

  test("erasing only the ledger entry of the used approval is refused", async () => {
    const { h, restart } = await used();
    await h.close();
    for (const f of readdirSync(join(h.stateDir, "ledger"))) rmSync(join(h.stateDir, "ledger", f));
    await assert.rejects(() => restart(), /INTEGRITY_FAILED|ledger/);
  });

  test("editing the ledger entry (status back to approved) is refused or ignored, never executed", async () => {
    const { a, h, s, restart } = await used();
    const commits = count(a.dir);
    await h.close();
    for (const f of readdirSync(join(h.stateDir, "ledger"))) {
      const path = join(h.stateDir, "ledger", f);
      const entry = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...entry, status: "approved", result: undefined }));
    }
    let next;
    try {
      next = await restart();
    } catch (error) {
      assert.match(String(error.message), /INTEGRITY_FAILED|ledger|anchor/);
      return; // refused to start: the strongest outcome
    }
    const run = await next.call({ op: "execute", requestId: s.requestId });
    assert.equal(count(a.dir), commits, `the edited entry must not produce a second commit (${JSON.stringify(run).slice(0, 200)})`);
  });

  test("a forged or deleted anchor in the external sink is refused", async () => {
    const { h, sink, restart } = await used();
    await h.close();
    rmSync(join(sink, "latest.json"));
    await assert.rejects(() => restart(), /sink was deleted|INTEGRITY_FAILED/);
    writeFileSync(join(sink, "latest.json"), JSON.stringify({ seq: 1, hash: `sha256:${"0".repeat(64)}`, ledgerCount: 0, at: new Date().toISOString(), signature: "AAAA" }));
    await assert.rejects(() => restart(), /invalid signature|INTEGRITY_FAILED/);
  });
});

describe("replay: presenting a used approval again", () => {
  test("the same request id returns the recorded result, with or without a restart, and never a second commit", async () => {
    const { a, h, s, first, restart } = await used();
    const commits = count(a.dir);
    const same = await h.call({ op: "execute", requestId: s.requestId });
    assert.deepEqual(same.result, first.result);
    await h.close();
    const next = await restart();
    for (let i = 0; i < 3; i += 1) {
      const r = await next.call({ op: "execute", requestId: s.requestId });
      assert.deepEqual(r.result, first.result);
    }
    assert.equal(count(a.dir), commits);
  });

  test("a different request cannot borrow the used approval's decision (a changed plan needs its own human decision)", async () => {
    const { a, h, s } = await used();
    const commits = count(a.dir);
    stage(a.dir, "other.txt", "other\n");
    const other = await h.call(commitRequest(a.dir, "different message"));
    assert.notEqual(other.requestId, s.requestId);
    const run = await h.call({ op: "execute", requestId: other.requestId });
    assert.equal(run.ok, false);
    assert.equal(count(a.dir), commits);
  });
});
