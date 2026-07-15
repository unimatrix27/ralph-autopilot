/**
 * The **web-push dispatch edge** (issue #119): delivers the same escalation / anomaly / stall
 * notifications the sink already computes to every persisted push subscription, as a native
 * browser notification. It implements {@link NotificationDispatchPort}, so it is a drop-in
 * peer of the ntfy/webhook {@link NotificationDispatcher} and the sink fans the same
 * `decideNotifications` output to both.
 *
 * The binding contract is identical to the other dispatcher — **fire-and-forget, never block,
 * never throw** — because this too rides the after-commit broadcast channel's microtask drain
 * (ADR-0029). `dispatch` is synchronous and returns the instant every request is *launched*;
 * the network calls are detached promises whose settlement never reaches the caller. A
 * rejecting fetch, a mis-encoded subscription, or a 4xx from a push service is swallowed and
 * logged, and one bad subscription never stops the others (per-subscription isolation). A
 * 404/410 from a push service means the subscription has expired (RFC 8030 §5), so it is pruned.
 *
 * The notification payload is RFC 8291-encrypted end-to-end with each subscription's own keys,
 * so only that device (never the push service) can read it. The VAPID JWT (RFC 8292) identifies
 * the daemon to the push service; the daemon resolves its long-lived VAPID private key from the
 * configured env-var NAME (ADR-0034), so the key never lives in config or the log.
 */
import type { Logger } from "../log/logger";
import type { KeyObject } from "node:crypto";
import { toNotificationEgressPayload, type NotificationEgressPayload } from "./format";
import type { NotificationDispatchPort } from "./sink";
import type { NotificationRequest } from "./types";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptWebPushPayload,
  signVapidJwt,
  vapidPrivateKeyObject,
  vapidPublicKeyFromScalar,
} from "./webpush-crypto";

/** The fetch-init shape the dispatcher passes (a binary body — the encrypted payload). */
export interface WebPushFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A minimal `fetch`-shaped port for one encrypted POST to a push-service endpoint. */
export type WebPushFetchPort = (url: string, init: WebPushFetchInit) => Promise<Response>;

/**
 * The daemon's resolved VAPID identity: a private ECDSA P-256 key (for signing the per-request
 * JWT), the matching uncompressed public key (served to the browser + sent as the VAPID `k=`),
 * and the contact `subject` (`mailto:`/`https:`). Built once from the env-var NAME in config.
 */
export interface VapidIdentity {
  privateKey: KeyObject;
  /** The uncompressed (65-octet) public point, base64url — the browser's `applicationServerKey`. */
  publicKey: string;
  subject: string;
}

/**
 * Build the {@link VapidIdentity} from the base64url 32-octet VAPID private scalar + contact
 * subject. Throws on a scalar that is not a valid 32-octet base64url P-256 private key — the
 * caller (the daemon) treats that as a wiring fault and runs un-paged, the sink contract.
 */
export function resolveVapidIdentity(args: { privateKeyScalarB64url: string; subject: string }): VapidIdentity {
  const scalar = base64UrlDecode(args.privateKeyScalarB64url);
  if (scalar.length !== 32) {
    throw new Error(`VAPID private key must decode to 32 octets (got ${scalar.length})`);
  }
  const publicUncompressed = vapidPublicKeyFromScalar(scalar);
  return {
    privateKey: vapidPrivateKeyObject(scalar),
    publicKey: base64UrlEncode(publicUncompressed),
    subject: args.subject,
  };
}

/** The JSON payload delivered (encrypted) to the service worker's `push` event. */
export type WebPushPayload = NotificationEgressPayload;

/** Build the payload for one notification, redacting the free-text (it transits a push service). */
export function toWebPushPayload(r: NotificationRequest): WebPushPayload {
  return toNotificationEgressPayload(r, r.message);
}

/** The browser subscription fields the notification edge needs to encrypt and deliver a push. */
export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushDispatcherDeps {
  /**
   * The resolved VAPID identity. The boundary owns the invariant: the daemon only constructs a
   * dispatcher once it has a real identity (web push enabled + a key resolved), so this is never
   * `null` here — a misconfigured daemon simply never builds the dispatcher.
   */
  vapid: VapidIdentity;
  /** Read every subscription in the fan-out set. */
  subscriptions: () => WebPushSubscription[];
  /** Prune a subscription whose push service returned 404/410 (expired). */
  deleteSubscription: (endpoint: string) => void;
  /** Structured logger for best-effort dispatch diagnostics (never fatal). */
  logger: Logger;
  /** The fetch port; defaults to the node-global `fetch` (resolved lazily at dispatch). */
  fetch?: WebPushFetchPort;
  /** Injected clock for a deterministic VAPID `exp`; defaults to the system clock. */
  now?: () => Date;
}

