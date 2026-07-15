/**
 * Web push subscription (issue #119): register / unregister this device for native push from
 * the control plane. Mirrors the daemon's three routes — fetch the VAPID public key, subscribe
 * the browser's `PushSubscription`, POST it to the daemon, and unsubscribe the reverse.
 *
 * The daemon encrypts each push to the subscription's own keys (RFC 8291), so only this device
 * can read it; the browser hands the decrypted payload to the service worker's `push` event,
 * which shows the notification (see `public/sw.js`).
 *
 * Same-origin by construction (the SPA is served by the control plane itself), so the browser's
 * automatic `Origin` header clears the Origin guard on the mutating routes (ADR-0032).
 */
import { fetchVapidPublicKey, subscribeWebPush, unsubscribeWebPush } from "@/lib/api";

/** Whether the browser can do web push at all (Push API + service worker in a secure context). */
export function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

/** The resolved push state of this device: support, daemon config, the live subscription, permission. */
export interface PushState {
  supported: boolean;
  /** Whether the daemon has a VAPID identity configured (`notifications.webpush`). */
  enabled: boolean;
  /** Whether this device currently holds an active subscription. */
  subscribed: boolean;
  /** The browser's notification permission state. */
  permission: NotificationPermission;
}

/** Read the device's current push state. Tolerant — a transient SW error degrades to "not subscribed". */
export async function readPushState(): Promise<PushState> {
  if (!isPushSupported()) {
    return { supported: false, enabled: false, subscribed: false, permission: "denied" };
  }
  let enabled = false;
  try {
    enabled = (await fetchVapidPublicKey()).enabled;
  } catch {
    enabled = false;
  }
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    subscribed = !!(await reg.pushManager.getSubscription());
  } catch {
    subscribed = false;
  }
  return { supported: true, enabled, subscribed, permission: Notification.permission };
}

/** Convert the base64url VAPID public key to the Uint8Array `pushManager.subscribe` expects. */
function base64UrlToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

/**
 * Subscribe this device: request notification permission, create the `PushSubscription` with the
 * daemon's VAPID key, and POST it to the daemon (where it persists). Idempotent — a device that is
 * already subscribed is a no-op. Throws with a plain message on any failure (denied permission,
 * push not configured, network).
 */
export async function subscribeToPush(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error("This browser does not support web push.");
  }
  const vapid = await fetchVapidPublicKey();
  if (!vapid.enabled) {
    throw new Error("Web push is not configured on the daemon. Set notifications.webpush in .ralph/config.yaml.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(vapid.publicKey) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  await subscribeWebPush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Unsubscribe this device: drop the `PushSubscription` locally + tell the daemon to prune it. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) {
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const endpoint = sub?.endpoint;
  if (sub) {
    await sub.unsubscribe();
  }
  if (endpoint) {
    await unsubscribeWebPush({ endpoint });
  }
}
