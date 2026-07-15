/**
 * Web-push dispatcher (issue #119): proves the fire-and-forget delivery edge — each
 * notification is encrypted end-to-end to every subscription (the test decrypts with the
 * device's private key to recover the payload), and dead subscriptions are pruned on 404/410.
 */
import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../log/logger";
import type { PushSubscription } from "../store/types";
import {
  resolveVapidIdentity,
  toWebPushPayload,
  WebPushDispatcher,
  type WebPushFetchPort,
} from "./webpush";
import { decryptWebPushPayload } from "./webpush-crypto";
import type { NotificationRequest } from "./types";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

/** A freshly-generated, self-consistent subscription (with its private key kept for decrypt). */
function freshSubscription(): { sub: PushSubscription; uaPrivate: Buffer; authSecret: Buffer } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const uaPrivate = ecdh.getPrivateKey();
  const authSecret = randomBytes(16);
  return {
    sub: {
      endpoint: "https://fcm.googleapis.com/fcm/send/" + randomBytes(8).toString("hex"),
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    },
    uaPrivate,
    authSecret,
  };
}

const vapid = resolveVapidIdentity({
  privateKeyScalarB64url: randomBytes(32).toString("base64url"),
  subject: "mailto:operator@example.com",
});

const REQUEST: NotificationRequest = {
  kind: "escalation",
  severity: "high",
  title: "Escalation on o/r#42",
  message: "Should we ship the flux capacitor?",
  repo: "o/r",
  issueNumber: 42,
  at: "2026-06-23T00:00:00.000Z",
};

describe("toWebPushPayload", () => {
  it("maps the notification fields verbatim", () => {
    const p = toWebPushPayload(REQUEST);
    expect(p).toEqual({
      kind: "escalation",
      severity: "high",
      title: "Escalation on o/r#42",
      message: "Should we ship the flux capacitor?",
      repo: "o/r",
      issue: 42,
      at: "2026-06-23T00:00:00.000Z",
    });
  });
});

describe("WebPushDispatcher", () => {
  it("encrypts the payload end-to-end to every subscription (decrypts with the device key)", async () => {
    const a = freshSubscription();
    const b = freshSubscription();
    const posted: { url: string; body: Uint8Array; headers: Record<string, string> }[] = [];
    const fetch: WebPushFetchPort = async (url, init) => {
      posted.push({ url, body: init.body, headers: init.headers });
      return new Response(null, { status: 200 });
    };
    const d = new WebPushDispatcher({
      vapid,
      subscriptions: () => [a.sub, b.sub],
      deleteSubscription: () => {},
      logger,
      fetch,
    });
    d.dispatch([REQUEST]);
    expect(posted).toHaveLength(2);
    // Each POST went to its subscription endpoint with the VAPID + aes128gcm headers.
    for (const p of posted) {
      expect(p.headers["content-encoding"]).toBe("aes128gcm");
      expect(p.headers["authorization"]).toMatch(/^vapid t=eyJ[\s\S]+\.eyJ[\s\S]+\.[\s\S]+,k=[\w-]+$/);
      expect(p.headers["ttl"]).toBe("2419200");
    }
    // Decrypt each body with the matching device key and recover the payload JSON.
    const payloads = [a, b].map((dev, i) =>
      JSON.parse(
        decryptWebPushPayload({ body: Buffer.from(posted[i]!.body), keys: { uaPrivate: dev.uaPrivate, authSecret: dev.authSecret } }).toString("utf8"),
      ),
    );
    expect(payloads[0].message).toBe("Should we ship the flux capacitor?");
    expect(payloads[1].title).toBe("Escalation on o/r#42");
    expect(payloads[0].issue).toBe(42);
  });

  it("prunes a subscription on 404 and 410 (RFC 8030 §5: no longer valid)", async () => {
    const dead = freshSubscription();
    const alive = freshSubscription();
    let status = 404;
    const fetch: WebPushFetchPort = async () => new Response(null, { status: (status = status === 404 ? 410 : 404) });
    const deleted: string[] = [];
    const d = new WebPushDispatcher({
      vapid,
      subscriptions: () => [dead.sub, alive.sub],
      deleteSubscription: (ep) => {
        deleted.push(ep);
      },
      logger,
      fetch,
    });
    d.dispatch([REQUEST]);
    await Promise.resolve(); // microtask: the detached .then runs
    await new Promise((r) => setImmediate(r));
    // Both responses were non-2xx terminal (404 then 410) → both pruned.
    expect(deleted).toContain(dead.sub.endpoint);
    expect(deleted).toContain(alive.sub.endpoint);
  });

  it("does NOT prune on a 200 or a 5xx", async () => {
    const sub = freshSubscription();
    const statuses = [200, 500, 429];
    let i = 0;
    const fetch: WebPushFetchPort = async () => new Response(null, { status: statuses[i++ % statuses.length] });
    const deleted: string[] = [];
    const d = new WebPushDispatcher({ vapid, subscriptions: () => [sub], deleteSubscription: (ep) => deleted.push(ep), logger, fetch });
    d.dispatch([REQUEST]);
    await new Promise((r) => setImmediate(r));
    expect(deleted).toEqual([]);
  });

  it("no-ops with no subscriptions", () => {
    const fetch = vi.fn();
    const d = new WebPushDispatcher({ vapid, subscriptions: () => [], deleteSubscription: () => {}, logger, fetch: fetch as unknown as WebPushFetchPort });
    d.dispatch([REQUEST]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips a subscription whose keys do not decode, keeps dispatching the rest", async () => {
    const bad: PushSubscription = { endpoint: "https://push/bad", p256dh: "not-valid-base64-^^^^", auth: "x" };
    const good = freshSubscription();
    const posted: string[] = [];
    const fetch: WebPushFetchPort = async (url) => {
      posted.push(url);
      return new Response(null, { status: 200 });
    };
    const d = new WebPushDispatcher({ vapid, subscriptions: () => [bad, good.sub], deleteSubscription: () => {}, logger, fetch });
    d.dispatch([REQUEST]); // must not throw
    await new Promise((r) => setImmediate(r));
    expect(posted).toEqual([good.sub.endpoint]);
  });
});

describe("resolveVapidIdentity", () => {
  it("rejects a private key that is not a 32-octet scalar", () => {
    expect(() => resolveVapidIdentity({ privateKeyScalarB64url: randomBytes(16).toString("base64url"), subject: "mailto:x@y" })).toThrow(/32 octets/);
  });
});
