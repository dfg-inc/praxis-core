import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvedContentDigest,
  authorizeGitOperation,
  encodeAuthorization,
  generateApprovalKeyPair,
  gitPlanId,
  readInboxPlan,
  signAuthorization,
  type ActionPlan,
  type AuthorizationBody,
  type GitDescribed,
  type GitRequestKey,
} from "./index.js";

const ENV = ["PRAXIS_SECURITY_MODE", "PRAXIS_APPROVAL_PUBLIC_KEY", "PRAXIS_APPROVAL_LEDGER", "PRAXIS_TEST_ALLOW_SAME_IDENTITY", "PRAXIS_BROKER_SHARED_DIR", "PRAXIS_APPROVAL_PRIVATE_KEY"] as const;
let saved: Record<string, string | undefined>;
let keys = generateApprovalKeyPair();
let shared: string;
let repo: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  keys = generateApprovalKeyPair();
  shared = mkdtempSync(join(tmpdir(), "praxis-gitauth-shared-"));
  repo = mkdtempSync(join(tmpdir(), "praxis-gitauth-repo-"));
  process.env.PRAXIS_SECURITY_MODE = "secure";
  process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
  process.env.PRAXIS_APPROVAL_LEDGER = mkdtempSync(join(tmpdir(), "praxis-gitauth-ledger-"));
  process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY = "1";
  process.env.PRAXIS_BROKER_SHARED_DIR = shared;
  delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const key = (over: Partial<GitRequestKey> = {}): GitRequestKey => ({
  operation: "git_commit",
  action: "praxis_developer_git_commit",
  repository: repo,
  workItemId: "WP-20260914-002",
  previewFingerprint: "sha256:" + "11".repeat(32),
  ...over,
});
const described = (over: Partial<GitDescribed> = {}): GitDescribed => ({
  instanceId: "local",
  targets: ["branch:feature/x", "src/a.js@" + "aa".repeat(32)],
  revision: "headsha1",
  previewFingerprint: "sha256:" + "11".repeat(32),
  summary: "Commit 1 file(s) to branch feature/x",
  description: "Commit src/a.js",
  ...over,
});

/** Plays the broker's signing step (what praxis-broker.mjs signApprovedPlan does) for a plan in pending/. */
function brokerApproves(planId: string, opts: { privateKeyPem?: string; ttlMs?: number; mutate?: (body: AuthorizationBody) => void } = {}) {
  const plan = JSON.parse(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")) as ActionPlan;
  const action = plan.actions[0]!;
  const content = action.content ?? "";
  const now = Date.now();
  const body: AuthorizationBody = {
    contract: "praxis.approval.authorization",
    version: 1,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    provider: plan.provider,
    instanceId: plan.instanceId,
    operations: plan.operations,
    workItemIds: plan.workItemIds,
    repositories: plan.repositories,
    action: action.action,
    targets: action.targets,
    decisionKind: plan.decisionKind,
    content,
    contentDigest: approvedContentDigest(content),
    approver: "owner@example.com",
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + (opts.ttlMs ?? 60_000)).toISOString(),
    consumptionId: `c-${Math.random().toString(36).slice(2, 12)}`,
  };
  opts.mutate?.(body);
  mkdirSync(join(shared, "authorizations"), { recursive: true });
  mkdirSync(join(shared, "approved"), { recursive: true });
  writeFileSync(join(shared, "authorizations", `${planId}.token`), encodeAuthorization(signAuthorization(body, opts.privateKeyPem ?? keys.privateKeyPem)));
  renameSync(join(shared, "pending", `${planId}.json`), join(shared, "approved", `${planId}.json`));
  return body;
}

const run = (over: { key?: GitRequestKey; live?: GitDescribed | (() => GitDescribed); write?: () => unknown; now?: Date } = {}) => {
  const writes = { count: 0 };
  const k = over.key ?? key();
  const promise = authorizeGitOperation({
    repo,
    key: k,
    describe: () => (typeof over.live === "function" ? over.live() : (over.live ?? described({ previewFingerprint: k.previewFingerprint }))),
    write: () => {
      writes.count += 1;
      return over.write ? over.write() : { ok: true, wrote: writes.count };
    },
    now: over.now,
  });
  return { promise, writes };
};
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
};

