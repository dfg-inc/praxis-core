/**
 * Minimal WebAuthn relying-party verification for the Praxis approval broker. No dependencies.
 *
 * What it proves: a person performed a user-verified gesture (Touch ID, a PIN-protected security key) on an
 * authenticator that holds a private key enrolled with this broker, over a challenge that is the hash of the
 * exact decision shown to them. An agent that can run any process on the host but cannot touch the
 * authenticator cannot produce such a signature.
 *
 * What it does not prove: that the authenticator is hardware (attestation is recorded, not verified:
 * enrollment is trust-on-first-use), nor that the broker's own files are out of the agent's reach. That is
 * the deployment's job; see assessApprovalDeployment.
 *
 * Supported: ES256 (alg -7, P-256), the algorithm used by platform authenticators and security keys.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export class WebAuthnError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new WebAuthnError(code, message);
};

export const b64u = {
  encode: (buffer) => Buffer.from(buffer).toString("base64url"),
  decode: (text) => {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) fail("WEBAUTHN_MALFORMED", "expected base64url text");
    return Buffer.from(text, "base64url");
  },
};

const sha256 = (data) => createHash("sha256").update(data).digest();

function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- CBOR (the subset WebAuthn uses) ---------------------------------------------------------------------

export function cborDecode(buffer, start = 0, depth = 0) {
  if (depth > 8) fail("WEBAUTHN_MALFORMED", "CBOR nested too deeply");
  if (start >= buffer.length) fail("WEBAUTHN_MALFORMED", "CBOR truncated");
  let offset = start;
  const initial = buffer[offset++];
  const major = initial >> 5;
  const info = initial & 31;
  let length;
  if (info < 24) length = info;
  else if (info === 24) length = buffer[offset++];
  else if (info === 25) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (info === 26) {
    length = buffer.readUInt32BE(offset);
    offset += 4;
  } else if (major === 7 && info >= 20 && info <= 23) {
    length = 0;
  } else fail("WEBAUTHN_MALFORMED", "unsupported CBOR length");
  if (length === undefined || Number.isNaN(length)) fail("WEBAUTHN_MALFORMED", "CBOR truncated");
  switch (major) {
    case 0:
      return [length, offset];
    case 1:
      return [-1 - length, offset];
    case 2:
    case 3: {
      if (offset + length > buffer.length) fail("WEBAUTHN_MALFORMED", "CBOR string runs past the end");
      const bytes = buffer.subarray(offset, offset + length);
      return [major === 2 ? Buffer.from(bytes) : bytes.toString("utf8"), offset + length];
    }
    case 4: {
      if (length > 256) fail("WEBAUTHN_MALFORMED", "CBOR array too large");
      const items = [];
      for (let i = 0; i < length; i += 1) {
        const [item, next] = cborDecode(buffer, offset, depth + 1);
        items.push(item);
        offset = next;
      }
      return [items, offset];
    }
    case 5: {
      if (length > 256) fail("WEBAUTHN_MALFORMED", "CBOR map too large");
      const map = new Map();
      for (let i = 0; i < length; i += 1) {
        const [key, afterKey] = cborDecode(buffer, offset, depth + 1);
        const [value, afterValue] = cborDecode(buffer, afterKey, depth + 1);
        map.set(key, value);
        offset = afterValue;
      }
      return [map, offset];
    }
    case 7:
      return [info === 20 ? false : info === 21 ? true : info === 22 ? null : undefined, offset];
    default:
      return fail("WEBAUTHN_MALFORMED", "unsupported CBOR type");
  }
}

// --- authenticator data ----------------------------------------------------------------------------------

export function parseAuthenticatorData(buffer) {
  if (buffer.length < 37) fail("WEBAUTHN_MALFORMED", "authenticator data is too short");
  const flags = buffer[32];
  const parsed = {
    rpIdHash: buffer.subarray(0, 32),
    flags,
    up: (flags & FLAG_UP) !== 0,
    uv: (flags & FLAG_UV) !== 0,
    attested: (flags & FLAG_AT) !== 0,
    signCount: buffer.readUInt32BE(33),
  };
  if (!parsed.attested) return parsed;
  if (buffer.length < 55) fail("WEBAUTHN_MALFORMED", "attested credential data is truncated");
  const idLength = buffer.readUInt16BE(53);
  if (idLength === 0 || idLength > 1023 || 55 + idLength > buffer.length) fail("WEBAUTHN_MALFORMED", "credential id length is invalid");
  const [cose] = cborDecode(buffer, 55 + idLength);
  return {
    ...parsed,
    aaguid: buffer.subarray(37, 53).toString("hex"),
    credentialId: Buffer.from(buffer.subarray(55, 55 + idLength)),
    cose,
  };
}

/** COSE EC2 / P-256 / ES256 key to a JWK. Anything else is refused. */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) fail("WEBAUTHN_UNSUPPORTED", "credential public key is not a COSE map");
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    fail("WEBAUTHN_UNSUPPORTED", "only ES256 (EC2, P-256) credentials are supported");
  }
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    fail("WEBAUTHN_MALFORMED", "credential public key coordinates are malformed");
  }
  return { kty: "EC", crv: "P-256", x: b64u.encode(x), y: b64u.encode(y) };
}

