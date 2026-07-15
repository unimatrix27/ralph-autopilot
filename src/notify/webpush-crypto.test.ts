/**
 * Web Push crypto correctness (issue #119). Two independent proofs:
 *   1. **RFC 8291 Appendix A test vectors** — the encryption matches the published standard
 *      byte-for-byte (CEK, nonce, the 86-octet header, the ciphertext, and the full body).
 *      This is the only proof that a real browser can decrypt what the daemon sends; a
 *      self-rolled round-trip would only prove internal consistency.
 *   2. A round-trip through {@link decryptWebPushPayload} (the browser's side) — sanity that
 *      the encrypt/decrypt pair are mutual inverses.
 * Plus VAPID (RFC 8292) JWT shape + ES256 verifiability.
 */
import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  decryptWebPushPayload,
  deriveEncryptionKeys,
  encryptWebPushPayload,
  signVapidJwt,
  vapidPrivateKeyObject,
  vapidPublicKeyFromScalar,
  vapidPublicKeyObject,
  SALT_LENGTH,
} from "./webpush-crypto";
import { verify } from "node:crypto";

// RFC 8291 Appendix A inputs (base64url).
const AS_PRIVATE = base64UrlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
const AS_PUBLIC = base64UrlDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
const UA_PUBLIC = base64UrlDecode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
const UA_PRIVATE = base64UrlDecode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
const SALT = base64UrlDecode("DGv6ra1nlYgDCS1FRnbzlw");
const AUTH_SECRET = base64UrlDecode("BTBZMqHH6r4Tts7J_aSIgg");
const PLAINTEXT = Buffer.from("When I grow up, I want to be a watermelon", "utf8");

// RFC 8291 Appendix A expected intermediates + output.
const EXPECTED_ECDH_SECRET = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
const EXPECTED_CEK = "oIhVW04MRdy2XN9CiKLxTg";
const EXPECTED_NONCE = "4h_95klXJ5E_qnoN";
const EXPECTED_CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

describe("RFC 8291 web push encryption", () => {
  it("derives the shared ECDH secret matching Appendix A", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(AS_PRIVATE);
    const shared = ecdh.computeSecret(UA_PUBLIC);
    expect(base64UrlEncode(shared)).toBe(EXPECTED_ECDH_SECRET);
  });

  it("derives CEK + nonce matching Appendix A", () => {
    const { cek, nonce } = deriveEncryptionKeys({
      uaPublic: UA_PUBLIC,
      authSecret: AUTH_SECRET,
      asPrivate: AS_PRIVATE,
      asPublic: AS_PUBLIC,
      salt: SALT,
    });
    expect(base64UrlEncode(cek)).toBe(EXPECTED_CEK);
    expect(base64UrlEncode(nonce)).toBe(EXPECTED_NONCE);
  });

  it("encrypts to the exact Appendix A ciphertext under a spec-correct header", () => {
    const body = encryptWebPushPayload({
      plaintext: PLAINTEXT,
      keys: { uaPublic: UA_PUBLIC, authSecret: AUTH_SECRET },
      salt: SALT,
      senderPrivate: AS_PRIVATE,
    });
    // The RFC 8188 §2.1 header, byte-precise: salt(16) || rs=4096 big-endian(4) ||
    // idlen=65(1) || keyid = the sender's uncompressed public key (65) = 86 octets.
    expect(body.length).toBe(86 + base64UrlDecode(EXPECTED_CIPHERTEXT).length);
    expect(body.subarray(0, SALT_LENGTH)).toEqual(SALT);
    expect(body.readUInt32BE(SALT_LENGTH)).toBe(4096);
    expect(body[SALT_LENGTH + 4]).toBe(65);
    expect(body.subarray(SALT_LENGTH + 5, 86)).toEqual(AS_PUBLIC);
    // The AES-128-GCM ciphertext (RFC Appendix A) follows byte-for-byte. This is the proof
    // a real browser can decrypt what we send — the RFC presents it as a clean standalone
    // base64, unlike the full body (shown presentation-wrapped in §5).
    expect(base64UrlEncode(body.subarray(86))).toBe(EXPECTED_CIPHERTEXT);
  });

  it("round-trips: the browser (ua private key) recovers the plaintext", () => {
    const body = encryptWebPushPayload({
      plaintext: PLAINTEXT,
      keys: { uaPublic: UA_PUBLIC, authSecret: AUTH_SECRET },
    });
    const recovered = decryptWebPushPayload({
      body,
      keys: { uaPrivate: UA_PRIVATE, authSecret: AUTH_SECRET },
    });
    expect(recovered.toString("utf8")).toBe("When I grow up, I want to be a watermelon");
  });

  it("produces a different body each call (fresh ephemeral sender + salt)", () => {
    const a = encryptWebPushPayload({ plaintext: PLAINTEXT, keys: { uaPublic: UA_PUBLIC, authSecret: AUTH_SECRET } });
    const b = encryptWebPushPayload({ plaintext: PLAINTEXT, keys: { uaPublic: UA_PUBLIC, authSecret: AUTH_SECRET } });
    expect(base64UrlEncode(a)).not.toBe(base64UrlEncode(b));
    // …but both decrypt to the same plaintext.
    expect(
      decryptWebPushPayload({ body: b, keys: { uaPrivate: UA_PRIVATE, authSecret: AUTH_SECRET } }).toString("utf8"),
    ).toBe("When I grow up, I want to be a watermelon");
  });

  it("rejects a subscription public key that is not the 65-octet uncompressed point", () => {
    expect(() =>
      encryptWebPushPayload({
        plaintext: PLAINTEXT,
        keys: { uaPublic: Buffer.alloc(32), authSecret: AUTH_SECRET },
      }),
    ).toThrow(/p256dh/);
  });

  it("rejects an auth secret that is not 16 octets (a sender-undetectable decrypt failure)", () => {
    expect(() =>
      encryptWebPushPayload({
        plaintext: PLAINTEXT,
        keys: { uaPublic: UA_PUBLIC, authSecret: Buffer.alloc(8) },
      }),
    ).toThrow(/auth secret/);
  });
});

describe("VAPID keypair + JWT (RFC 8292)", () => {
  it("derives the uncompressed public point from the private scalar", () => {
    const pub = vapidPublicKeyFromScalar(AS_PRIVATE);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(base64UrlEncode(pub)).toBe(base64UrlEncode(AS_PUBLIC));
  });

  it("signs an ES256 JWT verifiable with the derived public key, carrying aud/exp/sub", () => {
    const priv = vapidPrivateKeyObject(AS_PRIVATE);
    const pub = vapidPublicKeyObject(vapidPublicKeyFromScalar(AS_PRIVATE));
    const jwt = signVapidJwt({
      privateKey: priv,
      aud: "https://fcm.googleapis.com",
      sub: "mailto:operator@example.com",
      exp: 1_700_000_000,
    });
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(JSON.parse(base64UrlDecode(headerB64!).toString("utf8"))).toEqual({ alg: "ES256", typ: "JWT" });
    const payload = JSON.parse(base64UrlDecode(payloadB64!).toString("utf8")) as Record<string, unknown>;
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.exp).toBe(1_700_000_000);
    expect(payload.sub).toBe("mailto:operator@example.com");
    // ES256 signature is the raw 64-octet R||S.
    const sig = base64UrlDecode(sigB64!);
    expect(sig.length).toBe(64);
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
    expect(verify("SHA256", signingInput, { key: pub, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });
});
