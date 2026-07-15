/**
 * The **web push** wire shape (ADR-0031/0032, issue #119) — the browser-safe contract for the
 * PWA's native push channel. The daemon (serialize/parse) and the UI (parse/serialize) share
 * this leaf, so a drift is a compile error, not a silent mis-subscribe.
 *
 * Three routes:
 *   - `GET  /api/webpush/vapid`        — the VAPID public key the browser needs to subscribe;
 *   - `POST /api/webpush/subscribe`    — register a device's `PushSubscription` (persisted);
 *   - `POST /api/webpush/unsubscribe`  — drop a subscription (the device stopped notifications).
 *
 * Browser-safe like the rest of the leaf (zod only, zero node imports). The subscribe body
 * mirrors the subset of the W3C `PushSubscription.toJSON()` shape the daemon needs to encrypt
 * (RFC 8291): the `endpoint` URL and the `keys.p256dh` / `keys.auth` secrets.
 */
import { z } from "zod";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 === 1) {
    return null;
  }
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const ch of value) {
    const code = BASE64URL_ALPHABET.indexOf(ch);
    if (code === -1) {
      return null;
    }
    buffer = (buffer << 6) | code;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  if (offset !== bytes.length || buffer !== 0) {
    return null;
  }
  return bytes;
}

/** A fully-qualified push-service URL to POST encrypted payloads to. */
const endpointUrl = z
  .string()
  .min(1, "endpoint is required")
  .url("endpoint must be a fully-qualified URL")
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:";
    } catch {
      return false;
    }
  }, "endpoint must use https://");

const subscriptionPublicKey = z
  .string()
  .min(1, "keys.p256dh is required")
  .refine((value) => {
    const bytes = decodeBase64Url(value);
    return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
  }, "keys.p256dh must be a base64url-encoded 65-octet uncompressed P-256 public key");

const authSecret = z
  .string()
  .min(1, "keys.auth is required")
  .refine((value) => {
    const bytes = decodeBase64Url(value);
    return bytes !== null && bytes.length === 16;
  }, "keys.auth must be a base64url-encoded 16-octet authentication secret");

/** The uncompressed (65-octet, `0x04`-prefixed) base64url P-256 application-server public key. */
const vapidApplicationServerKey = z
  .string()
  .min(1, "publicKey is required when push is enabled")
  .refine((value) => {
    const bytes = decodeBase64Url(value);
    return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
  }, "publicKey must be a base64url-encoded 65-octet uncompressed P-256 public key");

/**
 * The `GET /api/webpush/vapid` response: whether push is configured, and the uncompressed
 * P-256 application-server public key (base64url) the browser passes to
 * `pushManager.subscribe({ applicationServerKey })`.
 *
 * Discriminated on `enabled` so the impossible state — `enabled: true` with no key, or
 * `enabled: false` carrying one — cannot be represented: `enabled: false` (no VAPID key wired)
 * pairs with `publicKey: null` and the UI hides the subscribe affordance; `enabled: true`
 * guarantees a valid 65-octet key the browser feeds straight to `subscribe`.
 */
export const vapidPublicKeyResponseSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false), publicKey: z.null() }).strict(),
  z.object({ enabled: z.literal(true), publicKey: vapidApplicationServerKey }).strict(),
]);
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>;

/**
 * The `POST /api/webpush/subscribe` request body — the browser's `PushSubscription.toJSON()`,
 * narrowed to the fields the daemon needs. `keys.p256dh` (base64url uncompressed P-256) and
 * `keys.auth` (base64url 16 octets) are the per-device secrets the daemon encrypts payloads to.
 */
export const subscribeRequestBodySchema = z
  .object({
    endpoint: endpointUrl,
    keys: z
      .object({
        p256dh: subscriptionPublicKey,
        auth: authSecret,
      })
      .strict(),
  })
  .strict();
export type SubscribeRequestBody = z.infer<typeof subscribeRequestBodySchema>;

/** The `POST /api/webpush/subscribe` response: confirmation + the persisted endpoint echoed. */
export const subscribeResponseSchema = z
  .object({
    ok: z.literal(true),
    endpoint: z.string(),
  })
  .strict();
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;

/** The `POST /api/webpush/unsubscribe` request body — the endpoint to drop. */
export const unsubscribeRequestBodySchema = z
  .object({
    endpoint: endpointUrl,
  })
  .strict();
export type UnsubscribeRequestBody = z.infer<typeof unsubscribeRequestBodySchema>;

/** The `POST /api/webpush/unsubscribe` response: confirmation (ok even if already gone). */
export const unsubscribeResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type UnsubscribeResponse = z.infer<typeof unsubscribeResponseSchema>;
