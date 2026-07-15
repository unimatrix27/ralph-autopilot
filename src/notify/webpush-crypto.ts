/**
 * Pure Web Push cryptography (issue #119): RFC 8291 message encryption + RFC 8292 VAPID
 * JWT signing, implemented on Node's built-in `crypto` (no dependency — the control plane
 * stays on Node builtins, ADR-0029/0031). Every function here is deterministic over its
 * inputs and free of I/O / `process.env` / clocks, so the wire crypto is exhaustively
 * unit-tested — including against the published RFC 8291 test vectors
 * (see `webpush-crypto.test.ts`).
 *
 * Two independent P-256 keypairs are involved, and conflating them is the classic bug:
 *   - the **VAPID** keypair (the daemon's long-lived identity) signs the VAPID JWT and is
 *     the `applicationServerKey` the browser subscribes with; its public half is served to
 *     the UI at `/api/webpush/vapid`;
 *   - an **ephemeral** keypair generated fresh per message does the RFC 8291 ECDH + ships
 *     its public half as the aes128gcm header's `keyid`. It is discarded after each send.
 *
 * The browser holds the matching **subscription** keypair (its `p256dh`) + auth secret,
 * which is how it — not the push service — decrypts the payload.
 */
import { createECDH, createHmac, createPrivateKey, createPublicKey, sign, createCipheriv, createDecipheriv, randomBytes, type KeyObject } from "node:crypto";

/** P-256 via its OpenSSL curve name (the form `crypto.createECDH` accepts). */
const CURVE = "prime256v1";
/** The record-size constant the aes128gcm header carries (RFC 8188/8291 §4: 4096). */
const RECORD_SIZE = 4096;
/** Length of a random per-message salt (RFC 8291 §3.4: 16). */
export const SALT_LENGTH = 16;
/** Length of the GCM authentication tag appended to each encrypted record. */
const GCM_TAG_LENGTH = 16;

/** A port for sourcing cryptographically-random bytes; injected so tests are deterministic. */
export type RandomPort = typeof randomBytes;

// ---- base64url -------------------------------------------------------------

/** Encode bytes as unpadded URL-safe base64 (RFC 4648 §5) — the Push API's native encoding. */
export function base64UrlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

/** Decode an unpadded URL-safe base64 string to bytes. Throws on malformed input. */
export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** HMAC-SHA-256(key, data) — the one primitive all of RFC 8291's HKDF steps reduce to. */
function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", Buffer.from(key)).update(Buffer.from(data)).digest();
}

// ---- VAPID keypair (the daemon's long-lived identity) ---------------------

/**
 * Derive the uncompressed (65-octet, `0x04 || x || y`) VAPID public key from the 32-octet
 * private scalar — the value the browser needs as `applicationServerKey` and that rides in
 * the VAPID `k=` parameter. Pure over the scalar; the scalar is read from its env var by the
 * caller, so this module never touches `process.env` (ADR-0034).
 */
export function vapidPublicKeyFromScalar(privateScalar: Uint8Array): Buffer {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(privateScalar));
  return ecdh.getPublicKey(); // uncompressed by default
}

/**
 * Build an ECDSA P-256 {@link KeyObject} from the VAPID private scalar, for JWT signing.
 * Node's JWK importer needs the public coordinates, so they are derived from the scalar
 * (the same point {@link vapidPublicKeyFromScalar} returns) and round-tripped through a JWK.
 */
export function vapidPrivateKeyObject(privateScalar: Uint8Array): KeyObject {
  const pub = vapidPublicKeyFromScalar(privateScalar);
  const jwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: base64UrlEncode(pub.subarray(1, 33)),
    y: base64UrlEncode(pub.subarray(33, 65)),
    d: base64UrlEncode(privateScalar),
  };
  return createPrivateKey({ key: jwk, format: "jwk" });
}

/** Build an ECDSA P-256 public {@link KeyObject} from the uncompressed point, for verifying. */
export function vapidPublicKeyObject(uncompressedPublic: Uint8Array): KeyObject {
  const pub = Buffer.from(uncompressedPublic);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be the 65-octet uncompressed P-256 point");
  }
  const jwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: base64UrlEncode(pub.subarray(1, 33)),
    y: base64UrlEncode(pub.subarray(33, 65)),
  };
  return createPublicKey({ key: jwk, format: "jwk" });
}

// ---- RFC 8292 VAPID JWT ---------------------------------------------------

