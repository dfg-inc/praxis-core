/**
 * Executable Quality checks for the Native Approval Service work item (WI-NATIVE-CROSS-PLATFORM-AP-001).
 * Each exported function RUNS a scenario against the real service (in-process, development mode, real IPC socket, real Git,
 * real WebAuthn verification with a software authenticator) and returns a small JSON value that the check compares with its
 * expectation. These are SERVICE-INTEGRATION checks: they say nothing about OS-level isolation (one OS user here) and nothing
 * about a person's approval. Those scenarios are declared at level "e2e" in checks.json so Quality reports them BLOCKED.
 */
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, stage, startService } from "../test-harness.mjs";

async function world(extra = {}) {
  const root = mkdtempSync("/tmp/pas-q-");
  const a = makeRepo(root, "repo");
  const h = await startService({ root, repos: [{ path: a.dir, remotes: { origin: a.remote }, branches: ["*"], provider: { kind: "fixture", instanceId: "fixture/demo" } }], providersConfig: { fixture: { instances: { "fixture/demo": { actions: ["create_merge_request"] } } } }, ...extra });
  await h.enroll();
  const done = async () => {
    await h.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, a, h, done };
}
const commitMsg = (dir, extra = {}) => ({ op: "submit", operation: "git_commit", repository: dir, workItemId: "WI-Q", params: { message: "quality", paths: ["f.txt"] }, ...extra });
const head = (dir) => git(dir, "rev-parse", "HEAD");

export async function approvedCommit() {
  const { a, h, done } = await world();
  try {
    git(a.dir, "checkout", "-q", "-b", "feature/q");
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const before = head(a.dir);
    const s = await h.call(commitMsg(a.dir));
    const early = await h.call({ op: "execute", requestId: s.requestId });
    await h.decide(s.requestId);
    const run = await h.call({ op: "execute", requestId: s.requestId });
    return { proposed: s.state, refusedBeforeApproval: early.code, executed: run.state, newCommits: Number(git(a.dir, "rev-list", "--count", `${before}..HEAD`)), author: git(a.dir, "log", "-1", "--format=%an"), files: git(a.dir, "show", "--name-only", "--format=", "HEAD").split("\n") };
  } finally {
    await done();
  }
}

export async function rejectedCommit() {
  const { a, h, done } = await world();
  try {
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const before = head(a.dir);
    const s = await h.call(commitMsg(a.dir));
    await h.decide(s.requestId, "reject");
    const run = await h.call({ op: "execute", requestId: s.requestId });
    return { status: (await h.call({ op: "status", requestId: s.requestId })).state, execute: run.code, headMoved: head(a.dir) !== before, untracked: git(a.dir, "status", "--porcelain") };
  } finally {
    await done();
  }
}

/** Commit, push and merge request: each is asked for again after the repository and the remote moved on. */
export async function replayAfterStateMoved() {
  const { a, h, done } = await world();
  try {
    git(a.dir, "checkout", "-q", "-b", "feature/q");
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const run = async (msg) => {
      const s = await h.call(msg);
      await h.decide(s.requestId);
      return h.call({ op: "execute", requestId: s.requestId });
    };
    const commit = commitMsg(a.dir, { executionId: "q-commit" });
    const c = await run(commit);
    const push = { op: "submit", operation: "git_push", repository: a.dir, workItemId: "WI-Q", params: { remote: "origin", branch: "feature/q" }, executionId: "q-push" };
    const p = await run(push);
    const mr = { op: "submit", operation: "merge_request", repository: a.dir, workItemId: "WI-Q", params: { remote: "origin", sourceBranch: "feature/q", targetBranch: "main", title: "T" }, executionId: "q-mr" };
    const m = await run(mr);
    git(a.dir, "commit", "-q", "--allow-empty", "-m", "moves HEAD");
    git(a.dir, "push", "-q", a.remote, "HEAD:refs/heads/feature/q");
    const headNow = head(a.dir);
    const remoteNow = git(a.remote, "rev-parse", "refs/heads/feature/q");
    const [c2, p2, m2] = [await h.call(commit), await h.call(push), await h.call(mr)];
    return {
      commit: { state: c2.state, sameResult: c2.result.commit === c.result.commit },
      push: { state: p2.state, sameResult: p2.result.pushed === p.result.pushed },
      mergeRequest: { state: m2.state, sameResult: m2.result.url === m.result.url, requestsCreated: readdirSync(join(h.stateDir, "providers")).filter((f) => f.startsWith("mr-")).length },
      nothingRanAgain: head(a.dir) === headNow && git(a.remote, "rev-parse", "refs/heads/feature/q") === remoteNow,
    };
  } finally {
    await done();
  }
}

