/**
 * Real-process-logic tests of the Approval Service: real IPC socket, real Git repositories, real WebAuthn
 * verification (software authenticator, TEST ONLY). One OS identity runs everything, so these are NOT proof of
 * independent-OS-identity isolation; they prove the service's logic, protocol and executor. The numbers in the test
 * names refer to the 18 required scenarios of the Native Approval Service milestone.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { assessApprovalService, callApprovalService } from "../../packages/contracts/dist/index.js";
import { git, makeRepo, readJson, stage, startService } from "./test-harness.mjs";

process.env.PRAXIS_APPROVAL_PLAN_TTL_MS = "60000";
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
});

async function world(opts = {}) {
  const root = mkdtempSync("/tmp/pas-");
  const a = makeRepo(root, "repo-a");
  const b = makeRepo(root, "repo-b");
  const h = await startService({
    root,
    repos: [
      { path: a.dir, remotes: { origin: a.remote }, branches: ["main", "feature/*"] },
      { path: b.dir, remotes: { origin: b.remote }, branches: ["main", "feature/*"] },
    ],
    ...opts,
  });
  await h.enroll();
  cleanups.push(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, a, b, h };
}

const commitRequest = (repo, message = "add file", extra = {}) => ({ op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-1", params: { message }, ...extra });
const head = (repo) => git(repo, "rev-parse", "HEAD");

describe("1-4: submit, reject, approve, execute one commit", () => {
  test("1/3/4 agent submits; a human-verified approval of the exact plan lets the service make one commit", async () => {
    const { a, h } = await world();
    stage(a.dir, "feature.txt", "hello\n");
    const before = head(a.dir);
    const submitted = await h.call(commitRequest(a.dir));
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.state, "awaiting-operator");
    const plan = readJson(h.planFile(submitted.requestId));
    // the plan is derived by the service from the repository, not from the agent's description
    assert.equal(plan.workItemIds[0], "WI-1");
    assert.equal(plan.repositories[0], realpathSync(a.dir));
    assert.ok(plan.actions[0].targets.some((t) => t.startsWith("tree:")));
    assert.ok(plan.actions[0].targets.some((t) => t.startsWith("feature.txt@")));
    assert.ok(plan.actions[0].targets.includes("branch:main"));
    assert.equal(head(a.dir), before, "submitting changes nothing");
    // not approved: execute is refused and changes nothing
    const early = await h.call({ op: "execute", requestId: submitted.requestId });
    assert.equal(early.ok, false);
    assert.equal(early.code, "APPROVAL_REQUIRED");
    assert.equal(head(a.dir), before);
    const approved = await h.decide(submitted.requestId);
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal((await h.call({ op: "status", requestId: submitted.requestId })).state, "approved");
    const done = await h.call({ op: "execute", requestId: submitted.requestId });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.state, "completed");
    assert.equal(done.replayed, false);
    assert.equal(git(a.dir, "rev-parse", "HEAD^"), before, "exactly one new commit on top of the old head");
    assert.equal(git(a.dir, "log", "-1", "--format=%an <%ae>|%s"), "Praxis Approval Service <approval-service@localhost>|add file");
    assert.equal(git(a.dir, "show", "--name-only", "--format=", "HEAD"), "feature.txt");
    assert.equal(git(a.dir, "rev-parse", "HEAD"), done.result.commit);
  });

  test("2 a rejection mutates nothing and cannot be executed", async () => {
    const { a, h } = await world();
    stage(a.dir, "x.txt", "x\n");
    const before = head(a.dir);
    const s = await h.call(commitRequest(a.dir));
    const rejected = await h.decide(s.requestId, "reject");
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
    assert.equal((await h.call({ op: "status", requestId: s.requestId })).state, "rejected");
    const run = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(run.code, "APPROVAL_REJECTED");
    assert.equal(head(a.dir), before);
  });
});

describe("5-10: expiry, changed plan, scope, forgery, replay", () => {
  test("5 an expired approval is refused", async () => {
    const { a, h } = await world();
    stage(a.dir, "e.txt", "e\n");
    const before = head(a.dir);
    process.env.PRAXIS_APPROVAL_PLAN_TTL_MS = "1000";
    const s = await h.call(commitRequest(a.dir));
    process.env.PRAXIS_APPROVAL_PLAN_TTL_MS = "60000";
    assert.equal((await h.decide(s.requestId)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const run = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(run.ok, false);
    assert.match(run.code, /APPROVAL_EXPIRED|APPROVAL_REQUIRED/);
    assert.equal(head(a.dir), before);
  });

  test("6 a plan changed after it was shown is not executed (staged content swapped; config turned hostile)", async () => {
    const { a, b, h } = await world();
    stage(a.dir, "p.txt", "approved\n");
    const before = head(a.dir);
    const s = await h.call(commitRequest(a.dir));
    assert.equal((await h.decide(s.requestId)).status, 200);
    stage(a.dir, "p.txt", "SWAPPED AFTER APPROVAL\n"); // TOCTOU on the index
    const run = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(run.code, "APPROVAL_SCOPE_MISMATCH");
    assert.equal(head(a.dir), before, "nothing was committed");
    // restoring the approved state makes the same approval usable again: it was not burned by the refusal
    stage(a.dir, "p.txt", "approved\n");
    assert.equal((await h.call({ op: "execute", requestId: s.requestId })).ok, true);
    // a hostile local setting added after approval is refused before anything runs
    stage(b.dir, "q.txt", "q\n");
    const s2 = await h.call(commitRequest(b.dir));
    assert.equal((await h.decide(s2.requestId)).status, 200);
    git(b.dir, "config", "core.hooksPath", "/tmp/evil-hooks");
    const bad = await h.call({ op: "execute", requestId: s2.requestId });
    assert.equal(bad.code, "REPOSITORY_UNSAFE");
  });

  test("a tampered approved plan file is refused", async () => {
    const { a, h } = await world();
    stage(a.dir, "t.txt", "t\n");
    const s = await h.call(commitRequest(a.dir));
    await h.decide(s.requestId);
    const file = h.planFile(s.requestId, "approved");
    const plan = readJson(file);
    plan.summary = "Something the owner never saw";
    writeFileSync(file, JSON.stringify(plan));
    const run = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(run.ok, false);
    assert.match(run.code, /APPROVAL_REQUIRED|APPROVAL_SCOPE_MISMATCH|APPROVAL_FINGERPRINT_MISMATCH/);
  });

  test("7 an approval for one repository cannot be used for another", async () => {
    const { a, b, h } = await world();
    stage(a.dir, "same.txt", "same\n");
    stage(b.dir, "same.txt", "same\n");
    const sa = await h.call(commitRequest(a.dir));
    const sb = await h.call(commitRequest(b.dir));
    assert.notEqual(sa.requestId, sb.requestId);
    await h.decide(sa.requestId);
    const beforeB = head(b.dir);
    // copy A's token to B's slot: the token names plan A, so it is not B's approval
    const tokenA = readFileSync(join(h.stateDir, "shared", "authorizations", `${sa.requestId}.token`), "utf8");
    writeFileSync(join(h.stateDir, "shared", "authorizations", `${sb.requestId}.token`), tokenA);
    writeFileSync(h.planFile(sb.requestId, "approved"), readFileSync(h.planFile(sa.requestId, "approved")));
    const run = await h.call({ op: "execute", requestId: sb.requestId });
    assert.equal(run.ok, false);
    assert.match(run.code, /APPROVAL_SCOPE_MISMATCH|APPROVAL_REQUIRED/);
    assert.equal(head(b.dir), beforeB);
  });

  test("8 a commit approval cannot authorize a push", async () => {
    const { a, h } = await world();
    stage(a.dir, "c.txt", "c\n");
    const sc = await h.call(commitRequest(a.dir));
    await h.decide(sc.requestId);
    assert.equal((await h.call({ op: "execute", requestId: sc.requestId })).ok, true);
    const sp = await h.call({ op: "submit", operation: "git_push", repository: a.dir, workItemId: "WI-1", params: { remote: "origin", branch: "main" } });
    assert.equal(sp.state, "awaiting-operator");
    assert.notEqual(sp.requestId, sc.requestId);
    writeFileSync(join(h.stateDir, "shared", "authorizations", `${sp.requestId}.token`), readFileSync(join(h.stateDir, "shared", "authorizations", `${sc.requestId}.token`), "utf8"));
    writeFileSync(h.planFile(sp.requestId, "approved"), readFileSync(h.planFile(sc.requestId, "approved")));
    const run = await h.call({ op: "execute", requestId: sp.requestId });
    assert.equal(run.ok, false);
    assert.match(run.code, /APPROVAL_SCOPE_MISMATCH|APPROVAL_SCOPE_SEPARATE|APPROVAL_REQUIRED/);
    assert.equal(git(a.remote, "for-each-ref", "refs/heads").length, 0, "nothing was pushed");
  });

  test("9 forged approvals are refused (wrong key, machine channel, no channel)", async () => {
    const { generateApprovalKeyPair, signAuthorization, encodeAuthorization, approvedContentDigest, buildGitPlan } = await import("../../packages/contracts/dist/index.js");
    const { a, h } = await world();
    stage(a.dir, "f.txt", "f\n");
    const before = head(a.dir);
    const s = await h.call(commitRequest(a.dir));
    const plan = readJson(h.planFile(s.requestId));
    const forge = (privateKeyPem, channel) => {
      const action = plan.actions[0];
      const body = {
        contract: "praxis.approval.authorization", version: 1, planId: plan.planId, planFingerprint: plan.fingerprint, provider: plan.provider, instanceId: plan.instanceId,
        operations: plan.operations, workItemIds: plan.workItemIds, repositories: plan.repositories, action: action.action, targets: action.targets, decisionKind: plan.decisionKind,
        ...(channel ? { channel } : {}), content: action.content, contentDigest: approvedContentDigest(action.content), approver: "attacker",
        issuedAt: new Date().toISOString(), expiresAt: plan.expiresAt, consumptionId: `c-forged-${Math.random().toString(16).slice(2, 10)}`,
      };
      return encodeAuthorization(signAuthorization(body, privateKeyPem));
    };
    const slot = join(h.stateDir, "shared", "authorizations", `${s.requestId}.token`);
    writeFileSync(h.planFile(s.requestId, "approved"), JSON.stringify(plan));
    for (const [label, token] of [
      ["wrong key", forge(generateApprovalKeyPair().privateKeyPem, "webauthn:abc")],
      ["machine channel signed with the real key", forge(readFileSync(join(h.stateDir, "trusted", "private.pem"), "utf8"), "machine")],
      ["no channel signed with the real key", forge(readFileSync(join(h.stateDir, "trusted", "private.pem"), "utf8"), undefined)],
    ]) {
      writeFileSync(slot, token);
      const run = await h.call({ op: "execute", requestId: s.requestId });
      assert.equal(run.ok, false, label);
      assert.equal(head(a.dir), before, `${label}: nothing changed`);
      rmSync(slot);
    }
    assert.ok(buildGitPlan);
  });

  test("10 replay returns the recorded result; concurrent executes make exactly one commit", async () => {
    const { a, h } = await world();
    stage(a.dir, "r.txt", "r\n");
    const before = head(a.dir);
    const s = await h.call(commitRequest(a.dir));
    await h.decide(s.requestId);
    const runs = await Promise.all(Array.from({ length: 6 }, () => h.call({ op: "execute", requestId: s.requestId })));
    const completed = runs.filter((r) => r.ok && r.state === "completed");
    assert.ok(completed.length >= 1);
    assert.equal(new Set(completed.map((r) => r.result.commit)).size, 1, "every success reports the same commit");
    assert.equal(completed.filter((r) => !r.replayed).length, 1, "exactly one real execution");
    const again = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(again.replayed, true);
    assert.equal(git(a.dir, "rev-list", "--count", `${before}..HEAD`), "1");
  });
});

describe("11-13: the agent's reach", () => {
  test("11/12 the protocol has no approve/sign/config message and never returns key material or tokens", async () => {
    const { a, h } = await world();
    stage(a.dir, "k.txt", "k\n");
    const s = await h.call(commitRequest(a.dir));
    await h.decide(s.requestId);
    for (const op of ["approve", "reject", "sign", "set-config", "write", "grant", "enroll", "exec", "shell"]) {
      const reply = await h.call({ op, requestId: s.requestId });
      assert.equal(reply.ok, false, op);
      assert.equal(reply.code, "UNKNOWN_OPERATION", op);
    }
    const strict = await h.call({ ...commitRequest(a.dir), params: { message: "m", authorization: "x", force: true } });
    assert.equal(strict.code, "BAD_REQUEST");
    assert.equal((await h.call({ op: "status", requestId: "../../etc/passwd" })).code, "BAD_REQUEST");
    const replies = JSON.stringify([await h.call({ op: "health" }), await h.call({ op: "status", requestId: s.requestId }), await h.call({ op: "execute", requestId: s.requestId })]);
    const token = readFileSync(join(h.stateDir, "shared", "authorizations", `${s.requestId}.token`), "utf8").trim();
    assert.ok(!replies.includes(token) && !replies.includes("PRIVATE KEY") && !replies.includes(token.slice(0, 40)));
    const audit = readFileSync(join(h.stateDir, "audit", "chain.jsonl"), "utf8");
    assert.ok(!audit.includes(token) && !audit.includes("PRIVATE KEY") && !/bearer\s+\S{8,}/i.test(audit));
    assert.equal(statModeOf(join(h.stateDir, "trusted", "private.pem")), 0o600);
    assert.equal(statModeOf(h.stateDir), 0o700);
  });

  test("13 an impersonator on the endpoint is not trusted by the client (same owner, even if it claims production isolation)", async () => {
    const dir = mkdtempSync("/tmp/pas-");
    const endpoint = join(dir, "fake.sock");
    const fake = createServer((socket) => {
      socket.once("data", () => socket.end(`${JSON.stringify({ ok: true, protocol: "praxis.approval-service.v1", health: { service: "praxis-approval-service", version: "9", protocol: "praxis.approval-service.v1", mode: "production", platform: "darwin", uptimeSec: 1, isolation: { verified: true, principal: "_praxisapproval", checks: [] }, operatorChannel: { url: "x", enrolledAuthenticators: 1 }, pending: 0, auditChain: { ok: true, entries: 0 }, ledgerEntries: 0 } })}\n`));
    });
    await new Promise((resolve) => fake.listen(endpoint, resolve));
    cleanups.push(async () => fake.close());
    const assessment = await assessApprovalService({ endpoint });
    assert.equal(assessment.reachable, true);
    assert.equal(assessment.isolated, false, "a same-user endpoint is never reported isolated");
    assert.ok(assessment.reasons.some((r) => /same user|writable/.test(r)));
  });
});

describe("14-16: concurrency, restart, fail closed", () => {
  test("14 concurrent requests in different repositories are isolated", async () => {
    const { a, b, h } = await world();
    stage(a.dir, "a.txt", "a\n");
    stage(b.dir, "b.txt", "b\n");
    const [sa, sb] = await Promise.all([h.call(commitRequest(a.dir, "A")), h.call(commitRequest(b.dir, "B"))]);
    // one authenticator signs one assertion at a time (its counter must advance in order); execution below is concurrent
    assert.equal((await h.decide(sa.requestId)).status, 200);
    assert.equal((await h.decide(sb.requestId)).status, 200);
    const [ra, rb] = await Promise.all([h.call({ op: "execute", requestId: sa.requestId }), h.call({ op: "execute", requestId: sb.requestId })]);
    assert.equal(ra.ok && rb.ok, true, JSON.stringify([ra, rb]));
    assert.equal(git(a.dir, "log", "-1", "--format=%s"), "A");
    assert.equal(git(b.dir, "log", "-1", "--format=%s"), "B");
    assert.equal(git(a.dir, "show", "--name-only", "--format=", "HEAD"), "a.txt");
    assert.equal(git(b.dir, "show", "--name-only", "--format=", "HEAD"), "b.txt");
  });

  test("15 a restart preserves the ledger (replay) and marks an interrupted execution for reconciliation", async () => {
    const { a, h } = await world();
    stage(a.dir, "d.txt", "d\n");
    const s = await h.call(commitRequest(a.dir));
    await h.decide(s.requestId);
    const first = await h.call({ op: "execute", requestId: s.requestId });
    const ledgerDir = join(h.stateDir, "ledger");
    // simulate a crash mid-execution: a started row left behind
    writeFileSync(join(ledgerDir, "c-interrupted.json"), JSON.stringify({ status: "started", requestFingerprint: "sha256:x" }));
    await h.close();
    const h2 = await startService({ root: mkdtempSync("/tmp/pas-"), state: h.stateDir, repos: h.config.repositories, extraConfig: { operator: { port: h.port, origin: h.origin } } });
    cleanups.push(() => h2.close());
    const replay = await h2.call({ op: "execute", requestId: s.requestId });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.commit, first.result.commit);
    assert.equal(readJson(join(ledgerDir, "c-interrupted.json")).status, "requires_reconciliation");
    assert.equal(h2.service.audit.verify().ok, true);
  });

  test("16 missing trust anchor, unverified production isolation, and a dead service all fail closed", async () => {
    const { a, h } = await world();
    stage(a.dir, "g.txt", "g\n");
    const before = head(a.dir);
    const s = await h.call(commitRequest(a.dir));
    await h.decide(s.requestId);
    rmSync(join(h.stateDir, "trusted", "public.pem"));
    const run = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(run.ok, false);
    assert.equal(head(a.dir), before);

    const failing = [{ id: "state-private", ok: false, detail: "state directory is world readable" }];
    await assert.rejects(() => startService({ mode: "production", probe: () => failing }), /ISOLATION_UNAVAILABLE|refusing to start in production/);
    // production service whose isolation drifts after start refuses to execute
    let drift = false;
    const w = await world({ mode: "production", probe: () => (drift ? failing : [{ id: "ok", ok: true, detail: "ok" }]) });
    stage(w.a.dir, "h.txt", "h\n");
    const s2 = await w.h.call(commitRequest(w.a.dir));
    await w.h.decide(s2.requestId);
    drift = true;
    const refused = await w.h.call({ op: "execute", requestId: s2.requestId });
    assert.equal(refused.code, "APPROVAL_ISOLATION_UNAVAILABLE");
    assert.equal(head(w.a.dir), git(w.a.dir, "rev-parse", "HEAD"));
    assert.equal(git(w.a.dir, "rev-list", "--count", "HEAD"), "1");

    await assert.rejects(() => callApprovalService({ op: "health" }, { endpoint: join(w.root, "nothing.sock"), timeoutMs: 500 }), /not reachable/);
    process.env.PRAXIS_BUNDLE_KIND = "production";
    try {
      await assert.rejects(() => startService({ mode: "development" }), /development mode is not available|DEV_MODE_REFUSED/);
    } finally {
      delete process.env.PRAXIS_BUNDLE_KIND;
    }
  });
});

describe("17: Docker control", () => {
  test("17 the isolation probe fails when the service identity can reach a Docker control socket", async () => {
    const { posixIsolationChecks } = await import("./platform/common.mjs");
    const dir = mkdtempSync("/tmp/pas-");
    const sock = join(dir, "docker.sock");
    writeFileSync(sock, "");
    chmodSync(sock, 0o666);
    const paths = { stateDir: dir, codeDir: dir, configFile: join(dir, "c.json"), endpoint: join(dir, "s.sock") };
    const checks = posixIsolationChecks({ paths, config: {}, dockerSockets: [sock] });
    assert.equal(checks.find((c) => c.id === "no-docker-control").ok, false);
    assert.equal(checks.every((c) => c.ok), false);
  });
});

describe("18: user repositories stay clean", () => {
  test("18 a full commit/push/merge-request flow adds no branches, refs, files or approval artifacts to the repository", async () => {
    const { a, h } = await world({ providersConfig: { fixture: { instances: { "fixture/demo": { actions: ["create_merge_request"] } } } } });
    h.config.repositories[0].provider = { kind: "fixture", instanceId: "fixture/demo" };
    const tree = () => git(a.dir, "ls-files") + "|" + git(a.dir, "for-each-ref", "--format=%(refname)");
    const refsBefore = git(a.dir, "for-each-ref", "--format=%(refname)");
    git(a.dir, "checkout", "-q", "-b", "feature/x");
    stage(a.dir, "doc.txt", "doc\n");
    const sc = await h.call(commitRequest(a.dir, "work"));
    await h.decide(sc.requestId);
    assert.equal((await h.call({ op: "execute", requestId: sc.requestId })).ok, true);
    const sp = await h.call({ op: "submit", operation: "git_push", repository: a.dir, workItemId: "WI-1", params: { remote: "origin", branch: "feature/x" } });
    await h.decide(sp.requestId);
    const pushed = await h.call({ op: "execute", requestId: sp.requestId });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    assert.equal(git(a.remote, "rev-parse", "refs/heads/feature/x"), git(a.dir, "rev-parse", "feature/x"));
    const sm = await h.call({ op: "submit", operation: "merge_request", repository: a.dir, workItemId: "WI-1", params: { remote: "origin", sourceBranch: "feature/x", targetBranch: "main", title: "T" } });
    assert.equal(sm.ok, true, JSON.stringify(sm));
    await h.decide(sm.requestId);
    const mr = await h.call({ op: "execute", requestId: sm.requestId });
    assert.equal(mr.ok, true, JSON.stringify(mr));
    assert.match(mr.result.url, /^fixture:\/\/fixture\/demo\/merge-requests\/1$/);
    const refsAfter = git(a.dir, "for-each-ref", "--format=%(refname)").split("\n").sort();
    assert.deepEqual(refsAfter, [...new Set([...refsBefore.split("\n"), "refs/heads/feature/x"])].sort(), "only the branch the agent made; no approval branches or refs");
    assert.equal(git(a.dir, "status", "--porcelain"), "");
    assert.ok(!existsSync(join(a.dir, ".praxis")));
    assert.ok(!/approv|token|ledger/i.test(readdirSync(a.dir).join(" ") + git(a.dir, "ls-files")));
    assert.ok(tree());
    assert.equal(h.service.audit.verify().ok, true);
  });
});

describe("named-path commits (what the Runtime uses: no agent staging, new branch created by the service)", () => {
  test("commits exactly the named paths from the working tree onto a new branch; the index and other changes are untouched", async () => {
    const { a, h } = await world();
    writeFileSync(join(a.dir, "one.txt"), "one\n");
    writeFileSync(join(a.dir, "two.txt"), "two\n");
    writeFileSync(join(a.dir, "other.txt"), "not in the commit\n");
    stage(a.dir, "decoy.txt", "staged by someone else\n");
    const before = head(a.dir);
    const s = await h.call({ ...commitRequest(a.dir), params: { message: "named", branch: "feature/named", paths: ["one.txt", "two.txt"] } });
    assert.equal(s.state, "awaiting-operator", JSON.stringify(s));
    const plan = readJson(h.planFile(s.requestId));
    assert.ok(plan.actions[0].targets.some((t) => t.startsWith("create-branch:feature/named-from-main@")));
    assert.ok(plan.actions[0].targets.includes("source:named-paths"));
    assert.ok(!plan.actions[0].targets.some((t) => t.startsWith("decoy.txt")), "the plan does not include what was staged elsewhere");
    await h.decide(s.requestId);
    // the working tree changes between approval and execution: refused
    writeFileSync(join(a.dir, "one.txt"), "one CHANGED\n");
    assert.equal((await h.call({ op: "execute", requestId: s.requestId })).code, "APPROVAL_SCOPE_MISMATCH");
    writeFileSync(join(a.dir, "one.txt"), "one\n");
    const done = await h.call({ op: "execute", requestId: s.requestId });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(git(a.dir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/named");
    assert.equal(git(a.dir, "rev-parse", "HEAD^"), before);
    assert.equal(git(a.dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join(","), "one.txt,two.txt");
    assert.equal(git(a.dir, "status", "--porcelain").split("\n").sort().join("|"), "?? other.txt|A  decoy.txt");
  });

  test("hostile paths are refused (traversal, .git, absolute, symlink, directory)", async () => {
    const { root, a, h } = await world();
    symlinkSync("/etc/hosts", join(a.dir, "lnk"));
    for (const path of ["../x", "/etc/passwd", ".git/config", "a//b", "lnk", "."]) {
      const reply = await h.call({ ...commitRequest(a.dir), params: { message: "m", paths: [path] } });
      assert.equal(reply.ok, false, path);
      assert.match(reply.code, /BAD_PATH|UNSUPPORTED_CHANGE|NOTHING_STAGED|GIT_FAILED/, path);
    }
    assert.ok(root);
  });
});

describe("executor hardening", () => {
  test("a repository outside the allow-list, with hostile config, or with a linked .git is refused", async () => {
    const { root, a, h } = await world();
    stage(a.dir, "z.txt", "z\n");
    const outside = makeRepo(root, "outside", { withRemote: false });
    stage(outside.dir, "o.txt", "o\n");
    assert.equal((await h.call(commitRequest(outside.dir))).code, "REPOSITORY_NOT_ALLOWED");
    for (const [key, value] of [["core.fsmonitor", "/tmp/evil"], ["core.hooksPath", "/tmp/evil"], ["core.sshCommand", "evil"], ["credential.helper", "!evil"], ["url.https://evil/.insteadOf", ""], ["alias.x", "!evil"], ["include.path", "/tmp/evil"]]) {
      git(a.dir, "config", key, value);
      const reply = await h.call(commitRequest(a.dir));
      assert.equal(reply.code, "REPOSITORY_UNSAFE", key);
      git(a.dir, "config", "--unset", key);
    }
    // a URL rewrite is refused only when it could change a URL the service itself uses
    git(a.dir, "config", "url.https://evil/.insteadOf", a.remote);
    assert.equal((await h.call(commitRequest(a.dir))).code, "REPOSITORY_UNSAFE", "rewrites the service's own remote URL");
    git(a.dir, "config", "url.https://evil/.insteadOf", "git@github.com:someone/else.git");
    assert.equal((await h.call(commitRequest(a.dir))).ok, true, "a rewrite that cannot touch the service's URLs is harmless to it");
    git(a.dir, "config", "--unset", "url.https://evil/.insteadOf");
    // symlinked parts of .git are refused (they could redirect writes outside the repository)
    const refs = join(a.dir, ".git", "refs");
    renameSync(refs, join(root, "moved-refs"));
    symlinkSync(join(root, "moved-refs"), refs);
    assert.equal((await h.call(commitRequest(a.dir))).code, "REPOSITORY_UNSAFE");
    rmSync(refs);
    renameSync(join(root, "moved-refs"), refs);
    // path substitution: a symlink to the repository resolves to the allow-listed real path (allowed), a symlinked .git is not
    const link = join(root, "link");
    symlinkSync(a.dir, link);
    assert.equal((await h.call(commitRequest(link))).ok, true, "a symlink that resolves to the allow-listed repository is the same repository");
    const sneaky = makeRepo(root, "sneaky", { withRemote: false });
    renameSync(join(sneaky.dir, ".git"), join(root, "sneaky-gitdir"));
    symlinkSync(join(root, "sneaky-gitdir"), join(sneaky.dir, ".git"));
    h.config.repositories.push({ path: sneaky.dir, branches: ["*"] });
    assert.equal((await h.call(commitRequest(sneaky.dir))).code, "REPOSITORY_UNSAFE");
  });

  test("nothing staged, unsupported refs and a remote not in the configuration are refused", async () => {
    const { a, h } = await world();
    assert.equal((await h.call(commitRequest(a.dir))).code, "NOTHING_STAGED");
    const push = (remote, branch) => h.call({ op: "submit", operation: "git_push", repository: a.dir, workItemId: "WI-1", params: { remote, branch } });
    assert.equal((await push("evil", "main")).code, "REMOTE_NOT_ALLOWED");
    assert.equal((await push("origin", "nope")).code, "BRANCH_NOT_ALLOWED");
    assert.equal((await h.call({ ...commitRequest(a.dir), params: { message: "m", branch: "--upload-pack=evil" } })).code, "BAD_REQUEST");
  });

  test("a push that git rejects reports what changed and consumes the approval; the remote is untouched", async () => {
    const { a, h } = await world();
    stage(a.dir, "n.txt", "n\n");
    const sc = await h.call(commitRequest(a.dir));
    await h.decide(sc.requestId);
    await h.call({ op: "execute", requestId: sc.requestId });
    // make the remote diverge so a fast-forward push is impossible
    const other = mkdtempSync("/tmp/pas-");
    git(other, "clone", "-q", a.remote, "c");
    const c = join(other, "c");
    git(c, "config", "user.name", "x");
    git(c, "config", "user.email", "x@x");
    git(c, "checkout", "-q", "-b", "main");
    writeFileSync(join(c, "other.txt"), "other\n");
    git(c, "add", "other.txt");
    git(c, "commit", "-q", "-m", "other");
    git(c, "push", "-q", "origin", "main");
    const remoteBefore = git(a.remote, "rev-parse", "refs/heads/main");
    const sp = await h.call({ op: "submit", operation: "git_push", repository: a.dir, workItemId: "WI-1", params: { remote: "origin", branch: "main" } });
    await h.decide(sp.requestId);
    const run = await h.call({ op: "execute", requestId: sp.requestId });
    assert.equal(run.ok, false);
    assert.equal(run.details.changed.startsWith("nothing"), true);
    assert.equal(git(a.remote, "rev-parse", "refs/heads/main"), remoteBefore);
    const again = await h.call({ op: "execute", requestId: sp.requestId });
    assert.equal(again.code, "APPROVAL_RECONCILIATION_REQUIRED", "a consumed approval is not retried silently");
  });
});

describe("providers", () => {
  test("Jira is blocked; an ungranted provider instance or action is refused before anything is shown", async () => {
    const { a, h } = await world({ providersConfig: { fixture: { instances: { "fixture/demo": { actions: ["read"] } } } } });
    stage(a.dir, "m.txt", "m\n");
    const sc = await h.call(commitRequest(a.dir));
    await h.decide(sc.requestId);
    await h.call({ op: "execute", requestId: sc.requestId });
    const mr = () => h.call({ op: "submit", operation: "merge_request", repository: a.dir, workItemId: "WI-1", params: { remote: "origin", sourceBranch: "main", targetBranch: "main", title: "t" } });
    assert.equal((await mr()).code, "PROVIDER_NOT_CONFIGURED");
    for (const [kind, code] of [["jira", "PROVIDER_BLOCKED"], ["unknown", "PROVIDER_NOT_AUTHORIZED"], ["fixture", "PROVIDER_NOT_AUTHORIZED"]]) {
      h.config.repositories[0].provider = { kind, instanceId: "fixture/demo" };
      assert.equal((await mr()).code, code, kind);
    }
  });
});

describe("audit growth", () => {
  test("a flood of malformed requests does not grow the audit chain per request", async () => {
    const { h } = await world();
    const before = h.service.audit.entries().length;
    for (let i = 0; i < 40; i += 1) await h.call({ op: "approve" });
    assert.ok(h.service.audit.entries().length <= before + 1);
    const health = (await h.call({ op: "health" })).health;
    assert.match(health.auditChain.head, /^sha256:/);
  });
});

describe("audit", () => {
  test("the hash chain detects a removed or edited entry", async () => {
    const { a, h } = await world();
    stage(a.dir, "au.txt", "au\n");
    const s = await h.call(commitRequest(a.dir));
    await h.decide(s.requestId);
    await h.call({ op: "execute", requestId: s.requestId });
    const file = h.service.audit.file;
    assert.equal(h.service.audit.verify().ok, true);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length >= 4);
    writeFileSync(file, `${lines.filter((_, i) => i !== 1).join("\n")}\n`);
    assert.equal(h.service.audit.verify().ok, false);
    writeFileSync(file, `${lines.join("\n")}\n`);
    assert.equal(h.service.audit.verify().ok, true);
    const edited = lines.map((l, i) => (i === 2 ? l.replace('"event":"', '"event":"x') : l));
    writeFileSync(file, `${edited.join("\n")}\n`);
    assert.equal(h.service.audit.verify().ok, false);
  });
});

const statModeOf = (path) => statSync(path).mode & 0o777;