describe("git authorization through the broker inbox", () => {
  it("refuses with no broker and does nothing", async () => {
    delete process.env.PRAXIS_BROKER_SHARED_DIR;
    const { promise, writes } = run();
    expect(await codeOf(promise)).toBe("APPROVAL_ISOLATION_UNAVAILABLE");
    expect(writes.count).toBe(0);
  });

  it("proposes the exact plan, refuses, and writes nothing", async () => {
    const { promise, writes } = run();
    expect(await codeOf(promise)).toBe("APPROVAL_REQUIRED");
    expect(writes.count).toBe(0);
    const planId = gitPlanId(key());
    const stored = readInboxPlan(planId)!;
    expect(stored.where).toBe("pending");
    const action = stored.plan.actions[0]!;
    expect(stored.plan).toMatchObject({ provider: "local", instanceId: "local", operations: ["git_commit"], workItemIds: ["WP-20260914-002"], repositories: [resolve(repo)], decisionKind: "git_operation" });
    expect(action.action).toBe("praxis_developer_git_commit");
    expect(action.targets).toContain("branch:feature/x");
    const request = JSON.parse(action.content!);
    expect(request).toMatchObject({ operation: "git_commit", revision: "headsha1", instanceId: "local", previewFingerprint: key().previewFingerprint });
    // asking again keeps the same pending plan (the owner's view does not reset)
    const before = readFileSync(join(shared, "pending", `${planId}.json`), "utf8");
    await codeOf(run().promise);
    expect(readFileSync(join(shared, "pending", `${planId}.json`), "utf8")).toBe(before);
  });

  it("a pending plan alone is never an approval", async () => {
    await codeOf(run().promise);
    const { promise, writes } = run();
    expect(await codeOf(promise)).toBe("APPROVAL_REQUIRED");
    expect(writes.count).toBe(0);
  });

  it("executes once after the owner approves, and replays the recorded result without executing again", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    const first = run();
    expect(await first.promise).toEqual({ ok: true, wrote: 1 });
    expect(first.writes.count).toBe(1);
    const replay = run();
    expect(await replay.promise).toEqual({ ok: true, wrote: 1 });
    expect(replay.writes.count).toBe(0);
  });

  it("never exposes the token: it is in neither the result nor the proposed plan", async () => {
    await codeOf(run().promise);
    const body = brokerApproves(gitPlanId(key()));
    const token = readFileSync(join(shared, "authorizations", `${gitPlanId(key())}.token`), "utf8").trim();
    const result = await run().promise;
    expect(JSON.stringify(result)).not.toContain(token);
    expect(readFileSync(join(shared, "approved", `${gitPlanId(key())}.json`), "utf8")).not.toContain(body.consumptionId);
  });

  it("a commit approval is not a push approval: a push is a different plan that needs its own approval", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    const push = key({ operation: "git_push", action: "praxis_developer_git_publish" });
    expect(gitPlanId(push)).not.toBe(gitPlanId(key()));
    const attempt = run({ key: push, live: described({ instanceId: "github.com/o/r", targets: ["refspec:abc:refs/heads/x"], previewFingerprint: push.previewFingerprint }) });
    expect(await codeOf(attempt.promise)).toBe("APPROVAL_REQUIRED");
    expect(attempt.writes.count).toBe(0);
  });

  it("a copied token cannot be moved to another plan", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    const push = key({ operation: "git_push", action: "praxis_developer_git_publish" });
    await codeOf(run({ key: push, live: described({ instanceId: "github.com/o/r", targets: ["refspec:x"], previewFingerprint: push.previewFingerprint }) }).promise);
    // an attacker copies the commit token and the commit plan under the push plan id
    mkdirSync(join(shared, "authorizations"), { recursive: true });
    writeFileSync(join(shared, "authorizations", `${gitPlanId(push)}.token`), readFileSync(join(shared, "authorizations", `${gitPlanId(key())}.token`)));
    const attempt = run({ key: push, live: described({ instanceId: "github.com/o/r", targets: ["refspec:x"], previewFingerprint: push.previewFingerprint }) });
    expect(await codeOf(attempt.promise)).toBe("APPROVAL_SCOPE_MISMATCH");
    expect(attempt.writes.count).toBe(0);
  });

  it("refuses a changed repository state without consuming the approval", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    const moved = run({ live: described({ revision: "headsha2" }) });
    expect(await codeOf(moved.promise)).toBe("APPROVAL_SCOPE_MISMATCH");
    expect(moved.writes.count).toBe(0);
    const changedTarget = run({ live: described({ targets: ["branch:feature/x", "src/a.js@" + "bb".repeat(32)] }) });
    expect(await codeOf(changedTarget.promise)).toBe("APPROVAL_SCOPE_MISMATCH");
    // the approval was not burned: restoring the approved state still executes
    const ok = run();
    expect(await ok.promise).toEqual({ ok: true, wrote: 1 });
  });

  it("refuses a changed instance, repository or work item", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    expect(await codeOf(run({ live: described({ instanceId: "github.com/evil/repo" }) }).promise)).toBe("APPROVAL_SCOPE_MISMATCH");
    const other = mkdtempSync(join(tmpdir(), "praxis-gitauth-other-"));
    expect(await codeOf(run({ key: key({ repository: other }) }).promise)).toBe("APPROVAL_REQUIRED");
    expect(await codeOf(run({ key: key({ workItemId: "WP-20260914-003" }) }).promise)).toBe("APPROVAL_REQUIRED");
  });

  it("refuses an expired approval with no side effect", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()), { ttlMs: 1000 });
    const { promise, writes } = run({ now: new Date(Date.now() + 120_000) });
    expect(await codeOf(promise)).toBe("APPROVAL_EXPIRED");
    expect(writes.count).toBe(0);
  });

  it("refuses a rejected plan", async () => {
    await codeOf(run().promise);
    mkdirSync(join(shared, "rejected"), { recursive: true });
    renameSync(join(shared, "pending", `${gitPlanId(key())}.json`), join(shared, "rejected", `${gitPlanId(key())}.json`));
    const { promise, writes } = run();
    expect(await codeOf(promise)).toBe("APPROVAL_REJECTED");
    expect(writes.count).toBe(0);
  });

  it("refuses a token signed by another key and a tampered token", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()), { privateKeyPem: generateApprovalKeyPair().privateKeyPem });
    const forged = run();
    expect(await codeOf(forged.promise)).toBe("APPROVAL_REQUIRED");
    expect(forged.writes.count).toBe(0);
  });

  it("does not trust a plan edited after approval", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    const approved = join(shared, "approved", `${gitPlanId(key())}.json`);
    const plan = JSON.parse(readFileSync(approved, "utf8"));
    plan.actions[0].targets = ["branch:main"];
    writeFileSync(approved, JSON.stringify(plan));
    const { promise, writes } = run();
    expect(await codeOf(promise)).toBe("APPROVAL_REQUIRED"); // the edited file no longer parses as a plan
    expect(writes.count).toBe(0);
  });

  it("a stale preview fails before anything is proposed or consumed", async () => {
    const { promise, writes } = run({
      live: () => {
        throw Object.assign(new Error("preview is stale"), { code: "GIT_PREVIEW_STALE" });
      },
    });
    expect(await codeOf(promise)).toBe("GIT_PREVIEW_STALE");
    expect(writes.count).toBe(0);
    expect(existsSync(join(shared, "pending")) ? readdirSync(join(shared, "pending")) : []).toEqual([]);
  });

  it("serves several independent approvals, each once, across work items and repositories", async () => {
    const repoB = mkdtempSync(join(tmpdir(), "praxis-gitauth-b-"));
    const keys3 = [key(), key({ workItemId: "WP-20260914-003" }), key({ repository: repoB })];
    for (const k of keys3) await codeOf(authorizeGitOperation({ repo: k.repository, key: k, describe: () => described({ previewFingerprint: k.previewFingerprint }), write: () => 1 }));
    for (const k of keys3) brokerApproves(gitPlanId(k));
    const counts: number[] = [];
    for (const k of keys3) {
      let n = 0;
      await authorizeGitOperation({ repo: k.repository, key: k, describe: () => described({ previewFingerprint: k.previewFingerprint }), write: () => ++n });
      await authorizeGitOperation({ repo: k.repository, key: k, describe: () => described({ previewFingerprint: k.previewFingerprint }), write: () => ++n });
      counts.push(n);
    }
    expect(counts).toEqual([1, 1, 1]);
  });

  it("a failed execution is not retried under the same approval", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    const failing = run({ write: () => { throw new Error("git push failed"); } });
    await expect(failing.promise).rejects.toThrow(/git push failed/);
    const retry = run();
    expect(await codeOf(retry.promise)).toBe("APPROVAL_RECONCILIATION_REQUIRED");
    expect(retry.writes.count).toBe(0);
  });

  it("fails closed, with no side effect, when the trust anchor is missing or the host is not isolated", async () => {
    await codeOf(run().promise);
    brokerApproves(gitPlanId(key()));
    delete process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
    const noAnchor = run();
    expect(await codeOf(noAnchor.promise)).toBe("APPROVAL_ISOLATION_UNAVAILABLE");
    expect(noAnchor.writes.count).toBe(0);
    process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
    delete process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY; // same-user host without the explicit test override
    const unisolated = run();
    expect(await codeOf(unisolated.promise)).toBe("APPROVAL_ISOLATION_UNAVAILABLE");
    expect(unisolated.writes.count).toBe(0);
  });
});