export async function changedPlanRefused() {
  const { a, h, done } = await world();
  try {
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const first = await h.call(commitMsg(a.dir, { executionId: "q-same" }));
    const otherMessage = await h.call({ ...commitMsg(a.dir, { executionId: "q-same" }), params: { message: "different", paths: ["f.txt"] } });
    const otherPath = await h.call({ ...commitMsg(a.dir, { executionId: "q-same" }), params: { message: "quality", paths: ["g.txt"] } });
    // approved for one content, then the file changes: the approval does not cover the new content
    await h.decide(first.requestId);
    writeFileSync(join(a.dir, "f.txt"), "CHANGED AFTER APPROVAL\n");
    const run = await h.call({ op: "execute", requestId: first.requestId });
    return { sameIdDifferentMessage: otherMessage.code, sameIdDifferentPath: otherPath.code, changedAfterApproval: run.code, headMoved: head(a.dir) !== git(a.dir, "rev-list", "--max-parents=0", "HEAD") };
  } finally {
    await done();
  }
}

export async function agentCannotApproveOrForge() {
  const { a, h, done } = await world();
  try {
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const s = await h.call(commitMsg(a.dir));
    const ops = {};
    for (const op of ["approve", "reject", "sign", "enroll", "set-config", "exec"]) ops[op] = (await h.call({ op, requestId: s.requestId })).code;
    const { generateApprovalKeyPair, signAuthorization, encodeAuthorization, approvedContentDigest } = await import("../../../packages/contracts/dist/index.js");
    const plan = JSON.parse(readFileSync(h.planFile(s.requestId), "utf8"));
    const action = plan.actions[0];
    const forge = (pem, channel) =>
      encodeAuthorization(signAuthorization({ contract: "praxis.approval.authorization", version: 1, planId: plan.planId, planFingerprint: plan.fingerprint, provider: plan.provider, instanceId: plan.instanceId, operations: plan.operations, workItemIds: plan.workItemIds, repositories: plan.repositories, action: action.action, targets: action.targets, decisionKind: plan.decisionKind, channel, content: action.content, contentDigest: approvedContentDigest(action.content), approver: "agent", issuedAt: new Date().toISOString(), expiresAt: plan.expiresAt, consumptionId: `c-${Math.random().toString(16).slice(2, 12)}` }, pem));
    writeFileSync(h.planFile(s.requestId, "approved"), JSON.stringify(plan));
    const slot = join(h.stateDir, "shared", "authorizations", `${s.requestId}.token`);
    const before = head(a.dir);
    const outcomes = {};
    for (const [name, token] of [["otherKey", forge(generateApprovalKeyPair().privateKeyPem, "webauthn:x")], ["machineChannel", forge(readFileSync(join(h.stateDir, "trusted", "private.pem"), "utf8"), "machine")]]) {
      writeFileSync(slot, token);
      outcomes[name] = (await h.call({ op: "execute", requestId: s.requestId })).ok;
      rmSync(slot);
    }
    return { unknownOperations: ops, forged: outcomes, headMoved: head(a.dir) !== before };
  } finally {
    await done();
  }
}

export async function secretsAndArtifactsStayOut() {
  const { a, h, done } = await world();
  try {
    git(a.dir, "checkout", "-q", "-b", "feature/q");
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const refsBefore = git(a.dir, "for-each-ref", "--format=%(refname)").split("\n").sort();
    const s = await h.call(commitMsg(a.dir));
    await h.decide(s.requestId);
    const replies = [s, await h.call({ op: "execute", requestId: s.requestId }), await h.call({ op: "status", requestId: s.requestId }), await h.call({ op: "health" })];
    const token = readFileSync(join(h.stateDir, "shared", "authorizations", `${s.requestId}.token`), "utf8").trim();
    const text = JSON.stringify(replies) + readFileSync(h.service.audit.file, "utf8");
    const refsAfter = git(a.dir, "for-each-ref", "--format=%(refname)").split("\n").sort();
    return {
      tokenOrKeyInReplyOrLog: text.includes(token.slice(0, 40)) || text.includes("PRIVATE KEY"),
      newRefs: refsAfter.filter((r) => !refsBefore.includes(r)),
      approvalFilesInRepo: git(a.dir, "ls-files").split("\n").filter((f) => /approv|token|ledger|authoriz/i.test(f)).length,
      cleanWorktree: git(a.dir, "status", "--porcelain").replace(/^\?\? .*\n?/gm, "") === "",
    };
  } finally {
    await done();
  }
}