/**
 * Push each notification to every subscription, fire-and-forget. Never throws, never blocks. No
 * subscriptions or no `fetch` available no-op cleanly (logged once per dispatch where useful), so
 * a misconfiguration never surfaces to the tick.
 */
export class WebPushDispatcher implements NotificationDispatchPort {
  private readonly vapid: VapidIdentity;
  private readonly subscriptions: () => WebPushSubscription[];
  private readonly deleteSubscription: (endpoint: string) => void;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly fetch: WebPushFetchPort | null;

  constructor(deps: WebPushDispatcherDeps) {
    this.vapid = deps.vapid;
    this.subscriptions = deps.subscriptions;
    this.deleteSubscription = deps.deleteSubscription;
    this.logger = deps.logger;
    this.now = deps.now ?? ((): Date => new Date());
    this.fetch = deps.fetch ?? null;
  }

  dispatch(requests: NotificationRequest[]): void {
    if (requests.length === 0) {
      return;
    }
    const subs = this.subscriptions();
    if (subs.length === 0) {
      return;
    }
    const fetch = this.fetch ?? resolveGlobalFetch();
    if (fetch === null) {
      this.logger.warn("notify.no-fetch", { channel: "webpush", count: requests.length, subscriptions: subs.length });
      return;
    }
    for (const r of requests) {
      for (const sub of subs) {
        this.launch(r, sub, fetch);
      }
    }
  }

  /** Encrypt + fire one POST to a subscription endpoint; swallow any throw or rejection. */
  private launch(r: NotificationRequest, sub: WebPushSubscription, fetch: WebPushFetchPort): void {
    const vapid = this.vapid;
    let body: Uint8Array;
    try {
      const uaPublic = base64UrlDecode(sub.p256dh);
      const authSecret = base64UrlDecode(sub.auth);
      body = encryptWebPushPayload({
        plaintext: Buffer.from(JSON.stringify(toWebPushPayload(r)), "utf8"),
        keys: { uaPublic, authSecret },
      });
    } catch (err) {
      // A mis-encoded subscription (bad p256dh/auth) — skip it, but keep dispatching the rest.
      this.logger.warn("notify.push-encode-failed", { endpointHost: hostnameOf(sub.endpoint), error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const aud = originOf(sub.endpoint);
    let authHeader: string;
    try {
      const jwt = signVapidJwt({ privateKey: vapid.privateKey, aud, sub: vapid.subject, now: this.now });
      authHeader = `vapid t=${jwt},k=${vapid.publicKey}`;
    } catch (err) {
      this.logger.warn("notify.push-vapid-failed", { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const init: WebPushFetchInit = {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: "2419200",
        authorization: authHeader,
      },
      body,
    };
    let pending: Promise<Response>;
    try {
      pending = fetch(sub.endpoint, init);
    } catch {
      this.logger.warn("notify.push-failed", { kind: r.kind, endpointHost: hostnameOf(sub.endpoint), failure: "fetch-threw" });
      return;
    }
    // Detached: the settlement never reaches the caller (the broadcast drain / tick).
    void pending
      .then(async (res) => {
        await drain(res);
        if (res.status === 404 || res.status === 410) {
          // The push service reports the subscription no longer exists (RFC 8030 §5) — prune it.
          try {
            this.deleteSubscription(sub.endpoint);
          } catch (err) {
            this.logger.warn("notify.push-prune-failed", { error: err instanceof Error ? err.message : String(err) });
          }
          this.logger.info("notify.push-subscription-expired", { kind: r.kind, endpointHost: hostnameOf(sub.endpoint), status: res.status });
        } else if (!res.ok) {
          this.logger.warn("notify.push-failed", { kind: r.kind, endpointHost: hostnameOf(sub.endpoint), status: res.status });
        }
      })
      .catch(() => {
        this.logger.warn("notify.push-failed", { kind: r.kind, endpointHost: hostnameOf(sub.endpoint), failure: "fetch-rejected" });
      });
  }
}

/** Resolve the node-global `fetch` lazily (at dispatch time), or `null` if none is present. */
function resolveGlobalFetch(): WebPushFetchPort | null {
  return typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as WebPushFetchPort) : null;
}

/** The push-service origin for a subscription endpoint (the VAPID `aud`); falls back to the raw URL. */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Consume the response body so the underlying socket returns to the pool (no connection leak). */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* best-effort: a read fault here does not change the status decision */
  }
}