export interface VapidJwtOptions {
  /** The application-server private key (a {@link vapidPrivateKeyObject} KeyObject). */
  privateKey: KeyObject;
  /** The audience: the push service's origin URL (scheme + host [+ port]). */
  aud: string;
  /** The subject: a contact URI (mailto: or https:) for abuse reports. */
  sub?: string;
  /** Expiry instant (epoch seconds); defaults to now + 12 hours. */
  exp?: number;
  /** Injected clock for a deterministic `exp`; defaults to the wall clock. */
  now?: () => Date;
}

const DEFAULT_VAPID_TTL_SECONDS = 12 * 60 * 60;

function b64urlJson(value: unknown): string {
  return base64UrlEncode(Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Sign the VAPID JWT (RFC 8292 §2) the daemon presents to the push service: header
 * `{alg:"ES256",typ:"JWT"}`, payload `{aud, exp, sub?}`, ES256 signature in the raw
 * `R || S` (IEEE P1363) 64-octet form the JOSE ES256 algorithm mandates. Returns the compact
 * `header.payload.signature` string. The signature uses `dsaEncoding:"ieee-p1363"` so Node's
 * `crypto.sign` emits the raw R||S rather than the DER-encoded ASN.1.
 */
export function signVapidJwt(opts: VapidJwtOptions): string {
  const headerSegment = b64urlJson({ alg: "ES256", typ: "JWT" });
  const exp = opts.exp ?? Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000) + DEFAULT_VAPID_TTL_SECONDS;
  const payload: Record<string, unknown> = { aud: opts.aud, exp };
  if (opts.sub !== undefined && opts.sub.length > 0) {
    payload.sub = opts.sub;
  }
  const payloadSegment = b64urlJson(payload);
  const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii");
  const signature = sign("SHA256", signingInput, { key: opts.privateKey, dsaEncoding: "ieee-p1363" });
  return `${headerSegment}.${payloadSegment}.${base64UrlEncode(signature)}`;
}

// ---- RFC 8291 message encryption -----------------------------------------

/** A subscription's browser-generated key material, decoded to bytes. */
export interface SubscriptionKeys {
  /** The subscription's P-256 ECDH public key (uncompressed, 65 octets). */
  uaPublic: Buffer;
  /** The subscription's 16-octet authentication secret. */
  authSecret: Buffer;
}

/** The decoded ephemeral sender private scalar + its uncompressed public point. */
interface SenderKeys {
  asPrivate: Buffer;
  asPublic: Buffer;
}

/** Generate a fresh ephemeral P-256 sender keypair (RFC 8291 §3: per-message). */
function generateSender(random: RandomPort): SenderKeys {
  const ecdh = createECDH(CURVE);
  // `setPrivateKey` with 32 random bytes seeds a valid scalar; the public point follows.
  ecdh.setPrivateKey(random(32));
  return { asPrivate: ecdh.getPrivateKey(), asPublic: ecdh.getPublicKey() };
}

/** ECDH(as_private, ua_public) → the 32-octet shared secret (RFC 8291 §3.1). */
function ecdhSharedSecret(sender: SenderKeys, uaPublic: Buffer): Buffer {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(sender.asPrivate);
  return ecdh.computeSecret(uaPublic);
}

/**
 * RFC 8291 §3.4 key derivation: combine the ECDH shared secret with the auth secret, then
 * derive the 16-octet content encryption key (CEK) and 12-octet nonce. Exposed (with the
 * intermediate `salt`/sender keys) so the RFC 8291 Appendix A test vectors can be checked
 * byte-for-byte. Pure and total.
 */
export function deriveEncryptionKeys(args: {
  uaPublic: Buffer;
  authSecret: Buffer;
  asPrivate: Buffer;
  asPublic: Buffer;
  salt: Buffer;
}): { cek: Buffer; nonce: Buffer } {
  const ecdhSecret = ecdhSharedSecret({ asPrivate: args.asPrivate, asPublic: args.asPublic }, args.uaPublic);
  // HKDF-Extract(salt=auth_secret, IKM=ecdh_secret).
  const prkKey = hmac(args.authSecret, ecdhSecret);
  // HKDF-Expand(PRK_key, "WebPush: info" || 0x00 || ua_public || as_public, 32) — single block.
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info", "ascii"),
    Buffer.from([0x00]),
    args.uaPublic,
    args.asPublic,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([0x01])]));
  // HKDF-Extract(salt, IKM).
  const prk = hmac(args.salt, ikm);
  // CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm" || 0x00, 16) — first 16 bytes.
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm", "ascii"), Buffer.from([0x00]), Buffer.from([0x01])])).subarray(0, 16);
  // NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce" || 0x00, 12) — first 12 bytes.
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce", "ascii"), Buffer.from([0x00]), Buffer.from([0x01])])).subarray(0, 12);
  return { cek, nonce };
}