// --- ceremonies ------------------------------------------------------------------------------------------

function checkClientData(clientDataJSON, { type, expectedChallenge, origin }) {
  let client;
  try {
    client = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    return fail("WEBAUTHN_MALFORMED", "clientDataJSON is not JSON");
  }
  if (client.type !== type) fail("WEBAUTHN_TYPE", `expected ${type}`);
  if (typeof client.challenge !== "string" || !safeEqual(Buffer.from(client.challenge), Buffer.from(expectedChallenge))) {
    fail("WEBAUTHN_CHALLENGE", "the signed challenge is not the one issued for this decision");
  }
  if (client.origin !== origin) fail("WEBAUTHN_ORIGIN", "the ceremony ran on a different origin");
  if (client.crossOrigin === true) fail("WEBAUTHN_ORIGIN", "cross-origin ceremonies are refused");
  return client;
}

/** Enrollment. Records the credential; does not verify attestation (trust on first use). */
export function verifyRegistration({ clientDataJSON, attestationObject, expectedChallenge, origin, rpId }) {
  checkClientData(clientDataJSON, { type: "webauthn.create", expectedChallenge, origin });
  const [attestation] = cborDecode(attestationObject);
  if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get("authData"))) {
    fail("WEBAUTHN_MALFORMED", "attestation object has no authenticator data");
  }
  const data = parseAuthenticatorData(attestation.get("authData"));
  if (!safeEqual(data.rpIdHash, sha256(rpId))) fail("WEBAUTHN_RP", "credential was created for a different relying party");
  if (!data.up) fail("WEBAUTHN_PRESENCE", "user presence was not asserted");
  if (!data.uv) fail("WEBAUTHN_VERIFICATION", "user verification (biometric or PIN) was not performed");
  if (!data.attested || !data.credentialId) fail("WEBAUTHN_MALFORMED", "no credential in the attestation");
  return {
    credentialId: b64u.encode(data.credentialId),
    publicKeyJwk: coseToJwk(data.cose),
    signCount: data.signCount,
    aaguid: data.aaguid,
    attestationFormat: String(attestation.get("fmt") ?? "none"),
  };
}

/**
 * A decision. Requires user presence AND user verification, and a signature by an enrolled key over
 * authenticatorData || sha256(clientDataJSON).
 */
export function verifyAssertion({
  clientDataJSON,
  authenticatorData,
  signature,
  expectedChallenge,
  origin,
  rpId,
  publicKeyJwk,
  storedSignCount = 0,
}) {
  checkClientData(clientDataJSON, { type: "webauthn.get", expectedChallenge, origin });
  const data = parseAuthenticatorData(authenticatorData);
  if (!safeEqual(data.rpIdHash, sha256(rpId))) fail("WEBAUTHN_RP", "assertion is for a different relying party");
  if (!data.up) fail("WEBAUTHN_PRESENCE", "user presence was not asserted");
  if (!data.uv) fail("WEBAUTHN_VERIFICATION", "user verification (biometric or PIN) was not performed");
  let key;
  try {
    key = createPublicKey({ key: publicKeyJwk, format: "jwk" });
  } catch {
    return fail("WEBAUTHN_MALFORMED", "enrolled public key is unusable");
  }
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  let valid = false;
  try {
    valid = verify("sha256", signed, { key, dsaEncoding: "der" }, signature);
  } catch {
    valid = false;
  }
  if (!valid) fail("WEBAUTHN_SIGNATURE", "signature does not verify against the enrolled key");
  // Platform authenticators often report 0 forever; a counter that exists must move forward.
  if ((data.signCount !== 0 || storedSignCount !== 0) && data.signCount <= storedSignCount) {
    fail("WEBAUTHN_COUNTER", "signature counter did not advance: possible cloned authenticator");
  }
  return { signCount: data.signCount, up: data.up, uv: data.uv, counterless: data.signCount === 0 && storedSignCount === 0 };
}

// --- the challenge: what you see is what you sign -----------------------------------------------------------

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The WebAuthn challenge is the hash of the decision itself plus a single-use nonce, so the authenticator's
 * signature commits to exactly this plan, this fingerprint, this kind of decision and this verdict.
 */
export function decisionChallenge(transaction) {
  return b64u.encode(sha256(`praxis-approval-v1:${canonical(transaction)}`));
}

export const newNonce = () => b64u.encode(randomBytes(24));
