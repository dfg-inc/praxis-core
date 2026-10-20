/**
 * TEST-ONLY software WebAuthn authenticator. A real P-256 key signing real WebAuthn structures, so the
 * relying-party verification can be exercised (including forgeries) without hardware. It is NOT a
 * trust source: anything signed by it proves only that the test held the key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { b64u } from "./webauthn.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest();

function head(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(length, 1);
  return b;
}

export function cborEncode(value) {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])]);
  }
  throw new Error("cannot encode");
}

export const FLAGS = { UP: 0x01, UV: 0x04, AT: 0x40 };

export function createSoftwareAuthenticator({ rpId, origin }) {
  let { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  let counter = 0;
  const jwk = publicKey.export({ format: "jwk" });
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]);

  function authData({ flags, attested }) {
    const header = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)]);
    header.writeUInt32BE(counter, 33);
    if (!attested) return header;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([header, Buffer.alloc(16), idLength, credentialId, cborEncode(cose)]);
  }

  return {
    credentialId: b64u.encode(credentialId),
    publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    /** Make this authenticator behave as a different, unenrolled device (an attacker's key). */
    rekey() {
      ({ publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }));
    },
    register({ challenge, flags = FLAGS.UP | FLAGS.UV | FLAGS.AT, type = "webauthn.create", originOverride, rpIdHashOf }) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin: originOverride ?? origin }));
      const data = authData({ flags, attested: true });
      if (rpIdHashOf) sha256(rpIdHashOf).copy(data, 0);
      return {
        id: b64u.encode(credentialId),
        clientDataJSON: b64u.encode(clientDataJSON),
        attestationObject: b64u.encode(cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", data]]))),
      };
    },
    assert({ challenge, flags = FLAGS.UP | FLAGS.UV, type = "webauthn.get", originOverride, advance = true, crossOrigin, rpIdHashOf }) {
      if (advance) counter += 1;
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type, challenge, origin: originOverride ?? origin, ...(crossOrigin === undefined ? {} : { crossOrigin }) }),
      );
      const data = authData({ flags, attested: false });
      if (rpIdHashOf) sha256(rpIdHashOf).copy(data, 0);
      const signature = sign("sha256", Buffer.concat([data, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: "der" });
      return {
        id: b64u.encode(credentialId),
        clientDataJSON: b64u.encode(clientDataJSON),
        authenticatorData: b64u.encode(data),
        signature: b64u.encode(signature),
      };
    },
  };
}