export interface EncryptOptions {
  /** The cleartext to deliver (already serialised — JSON for a notification payload). */
  plaintext: Buffer;
  /** The destination subscription's key material. */
  keys: SubscriptionKeys;
  /** Injected randomness so the test is deterministic; defaults to `crypto.randomBytes`. */
  random?: RandomPort;
  /** Fixed salt (test only); generated randomly by default. */
  salt?: Buffer;
  /** Fixed ephemeral sender scalar (test only); generated randomly by default. */
  senderPrivate?: Buffer;
}

/**
 * Encrypt `plaintext` for one subscription under RFC 8291's `aes128gcm` content coding
 * (RFC 8188 framing): a fresh ephemeral sender key + random salt derive the CEK/nonce, the
 * single record is padded with the 0x02 delimiter and sealed with AES-128-GCM, and the
 * 86-octet header (salt || rs || idlen || sender-public) is prepended. Returns the exact
 * POST body to send to the push-service endpoint.
 */
export function encryptWebPushPayload(opts: EncryptOptions): Buffer {
  const random = opts.random ?? randomBytes;
  const salt = opts.salt ?? random(SALT_LENGTH);
  const sender: SenderKeys =
    opts.senderPrivate !== undefined
      ? (() => {
          const ecdh = createECDH(CURVE);
          ecdh.setPrivateKey(opts.senderPrivate!);
          return { asPrivate: ecdh.getPrivateKey(), asPublic: ecdh.getPublicKey() };
        })()
      : generateSender(random);
  if (opts.keys.uaPublic.length !== 65 || opts.keys.uaPublic[0] !== 0x04) {
    throw new Error("subscription p256dh must be the 65-octet uncompressed P-256 point");
  }
  if (opts.keys.authSecret.length !== 16) {
    // RFC 8291 §2: the auth secret is 16 octets. A wrong-length value still produces a body the
    // push service accepts (it never decrypts), but the browser's decryption then silently fails
    // — validate so a malformed subscription is skipped + logged rather than lost invisibly.
    throw new Error("subscription auth secret must be 16 octets");
  }
  const { cek, nonce } = deriveEncryptionKeys({
    uaPublic: opts.keys.uaPublic,
    authSecret: opts.keys.authSecret,
    asPrivate: sender.asPrivate,
    asPublic: sender.asPublic,
    salt,
  });
  // The single record: plaintext || 0x02 (the padding delimiter; no extra zero padding — the
  // record is smaller than rs). RFC 8291 §4 mandates a single record and delimiter 0x02.
  const record = Buffer.concat([opts.plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce, { authTagLength: GCM_TAG_LENGTH });
  const enc = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([enc, tag]);
  // Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(sender public, 65).
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  const header = Buffer.concat([salt, rs, Buffer.from([sender.asPublic.length]), sender.asPublic]);
  return Buffer.concat([header, ciphertext]);
}

/**
 * Decrypt a {@link encryptWebPushPayload} body using the **subscription's** private key + auth
 * secret (the browser's side of the exchange). Not used in production (the daemon only ever
 * encrypts), but exists so the round-trip — and the RFC 8291 correctness of `encrypt` — is
 * provable in a self-contained test that does not depend on a browser.
 */
export function decryptWebPushPayload(args: {
  body: Buffer;
  keys: { uaPrivate: Buffer; authSecret: Buffer };
}): Buffer {
  const salt = args.body.subarray(0, SALT_LENGTH);
  const idlen = args.body[SALT_LENGTH + 4]!;
  const senderPublic = args.body.subarray(SALT_LENGTH + 5, SALT_LENGTH + 5 + idlen);
  const ciphertext = args.body.subarray(SALT_LENGTH + 5 + idlen);
  // The ECDH shared secret is symmetric: ECDH(ua_private, sender_public) == ECDH(as_private, ua_public).
  const uaEcdh = createECDH(CURVE);
  uaEcdh.setPrivateKey(args.keys.uaPrivate);
  const uaPublic = uaEcdh.getPublicKey();
  const shared = uaEcdh.computeSecret(senderPublic);
  const prkKey = hmac(args.keys.authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info", "ascii"), Buffer.from([0x00]), uaPublic, senderPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([0x01])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm", "ascii"), Buffer.from([0x00]), Buffer.from([0x01])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce", "ascii"), Buffer.from([0x00]), Buffer.from([0x01])])).subarray(0, 12);
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_LENGTH);
  const enc = ciphertext.subarray(0, ciphertext.length - GCM_TAG_LENGTH);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce, { authTagLength: GCM_TAG_LENGTH });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return plain.subarray(0, plain.length - 1); // strip the 0x02 padding delimiter
}
