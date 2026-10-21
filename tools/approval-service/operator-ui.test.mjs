/**
 * Review regression tests for the operator page: everything an unauthenticated local client (the agent) can send.
 * Real service, real page, software authenticator (TEST ONLY).
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { git, makeRepo, stage, startService } from "./test-harness.mjs";

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
});

async function world() {
  const root = mkdtempSync("/tmp/pas-");
  const a = makeRepo(root, "repo-a");
  const h = await startService({ root, repos: [{ path: a.dir, remotes: { origin: a.remote }, branches: ["*"] }] });
  await h.enroll();
  cleanups.push(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { a, h };
}

/** Raw HTTP so the Host and Origin headers can be set freely. */
const raw = (h, { method = "GET", path = "/", headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: h.port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>"\'&';

describe("page content the agent controls is inert", () => {
  test("commit message, branch, file names and merge request title cannot inject markup or script", async () => {
    const { a, h } = await world();
    git(a.dir, "checkout", "-q", "-b", "feature/x");
    stage(a.dir, "plain.txt", "p\n");
    const submitted = await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1", params: { message: evil, paths: ["plain.txt"] } });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    for (const path of [`/plan/${submitted.requestId}`, "/"]) {
      const page = await raw(h, { path, headers: { host: `localhost:${h.port}` } });
      assert.equal(page.status, 200);
      assert.ok(!page.text.includes("<img src=x"), `${path}: raw <img> reached the page`);
      assert.ok(!/<script>alert/.test(page.text), `${path}: raw script reached the page`);
      assert.ok(!/onerror=/.test(page.text.replaceAll("&quot;", "")) || page.text.includes("&lt;img"), "event handler must only appear escaped");
      assert.match(page.headers["content-security-policy"], /default-src 'none'/);
      assert.match(page.headers["content-security-policy"], /script-src 'self'/);
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.headers["x-content-type-options"], "nosniff");
      assert.equal(page.headers["cache-control"], "no-store");
    }
    // identifiers and paths that could forge lines or carry markup are refused outright
    assert.equal((await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-<b>1</b>", params: { message: "m", paths: ["plain.txt"] } })).code, "BAD_REQUEST");
    assert.equal((await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1\nRisks:\n  - none", params: { message: "m", paths: ["plain.txt"] } })).code, "BAD_REQUEST");
    for (const name of ["new\nline.txt", "bidi\u202Etxt.txt"]) {
      writeFileSync(join(a.dir, name), "x\n");
      const reply = await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1", params: { message: "m", paths: [name] } });
      assert.equal(reply.code, "UNSUPPORTED_CHANGE", JSON.stringify(name));
    }
    // multi-line and direction-changing agent text is shown quoted, with control characters made visible
    const multi = await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1", params: { message: "line one\nRisks:\n  - none\u202Eevil", paths: ["plain.txt"] } });
    const multiPage = await raw(h, { path: `/plan/${multi.requestId}`, headers: { host: `localhost:${h.port}` } });
    assert.ok(!multiPage.text.includes("line one\nRisks"), "a newline in the message must not start a fake line");
    assert.ok(multiPage.text.includes("\\n") && multiPage.text.includes("\\u202e"));
  });

  test("a hostile plan id in the URL is not reflected as markup", async () => {
    const { h } = await world();
    for (const path of ["/plan/%3Cscript%3Ealert(1)%3C%2Fscript%3E", "/plan/%E0%A4%A", "/plan/..%2f..%2fetc%2fpasswd"]) {
      const res = await raw(h, { path, headers: { host: `localhost:${h.port}` } });
      assert.ok(res.status >= 400, path);
      assert.ok(!res.text.includes("<script>alert"), path);
    }
  });
});

describe("request origin, host and content type", () => {
  const post = (h, headers, body = "{}") => raw(h, { method: "POST", path: "/api/challenge", headers: { host: `localhost:${h.port}`, ...headers }, body });

  test("a wrong Host (DNS rebinding) is refused for pages and API", async () => {
    const { h } = await world();
    assert.equal((await raw(h, { path: "/", headers: { host: "evil.example" } })).status, 403);
    assert.equal((await raw(h, { path: "/", headers: { host: `127.0.0.1:${h.port}` } })).status, 403, "127.0.0.1 is a different origin from the enrolled one");
    assert.equal((await post(h, { host: "evil.example", origin: h.origin, "content-type": "application/json" })).status, 403);
  });

  test("a cross-origin, missing-origin or form-encoded POST is refused (CSRF)", async () => {
    const { h } = await world();
    const body = JSON.stringify({ planId: "x", decision: "approve" });
    assert.equal((await post(h, { origin: "http://localhost:1", "content-type": "application/json" }, body)).status, 403);
    assert.equal((await post(h, { origin: "http://evil.example", "content-type": "application/json" }, body)).status, 403);
    assert.equal((await post(h, { "content-type": "application/json" }, body)).status, 403, "no Origin header");
    assert.equal((await post(h, { origin: h.origin, "content-type": "text/plain" }, body)).status, 415);
    assert.equal((await post(h, { origin: h.origin, "content-type": "application/x-www-form-urlencoded" }, "planId=x")).status, 415);
    assert.equal((await raw(h, { method: "PUT", path: "/api/decide", headers: { host: `localhost:${h.port}` } })).status, 405);
    assert.equal((await raw(h, { path: "/api/decide", headers: { host: `localhost:${h.port}` } })).status, 404, "state-changing API is not reachable by GET");
  });

  test("an oversized or malformed body does not crash or approve anything", async () => {
    const { h } = await world();
    const huge = await post(h, { origin: h.origin, "content-type": "application/json" }, "x".repeat(2_000_000)).catch((e) => ({ status: 0, error: e.code }));
    assert.ok(huge.status === 0 || huge.status >= 400);
    assert.equal((await post(h, { origin: h.origin, "content-type": "application/json" }, "{not json")).status, 400);
    assert.equal((await h.call({ op: "health" })).ok, true, "the service is still up");
  });
});

describe("challenge binding and single use", () => {
  async function pending() {
    const { a, h } = await world();
    stage(a.dir, "f.txt", "f\n");
    const one = await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1", params: { message: "one", paths: ["f.txt"] } });
    return { a, h, one };
  }

  test("an assertion cannot be replayed; a failed attempt does not spend a challenge (only a verified decision does)", async () => {
    const { h, one } = await pending();
    const baseline = h.service.web.spentChallenges(); // the enrollment already spent one
    const c = await h.post("/api/challenge", { planId: one.requestId, decision: "approve" });
    const a = h.device.assert({ challenge: c.json.publicKey.challenge });
    const cred = { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } };
    const bad = await h.post("/api/decide", { challengeId: c.json.challengeId, credential: { ...cred, response: { ...cred.response, signature: cred.response.signature.slice(0, -4) + "AAAA" } } });
    assert.notEqual(bad.status, 200);
    assert.equal(h.service.web.spentChallenges(), baseline, "a garbage assertion must not be able to grow any state");
    const ok = await h.post("/api/decide", { challengeId: c.json.challengeId, credential: cred });
    assert.equal(ok.status, 200, "the owner's genuine assertion for the same challenge still works after someone else's failed attempt");
    const replay = await h.post("/api/decide", { challengeId: c.json.challengeId, credential: cred });
    assert.equal(replay.status, 409, "the verified decision spent the challenge");
    assert.equal(h.service.web.spentChallenges(), baseline + 1);
  });

  test("an assertion for one plan or one decision cannot decide another", async () => {
    const { a, h, one } = await pending();
    stage(a.dir, "g.txt", "g\n");
    const two = await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1", params: { message: "two", paths: ["f.txt", "g.txt"] } });
    const cOne = await h.post("/api/challenge", { planId: one.requestId, decision: "approve" });
    const cTwo = await h.post("/api/challenge", { planId: two.requestId, decision: "approve" });
    const assertOne = h.device.assert({ challenge: cOne.json.publicKey.challenge });
    // present plan one's assertion against plan two's challenge id
    const crossed = await h.post("/api/decide", { challengeId: cTwo.json.challengeId, credential: { id: assertOne.id, response: { clientDataJSON: assertOne.clientDataJSON, authenticatorData: assertOne.authenticatorData, signature: assertOne.signature } } });
    assert.equal(crossed.status, 403);
    // a challenge for "reject" yields a rejection, never an approval, whatever the caller says afterwards
    const cRej = await h.post("/api/challenge", { planId: one.requestId, decision: "reject" });
    const aRej = h.device.assert({ challenge: cRej.json.publicKey.challenge });
    const decided = await h.post("/api/decide", { challengeId: cRej.json.challengeId, decision: "approve", credential: { id: aRej.id, response: { clientDataJSON: aRej.clientDataJSON, authenticatorData: aRej.authenticatorData, signature: aRej.signature } } });
    assert.equal(decided.json.state, "rejected");
    assert.equal((await h.call({ op: "status", requestId: one.requestId })).state, "rejected");
    assert.equal((await h.call({ op: "status", requestId: two.requestId })).state, "awaiting-operator");
  });

  test("user presence without user verification, a wrong origin and an unenrolled authenticator are refused", async () => {
    const { h, one } = await pending();
    const c = async () => (await h.post("/api/challenge", { planId: one.requestId, decision: "approve" })).json;
    const send = (ch, a) => h.post("/api/decide", { challengeId: ch.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
    let ch = await c();
    assert.equal((await send(ch, h.device.assert({ challenge: ch.publicKey.challenge, flags: 0x01 }))).status, 403, "UP without UV");
    ch = await c();
    assert.equal((await send(ch, h.device.assert({ challenge: ch.publicKey.challenge, originOverride: "http://localhost:1" }))).status, 403, "other origin");
    ch = await c();
    assert.equal((await send(ch, h.device.assert({ challenge: ch.publicKey.challenge, type: "webauthn.create" }))).status, 403, "wrong ceremony type");
    const { createSoftwareAuthenticator } = await import("../broker/test-authenticator.mjs");
    const stranger = createSoftwareAuthenticator({ rpId: "localhost", origin: h.origin });
    ch = await c();
    assert.equal((await send(ch, stranger.assert({ challenge: ch.publicKey.challenge }))).status, 403, "not enrolled");
    ch = await c();
    assert.equal((await send(ch, h.device.assert({ challenge: ch.publicKey.challenge, rpIdHashOf: "evil.example" }))).status, 403, "other RP ID");
    assert.equal((await h.call({ op: "status", requestId: one.requestId })).state, "awaiting-operator");
  });

  test("F-NAS-011: a flood of challenge requests stores nothing, blocks nothing and cannot delay the owner's decision", async () => {
    const { h, one } = await pending();
    const baseline = h.service.web.spentChallenges();
    const owner = await h.post("/api/challenge", { planId: one.requestId, decision: "approve" }); // the owner's own challenge, issued before the flood
    const started = Date.now();
    await Promise.all(Array.from({ length: 10 }, async () => {
      for (let i = 0; i < 300; i += 1) await h.post("/api/challenge", { planId: one.requestId, decision: i % 2 ? "approve" : "reject" });
    }));
    assert.equal(h.service.web.openChallenges(), 0, "nothing is stored per challenge");
    assert.equal(h.service.web.spentChallenges(), baseline);
    const a = h.device.assert({ challenge: owner.json.publicKey.challenge });
    const decided = await h.post("/api/decide", { challengeId: owner.json.challengeId, credential: { id: a.id, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } } });
    assert.equal(decided.status, 200, "the challenge issued BEFORE the flood still decides; nothing evicted it");
    assert.ok(Date.now() - started < 60_000);
    assert.equal((await h.call({ op: "health" })).ok, true);
  });

  test("a challenge id cannot be forged or altered: changing the plan, decision or expiry invalidates it", async () => {
    const { a, h, one } = await pending();
    stage(a.dir, "other.txt", "o\n");
    const two = await h.call({ op: "submit", operation: "git_commit", repository: a.dir, workItemId: "WI-1", params: { message: "two", paths: ["f.txt", "other.txt"] } });
    const issued = await h.post("/api/challenge", { planId: one.requestId, decision: "reject" });
    const [payload, tag] = issued.json.challengeId.split(".");
    const record = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const assertion = h.device.assert({ challenge: issued.json.publicKey.challenge });
    const cred = { id: assertion.id, response: { clientDataJSON: assertion.clientDataJSON, authenticatorData: assertion.authenticatorData, signature: assertion.signature } };
    const forge = (patch) => `${Buffer.from(JSON.stringify({ ...record, ...patch })).toString("base64url")}.${tag}`;
    for (const patch of [{ planId: two.requestId }, { decision: "approve" }, { expires: record.expires + 3_600_000 }]) {
      assert.equal((await h.post("/api/decide", { challengeId: forge(patch), credential: cred })).status, 409, JSON.stringify(patch));
    }
    assert.equal((await h.post("/api/decide", { challengeId: "x.y", credential: cred })).status, 409);
    assert.equal((await h.post("/api/decide", { challengeId: undefined, credential: cred })).status, 409);
    assert.equal((await h.call({ op: "status", requestId: one.requestId })).state, "awaiting-operator");
    assert.equal((await h.call({ op: "status", requestId: two.requestId })).state, "awaiting-operator");
  });
});

describe("enrollment", () => {
  test("a wrong secret is limited, a closed window refuses everything, and enrolling needs the code only the service can create", async () => {
    const { h } = await world(); // already enrolled once: window closed
    const closed = await h.post("/api/enroll/challenge", { secret: "anything", label: "x" });
    assert.equal(closed.json.code, "ENROLLMENT_CLOSED");
    const { openEnrollmentWindow } = await import("./lib/enroll.mjs");
    const { code } = openEnrollmentWindow(h.stateDir, h.origin);
    for (let i = 0; i < 5; i += 1) assert.equal((await h.post("/api/enroll/challenge", { secret: `guess${i}`, label: "x" })).json.code, "ENROLLMENT_SECRET");
    assert.equal((await h.post("/api/enroll/challenge", { secret: "guess6", label: "x" })).json.code, "ENROLLMENT_LOCKED");
    assert.equal((await h.post("/api/enroll/challenge", { secret: code, label: "x" })).json.code, "ENROLLMENT_LOCKED", "even the right secret is locked after five misses until a new window is opened");
    const second = openEnrollmentWindow(h.stateDir, h.origin);
    assert.notEqual(second.code, code);
    assert.equal((await h.post("/api/enroll/challenge", { secret: second.code, label: "x" })).status, 200);
  });

  test("enrollment through the IPC does not exist and the window cannot be opened by an IPC client", async () => {
    const { h } = await world();
    for (const op of ["enroll", "enroll-code", "open-enrollment"]) assert.equal((await h.call({ op })).code, "UNKNOWN_OPERATION");
  });
});