export async function auditAndLedgerIntegrity() {
  const sink = mkdtempSync("/tmp/pas-sink-");
  const { root, a, h, done } = await world({ extraConfig: { auditAnchorDirs: [sink] } });
  const restart = (extra = {}) => startService({ root: mkdtempSync("/tmp/pas-q-"), state: h.stateDir, repos: h.config.repositories, extraConfig: { operator: { port: h.port, origin: h.origin }, auditAnchorDirs: [sink], ...extra } });
  try {
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const s = await h.call(commitMsg(a.dir));
    await h.decide(s.requestId);
    await h.call({ op: "execute", requestId: s.requestId });
    const file = h.service.audit.file;
    await h.close();
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const result = {};
    writeFileSync(file, `${lines.slice(0, -2).join("\n")}\n`);
    result.truncatedTail = await restart().then(() => "started", (e) => e.message.includes("truncated or rolled back") ? "refused" : e.message);
    writeFileSync(file, `${lines.join("\n")}\n`);
    renameSync(join(h.stateDir, "ledger"), join(h.stateDir, "ledger.away"));
    result.ledgerRemoved = await restart().then(() => "started", (e) => (/ledger/.test(e.message) ? "refused" : e.message));
    renameSync(join(h.stateDir, "ledger.away"), join(h.stateDir, "ledger"));
    const back = await restart();
    result.intactStateStarts = (await back.call({ op: "health" })).health.integrity.ok;
    result.replayAfterRestart = (await back.call({ op: "execute", requestId: s.requestId })).replayed;
    await back.close();
    return result;
  } finally {
    await done();
    rmSync(sink, { recursive: true, force: true });
    void root;
  }
}

export async function concurrentRequestsIsolated() {
  const root = mkdtempSync("/tmp/pas-q-");
  const a = makeRepo(root, "a");
  const b = makeRepo(root, "b");
  const h = await startService({ root, repos: [{ path: a.dir, remotes: {}, branches: ["*"] }, { path: b.dir, remotes: {}, branches: ["*"] }] });
  await h.enroll();
  try {
    stage(a.dir, "a.txt", "a\n");
    stage(b.dir, "b.txt", "b\n");
    const [sa, sb] = await Promise.all([h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-A", params: { message: "A" } }), h.call({ op: "submit", operation: "git_commit", repository: b.dir, workItemId: "WI-B", params: { message: "B" } })]);
    await h.decide(sa.requestId);
    await h.decide(sb.requestId);
    const runs = await Promise.all([...Array.from({ length: 4 }, () => h.call({ op: "execute", requestId: sa.requestId })), h.call({ op: "execute", requestId: sb.requestId })]);
    return { allOk: runs.every((r) => r.ok), commitsInA: Number(git(a.dir, "rev-list", "--count", "HEAD")) - 1, commitsInB: Number(git(b.dir, "rev-list", "--count", "HEAD")) - 1, subjects: [git(a.dir, "log", "-1", "--format=%s"), git(b.dir, "log", "-1", "--format=%s")], auditIntact: h.service.audit.verify().ok };
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function failsClosedWhenSecurityDependencyMissing() {
  const { a, h, done } = await world();
  try {
    writeFileSync(join(a.dir, "f.txt"), "f\n");
    const s = await h.call(commitMsg(a.dir));
    await h.decide(s.requestId);
    rmSync(join(h.stateDir, "trusted", "public.pem"));
    const before = head(a.dir);
    const run = await h.call({ op: "execute", requestId: s.requestId });
    return { executeOk: run.ok, headMoved: head(a.dir) !== before };
  } finally {
    await done();
  }
}

export async function productionRefusesUnverifiedIsolation() {
  let started = "started";
  try {
    const w = await startService({ mode: "production", probe: () => [{ id: "state-private", ok: false, detail: "world readable" }] });
    await w.close();
  } catch (error) {
    started = /refusing to start in production/.test(error.message) ? "refused" : error.message;
  }
  return { productionWithFailingProbe: started };
}
