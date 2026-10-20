import assert from "node:assert/strict";
import { test } from "node:test";
import { b64u, cborDecode, decisionChallenge, newNonce, verifyAssertion, verifyRegistration, WebAuthnError } from "./webauthn.mjs";
import { cborEncode, createSoftwareAuthenticator, FLAGS } from "./test-authenticator.mjs";

const rpId = "localhost";
const origin = "http://localhost:8780";
const challenge = decisionChallenge({ planId: "p1", planFingerprint: `sha256:${"a".repeat(64)}`, decision: "approve", nonce: "n" });

function enrolled() {
  const device = createSoftwareAuthenticator({ rpId, origin });
  const reg = device.register({ challenge });
  const record = verifyRegistration({
    clientDataJSON: b64u.decode(reg.clientDataJSON),
    attestationObject: b64u.decode(reg.attestationObject),
    expectedChallenge: challenge,
    origin,
    rpId,
  });
  return { device, record };
}

function verifyWith(device, record, assertion, extra = {}) {
  return verifyAssertion({
    clientDataJSON: b64u.decode(assertion.clientDataJSON),
    authenticatorData: b64u.decode(assertion.authenticatorData),
    signature: b64u.decode(assertion.signature),
    expectedChallenge: challenge,
    origin,
    rpId,
    publicKeyJwk: record.publicKeyJwk,
    storedSignCount: 0,
    ...extra,
  });
}

const refuses = (fn, code) => assert.throws(fn, (error) => error instanceof WebAuthnError && error.code === code, `expected ${code}`);

test("CBOR round trip for the shapes WebAuthn uses", () => {
  const value = new Map([["fmt", "none"], [1, 2], [-2, Buffer.from([1, 2, 3])], ["list", [1, -7, "x"]]]);
  const [decoded] = cborDecode(cborEncode(value));
  assert.deepEqual([...decoded], [...value]);
  assert.throws(() => cborDecode(Buffer.from([0x5f])), WebAuthnError);
  assert.throws(() => cborDecode(Buffer.from([0x58, 0x20, 1, 2])), WebAuthnError);
});

test("enrollment records an ES256 credential and its key", () => {
  const { device, record } = enrolled();
  assert.equal(record.credentialId, device.credentialId);
  assert.deepEqual(record.publicKeyJwk, device.publicKeyJwk);
  assert.equal(record.attestationFormat, "none");
});

test("enrollment refuses a wrong challenge, origin, type, relying party, or missing verification", () => {
  const device = createSoftwareAuthenticator({ rpId, origin });
  const run = (reg, expected = challenge) =>
    verifyRegistration({ clientDataJSON: b64u.decode(reg.clientDataJSON), attestationObject: b64u.decode(reg.attestationObject), expectedChallenge: expected, origin, rpId });
  refuses(() => run(device.register({ challenge }), "different"), "WEBAUTHN_CHALLENGE");
  refuses(() => run(device.register({ challenge, originOverride: "http://evil.example" })), "WEBAUTHN_ORIGIN");
  refuses(() => run(device.register({ challenge, type: "webauthn.get" })), "WEBAUTHN_TYPE");
  refuses(() => run(device.register({ challenge, rpIdHashOf: "evil.example" })), "WEBAUTHN_RP");
  refuses(() => run(device.register({ challenge, flags: FLAGS.UP | FLAGS.AT })), "WEBAUTHN_VERIFICATION");
  refuses(() => run(device.register({ challenge, flags: FLAGS.UV | FLAGS.AT })), "WEBAUTHN_PRESENCE");
});

test("a genuine user-verified assertion over the challenge verifies", () => {
  const { device, record } = enrolled();
  const result = verifyWith(device, record, device.assert({ challenge }));
  assert.equal(result.uv, true);
  assert.equal(result.up, true);
  assert.equal(result.signCount, 1);
});

test("regression: a signature from a key that was never enrolled is refused", () => {
  // The attack this channel exists to stop: an agent signing with its own key.
  const { device, record } = enrolled();
  device.rekey();
  refuses(() => verifyWith(device, record, device.assert({ challenge })), "WEBAUTHN_SIGNATURE");
});

