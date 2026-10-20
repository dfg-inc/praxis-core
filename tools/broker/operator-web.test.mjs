import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOperatorWeb, writeTokenOnce } from "./operator-web.mjs";
import { b64u } from "./webauthn.mjs";
import { createSoftwareAuthenticator } from "./test-authenticator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const contracts = require(join(here, "../../packages/contracts/dist/index.js"));
const {
  ActionPlanSchema, buildActionPlan, renderActionPlanForHuman, generateApprovalKeyPair, verifyAuthorization,
  encodeAuthorization, signAuthorization, approvedContentDigest,
} = contracts;

const servers = [];
after(() => servers.forEach((close) => close()));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function makePlan(over = {}) {
  return buildActionPlan({
    planId: over.planId ?? "plan-1",
    role: "developer",
    decisionKind: over.decisionKind ?? "development_action",
    summary: over.summary ?? "Write the approved file",
    provider: "local",
    instanceId: "local",
    operations: over.operations ?? ["repository_edit"],
    workItemIds: ["WI-1"],
    repositories: ["/repo"],
    actions: [{ action: "praxis_workflow_apply", description: "write", targets: over.targets ?? ["a.txt"], content: over.content ?? "approved content\n" }],
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/** In-process broker pieces: the real web server with a signer that mirrors the broker's, and an injectable clock. */
async function harness({ enroll = true, clock } = {}) {
  const root = mkdtempSync(join(tmpdir(), "praxis-web-"));
  const trusted = join(root, "trusted");
  const shared = join(root, "shared");
  mkdirSync(join(shared, "pending"), { recursive: true });
  mkdirSync(trusted, { recursive: true });
  const keys = generateApprovalKeyPair();
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const signed = [];
  const rejected = [];
  const secret = enroll ? "enroll-secret-123" : undefined;
  const web = createOperatorWeb({
    origin,
    trustedDir: trusted,
    sharedDir: shared,
    contracts: { ActionPlanSchema, renderActionPlanForHuman },
    signApproved(plan, approver, channel) {
      const action = plan.actions[0];
      const body = {
        contract: "praxis.approval.authorization", version: 1, planId: plan.planId, planFingerprint: plan.fingerprint, provider: plan.provider,
        instanceId: plan.instanceId, operations: plan.operations, workItemIds: plan.workItemIds, repositories: plan.repositories, action: action.action,
        targets: action.targets, decisionKind: plan.decisionKind, content: action.content ?? "", contentDigest: approvedContentDigest(action.content ?? ""),
        approver, issuedAt: new Date().toISOString(), expiresAt: plan.expiresAt, consumptionId: `c-${signed.length + 1}`,
      };
      const token = encodeAuthorization(signAuthorization(body, keys.privateKeyPem));
      writeTokenOnce(join(shared, "authorizations", `${plan.planId}.token`), token);
      signed.push({ planId: plan.planId, approver, channel });
      return { consumptionId: body.consumptionId };
    },
    rejectPlan: (plan, approver, channel) => rejected.push({ planId: plan.planId, approver, channel }),
    enrollSecret: secret,
    now: clock,
  });
  await new Promise((resolve) => web.server.listen(port, "127.0.0.1", resolve));
  servers.push(() => web.server.close());
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const device = createSoftwareAuthenticator({ rpId: "localhost", origin });
  const enrollDevice = async (dev = device, label = "alice") => {
    const c = await call("/api/enroll/challenge", { secret, label });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const reg = dev.register({ challenge: c.json.publicKey.challenge });
    return call("/api/enroll/finish", { secret, challengeId: c.json.challengeId, credential: { id: reg.id, response: { clientDataJSON: reg.clientDataJSON, attestationObject: reg.attestationObject } } });
  };
  const writePlan = (plan) => writeFileSync(join(shared, "pending", `${plan.planId}.json`), JSON.stringify(plan));
  const decide = async (plan, decision, dev = device) => {
    const c = await call("/api/challenge", { planId: plan.planId, decision });
    if (c.status !== 200) return { challenge: c };
    const a = dev.assert({ challenge: c.json.publicKey.challenge });
    return {
      challenge: c,
      body: { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } },
      result: await call("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } }),
    };
  };
  const tokenPath = (plan) => join(shared, "authorizations", `${plan.planId}.token`);
  return { root, trusted, shared, keys, origin, port, web, signed, rejected, call, device, enrollDevice, writePlan, decide, tokenPath, secret };
}

describe("enrollment", () => {
  test("needs the secret shown on the broker terminal, enrolls one authenticator, then closes", async () => {
    const h = await harness();
    const wrong = await h.call("/api/enroll/challenge", { secret: "guess", label: "mallory" });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, "ENROLLMENT_SECRET");
    const first = await h.enrollDevice();
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.enrollmentClosed, true);
    // Closed: the same secret enrolls nothing more, so a later caller cannot add an authenticator.
    const again = await h.call("/api/enroll/challenge", { secret: h.secret, label: "eve" });
    assert.equal(again.status, 403);
    assert.equal(again.json.code, "ENROLLMENT_CLOSED");
    const doc = JSON.parse(readFileSync(join(h.trusted, "operators.json"), "utf8"));
    assert.equal(doc.credentials.length, 1);
    assert.deepEqual(doc.credentials[0].publicKeyJwk, h.device.publicKeyJwk);
    assert.equal(statSync(join(h.trusted, "operators.json")).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(doc).includes("PRIVATE"));
  });

  test("with enrollment never opened, no authenticator can be added at all", async () => {
    const h = await harness({ enroll: false });
    const c = await h.call("/api/enroll/challenge", { secret: "anything", label: "x" });
    assert.equal(c.status, 403);
    assert.equal(c.json.code, "ENROLLMENT_CLOSED");
    const plan = makePlan();
    h.writePlan(plan);
    const d = await h.call("/api/challenge", { planId: plan.planId, decision: "approve" });
    assert.equal(d.status, 409);
    assert.equal(d.json.code, "NO_OPERATOR");
  });
});

describe("approving a plan", () => {
  test("a user-verified signature from the enrolled authenticator yields a token bound to exactly that plan", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan({ decisionKind: "story_behavior", summary: "Confirm US-CFG-001 revision 1" });
    h.writePlan(plan);
    const { result } = await h.decide(plan, "approve");
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.state, "approved");
    assert.match(result.json.channel, /^webauthn:/);
    const token = readFileSync(h.tokenPath(plan), "utf8");
    const body = verifyAuthorization(token, h.keys.publicKeyPem);
    assert.equal(body.planId, plan.planId);
    assert.equal(body.planFingerprint, plan.fingerprint);
    assert.equal(body.decisionKind, "story_behavior");
    assert.deepEqual(body.targets, ["a.txt"]);
    assert.equal(body.contentDigest, approvedContentDigest("approved content\n"));
    assert.equal(body.approver, "operator:alice");
  });

  test("regression: an agent that can call every endpoint but holds a different key cannot approve", async () => {
    // The point of the channel: HTTP access is not authority. The agent signs with its own software key.
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan();
    h.writePlan(plan);
    const attacker = createSoftwareAuthenticator({ rpId: "localhost", origin: h.origin });
    const unknown = await h.decide(plan, "approve", attacker);
    assert.equal(unknown.result.status, 403);
    assert.equal(unknown.result.json.code, "UNKNOWN_CREDENTIAL");
    // Same credential id but a different private key (a cloned id with a forged key).
    h.device.rekey();
    const forged = await h.decide(plan, "approve", h.device);
    assert.equal(forged.result.status, 403);
    assert.equal(forged.result.json.code, "WEBAUTHN_SIGNATURE");
    assert.equal(existsSync(h.tokenPath(plan)), false);
    assert.deepEqual(h.signed, []);
  });

  test("a gesture without user verification is refused", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan();
    h.writePlan(plan);
    const c = await h.call("/api/challenge", { planId: plan.planId, decision: "approve" });
    const a = h.device.assert({ challenge: c.json.publicKey.challenge, flags: 0x01 });
    const r = await h.call("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "WEBAUTHN_VERIFICATION");
    assert.equal(existsSync(h.tokenPath(plan)), false);
  });

  test("regression: a plan edited after the human was shown it is not approved", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan({ summary: "Harmless change" });
    h.writePlan(plan);
    const c = await h.call("/api/challenge", { planId: plan.planId, decision: "approve" });
    // The agent swaps the file for a different, internally consistent plan with the same id.
    h.writePlan(makePlan({ summary: "Something much worse", targets: ["/etc/hosts"] }));
    const a = h.device.assert({ challenge: c.json.publicKey.challenge });
    const r = await h.call("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "PLAN_CHANGED");
    assert.equal(existsSync(h.tokenPath(plan)), false);
  });

  test("a plan whose fingerprint does not match its content is not even offered for approval", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan();
    const forged = { ...plan, summary: "Edited after fingerprinting" };
    h.writePlan(forged);
    const c = await h.call("/api/challenge", { planId: plan.planId, decision: "approve" });
    assert.equal(c.status, 422);
    assert.equal(c.json.code, "PLAN_INVALID");
    assert.match(c.json.error, /fingerprint does not match/);
  });

  test("a decision cannot be replayed, and a signature for reject cannot be used to approve", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan();
    h.writePlan(plan);
    const first = await h.decide(plan, "approve");
    assert.equal(first.result.status, 200);
    const replay = await h.call("/api/decide", first.body);
    assert.equal(replay.status, 409);
    assert.equal(replay.json.code, "CHALLENGE_UNKNOWN");

    const other = makePlan({ planId: "plan-2" });
    h.writePlan(other);
    const approve = await h.call("/api/challenge", { planId: other.planId, decision: "approve" });
    const reject = await h.call("/api/challenge", { planId: other.planId, decision: "reject" });
    const signedReject = h.device.assert({ challenge: reject.json.publicKey.challenge });
    const swapped = await h.call("/api/decide", { challengeId: approve.json.challengeId, credential: { id: signedReject.id, response: { clientDataJSON: signedReject.clientDataJSON, authenticatorData: signedReject.authenticatorData, signature: signedReject.signature } } });
    assert.equal(swapped.status, 403);
    assert.equal(swapped.json.code, "WEBAUTHN_CHALLENGE");
    assert.equal(existsSync(h.tokenPath(other)), false);
  });

  test("a plan is approved at most once: a second approval is refused, and a race creates one token", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan();
    h.writePlan(plan);
    assert.equal((await h.decide(plan, "approve")).result.status, 200);
    // The agent re-proposes the very same plan id and a human is asked again (or tricked into a second tap).
    h.writePlan(plan);
    const again = await h.decide(plan, "approve");
    assert.equal(again.result.status, 409);
    assert.equal(again.result.json.code, "ALREADY_APPROVED");
    assert.equal(h.signed.length, 1);
    assert.equal(readdirSync(join(h.shared, "authorizations")).length, 1);
    const path = join(h.root, "race.token");
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, async () => writeTokenOnce(path, `t-${Math.random()}`)));
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.ok(outcomes.filter((o) => o.status === "rejected").every((o) => o.reason.code === "ALREADY_APPROVED"));
  });

  test("a rejection takes a verified gesture too, and creates no token", async () => {
    const h = await harness();
    await h.enrollDevice();
    const plan = makePlan();
    h.writePlan(plan);
    const { result } = await h.decide(plan, "reject");
    assert.equal(result.status, 200);
    assert.equal(result.json.state, "rejected");
    assert.deepEqual(h.rejected.map((r) => r.planId), [plan.planId]);
    assert.equal(existsSync(h.tokenPath(plan)), false);
  });

  test("expired plans and expired challenges are refused", async () => {
    let now = Date.now();
    const h = await harness({ clock: () => now });
    await h.enrollDevice();
    const soon = makePlan({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    h.writePlan(soon);
    const c = await h.call("/api/challenge", { planId: soon.planId, decision: "approve" });
    now += 121_000; // past the 2 minute challenge life (and past the plan's expiry)
    const a = h.device.assert({ challenge: c.json.publicKey.challenge });
    const late = await h.call("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
    assert.equal(late.status, 410);
    const expired = await h.call("/api/challenge", { planId: soon.planId, decision: "approve" });
    assert.equal(expired.status, 410);
    assert.equal(expired.json.code, "PLAN_EXPIRED");
  });
});

describe("the page and the HTTP surface", () => {
  test("shows the exact plan, escapes everything, and states what this approval does not authorize", async () => {
    const h = await harness();
    const hostile = makePlan({ summary: '<script>alert("x")</script> & "quotes"', content: "<img src=x onerror=alert(1)>\n" });
    h.writePlan(hostile);
    const html = await (await fetch(`${h.origin}/plan/${hostile.planId}`)).text();
    assert.ok(!html.includes("<script>alert"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
    assert.ok(html.includes("Implementation authorization"));
    assert.match(html, /This approves only: Implementation authorization/);
    assert.ok(html.includes(hostile.fingerprint));
    const response = await fetch(`${h.origin}/plan/${hostile.planId}`);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  test("each kind of decision is labelled as itself: a push is a push, not an implementation", async () => {
    const h = await harness();
    const push = makePlan({ planId: "p-push", decisionKind: "git_operation", operations: ["git_push"] });
    const commit = makePlan({ planId: "p-commit", decisionKind: "git_operation", operations: ["git_commit"] });
    const story = makePlan({ planId: "p-story", decisionKind: "story_behavior" });
    for (const p of [push, commit, story]) h.writePlan(p);
    const text = (id) => fetch(`${h.origin}/plan/${id}`).then((r) => r.text());
    assert.match(await text("p-push"), /This approves only: Git push/);
    assert.match(await text("p-commit"), /This approves only: Git commit/);
    assert.match(await text("p-story"), /This approves only: Story behavior confirmation/);
    assert.ok(!(await text("p-push")).includes("This approves only: Git commit"));
  });

  test("refuses foreign hosts, foreign origins, wrong content types, and path tricks", async () => {
    const h = await harness();
    const rebind = await new Promise((resolve) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: h.port, path: "/", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode));
        req.end();
      });
    });
    assert.equal(rebind, 403);
    const foreign = await h.call("/api/challenge", { planId: "x", decision: "approve" }, { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    const wrongType = await fetch(`${h.origin}/api/challenge`, { method: "POST", headers: { origin: h.origin, "content-type": "text/plain" }, body: "{}" });
    assert.equal(wrongType.status, 415);
    const trick = await fetch(`${h.origin}/plan/..%2F..%2Fetc%2Fpasswd`);
    assert.ok([400, 404].includes(trick.status));
    assert.equal((await fetch(`${h.origin}/nope`)).status, 404);
  });
});

describe("the real broker process", () => {
  test("serve-operator-web enrolls a device, approves a plan, and signs a token bound to it", async () => {
    const root = mkdtempSync(join(tmpdir(), "praxis-broker-web-"));
    const trusted = join(root, "trusted");
    const shared = join(root, "shared");
    mkdirSync(trusted, { recursive: true });
    mkdirSync(join(shared, "pending"), { recursive: true });
    const keys = generateApprovalKeyPair();
    writeFileSync(join(trusted, "private.pem"), keys.privateKeyPem, { mode: 0o600 });
    writeFileSync(join(trusted, ".broker-identity"), "test");
    chmodSync(trusted, 0o700);
    const port = await freePort();
    const child = spawn(process.execPath, [join(here, "praxis-broker.mjs"), "serve-operator-web", "--port", String(port), "--enroll"], {
      env: {
        PATH: process.env.PATH,
        PRAXIS_BROKER_TRUSTED_DIR: trusted,
        PRAXIS_BROKER_SHARED_DIR: shared,
        PRAXIS_APPROVAL_PRIVATE_KEY_PATH: join(trusted, "private.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    servers.push(() => child.kill());
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    for (let i = 0; i < 100 && !/ENROLLMENT SECRET/.test(out); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /ENROLLMENT SECRET/, `broker did not start: ${err}`);
    const secret = /: ([0-9a-f]{32})/.exec(out)[1];
    const origin = `http://localhost:${port}`;
    const call = async (path, body) => {
      const r = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    const device = createSoftwareAuthenticator({ rpId: "localhost", origin });
    const ec = await call("/api/enroll/challenge", { secret, label: "bob" });
    const reg = device.register({ challenge: ec.json.publicKey.challenge });
    assert.equal((await call("/api/enroll/finish", { secret, challengeId: ec.json.challengeId, credential: { id: reg.id, response: { clientDataJSON: reg.clientDataJSON, attestationObject: reg.attestationObject } } })).status, 200);

    const plan = makePlan({ planId: "real-1", decisionKind: "git_operation", operations: ["git_commit"], summary: "Commit the reviewed change" });
    writeFileSync(join(shared, "pending", "real-1.json"), JSON.stringify(plan));
    const c = await call("/api/challenge", { planId: "real-1", decision: "approve" });
    const a = device.assert({ challenge: c.json.publicKey.challenge });
    const r = await call("/api/decide", { challengeId: c.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const token = readFileSync(join(shared, "authorizations", "real-1.token"), "utf8");
    const body = verifyAuthorization(token, keys.publicKeyPem);
    assert.equal(body.decisionKind, "git_operation");
    assert.deepEqual(body.operations, ["git_commit"]);
    assert.equal(body.planFingerprint, plan.fingerprint);
    assert.ok(existsSync(join(shared, "approved", "real-1.json")));
    assert.ok(!existsSync(join(shared, "pending", "real-1.json")));
    const audit = JSON.parse(readFileSync(join(trusted, "audit", "real-1.json"), "utf8"));
    assert.match(audit.channel, /^webauthn:/);
    assert.equal(audit.approver, "operator:bob");
    assert.deepEqual(readdirSync(join(shared, "authorizations")), ["real-1.token"]);
    // The enrollment secret is never written to disk or to the page.
    assert.ok(!readFileSync(join(trusted, "operators.json"), "utf8").includes(secret));
    assert.ok(!(await (await fetch(`${origin}/enroll`)).text()).includes(secret));
  });
});