test("any tampering with what was signed is refused", () => {
  const { device, record } = enrolled();
  const good = device.assert({ challenge });
  const tamper = (field, mutate) => ({ ...good, [field]: b64u.encode(mutate(b64u.decode(good[field]))) });
  const flip = (buffer) => Buffer.from(buffer.map((byte, i) => (i === buffer.length - 1 ? byte ^ 1 : byte)));
  refuses(() => verifyWith(device, record, tamper("signature", flip)), "WEBAUTHN_SIGNATURE");
  refuses(() => verifyWith(device, record, tamper("authenticatorData", flip)), "WEBAUTHN_SIGNATURE");
  // Changing clientDataJSON changes the signed hash (and here also the challenge).
  refuses(() => verifyWith(device, record, tamper("clientDataJSON", flip)), "WEBAUTHN_MALFORMED");
});

test("a signature over a different decision is refused (the challenge commits to the plan)", () => {
  const { device, record } = enrolled();
  const other = decisionChallenge({ planId: "p1", planFingerprint: `sha256:${"b".repeat(64)}`, decision: "approve", nonce: "n" });
  refuses(() => verifyWith(device, record, device.assert({ challenge: other })), "WEBAUTHN_CHALLENGE");
  const reject = decisionChallenge({ planId: "p1", planFingerprint: `sha256:${"a".repeat(64)}`, decision: "reject", nonce: "n" });
  assert.notEqual(reject, challenge);
});

test("wrong origin, cross-origin, wrong ceremony type and wrong relying party are refused", () => {
  const { device, record } = enrolled();
  refuses(() => verifyWith(device, record, device.assert({ challenge, originOverride: "http://127.0.0.1:8780" })), "WEBAUTHN_ORIGIN");
  refuses(() => verifyWith(device, record, device.assert({ challenge, crossOrigin: true })), "WEBAUTHN_ORIGIN");
  refuses(() => verifyWith(device, record, device.assert({ challenge, type: "webauthn.create" })), "WEBAUTHN_TYPE");
  refuses(() => verifyWith(device, record, device.assert({ challenge, rpIdHashOf: "evil.example" })), "WEBAUTHN_RP");
});

test("a gesture without user verification, or without presence, is refused", () => {
  const { device, record } = enrolled();
  refuses(() => verifyWith(device, record, device.assert({ challenge, flags: FLAGS.UP })), "WEBAUTHN_VERIFICATION");
  refuses(() => verifyWith(device, record, device.assert({ challenge, flags: FLAGS.UV })), "WEBAUTHN_PRESENCE");
});

test("the signature counter must advance when one exists, and may stay at zero when the device has none", () => {
  const { device, record } = enrolled();
  const first = verifyWith(device, record, device.assert({ challenge }));
  refuses(() => verifyWith(device, record, device.assert({ challenge, advance: false }), { storedSignCount: first.signCount }), "WEBAUTHN_COUNTER");
  const counterless = createSoftwareAuthenticator({ rpId, origin });
  const reg = counterless.register({ challenge });
  const rec = verifyRegistration({ clientDataJSON: b64u.decode(reg.clientDataJSON), attestationObject: b64u.decode(reg.attestationObject), expectedChallenge: challenge, origin, rpId });
  const result = verifyWith(counterless, rec, counterless.assert({ challenge, advance: false }));
  assert.equal(result.counterless, true);
});

test("garbage input is refused, not thrown as an unhandled error", () => {
  const { record } = enrolled();
  assert.throws(
    () => verifyAssertion({ clientDataJSON: Buffer.from("not json"), authenticatorData: Buffer.alloc(10), signature: Buffer.alloc(8), expectedChallenge: challenge, origin, rpId, publicKeyJwk: record.publicKeyJwk }),
    WebAuthnError,
  );
  assert.throws(() => b64u.decode("not base64url!"), WebAuthnError);
});

test("challenges are deterministic for a decision and nonces are fresh", () => {
  const t = { planId: "p", decision: "approve", nonce: "x" };
  assert.equal(decisionChallenge(t), decisionChallenge({ nonce: "x", decision: "approve", planId: "p" }));
  assert.notEqual(newNonce(), newNonce());
});
