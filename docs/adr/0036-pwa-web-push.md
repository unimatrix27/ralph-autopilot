# Installable PWA + web push for the control plane

> Part of the web-control-plane design of record (legacy epic 106); builds on the
> notification sink (legacy issue 117 / ADR-0029's second broadcast subscriber). See
> [ADR-0029](0029-embedded-web-control-plane.md) (process model),
> [ADR-0031](0031-web-stack-and-contract.md) (stack & contract), and
> [ADR-0032](0032-web-exposure-and-writes.md) (exposure & writes).

## Context

The notification sink (legacy issue 117) pages the operator out-of-app over ntfy/webhook when the
daemon needs them and the UI is not open. But that needs a *separate* notification app (ntfy,
Slack). The control plane is already the operator's real relationship to the daemon, and it is
reached from a phone — the natural delivery target is therefore a **native browser/web push**
notification, not another feed.

Issue legacy issue 119 asks for two things: make the SPA an **installable PWA** (manifest + service worker,
loads an offline shell), and add **web push** so escalations / anomalies / stalls arrive as
native notifications — "another delivery target for the same escalation / anomaly / stall
events."

## Decision

**Web push is a new *channel* of the existing notification sink, not a parallel pipeline.** The
sink already computes which events notify via the pure `decideNotifications` and fans the result
to dispatchers; a `WebPushDispatcher` is added alongside the ntfy/webhook
`NotificationDispatcher` behind a `CompositeNotificationDispatcher`, so push reuses the sink's
decision and isolation contract for free (ADR-0029: fire-and-forget, never blocks the tick,
never throws).

- **Payloads are RFC 8291-encrypted on Node's built-in `crypto` — no dependency.** The control
  plane is already built on Node builtins (`http`, no web framework); web-push crypto (ECDH
  P-256, HKDF, AES-128-GCM/aes128gcm, RFC 8292 VAPID JWT/ES256) is implemented by hand in
  `notify/webpush-crypto.ts` and proven byte-for-byte against the **RFC 8291 Appendix A test
  vectors** (CEK, nonce, header, ciphertext). A self-rolled round-trip is not proof of browser
  compatibility; matching the published test vectors is.
- **The VAPID private key is a credential read from an env var by NAME** (`notifications.webpush.privateKeyEnv`),
  following the ADR-0034 precedent — config never carries a secret, and the public key is
  *derived* from the private one and served to the browser at `/api/webpush/vapid`. The same
  resolved identity signs pushes and answers the vapid endpoint, so a device subscribes with the
  very key that signs its pushes.
- **Subscriptions are durable runtime state in SQLite** (a new `push_subscriptions` table).
  Unlike run state they are *not* rebuildable from GitHub (a subscription lives until the device
  unsubscribes), so this is one of the few rows that genuinely must persist — exactly what the
  runtime store is for. A push rejected 404/410 (RFC 8030 §5) prunes the row.
- **The PWA shell + push delivery live in a hand-written service worker** (`web/public/sw.js`),
  served verbatim from the origin root for scope `/`. It precaches the app shell (offline
  load), shows a `Notification` on `push`, and focuses/opens the app on `notificationclick`. It
  is plain ES5 — no bundler, no imports — so its URL and shape are stable across builds.

## Why a sink channel, not a separate edge

A second push pipeline would duplicate the event → notification decision, the after-commit
subscription, the stall probe, and the isolation wiring — all of which the sink already owns and
matrix-tests. Treating web push as one more `NotificationDispatchPort` reuses all of it and keeps
a single "what pages the operator" decision in `decideNotifications`. The composite is the only
new wiring, and it is trivial (fan the same batch, isolate each dispatcher).

## Why hand-rolled crypto, not `web-push`

Consistency with the daemon's dependency-light stance (Node builtins, no web framework), plus a
deterministic correctness proof: the published RFC 8291 test vectors pin the output exactly,
which a third-party wrapper would hide. The cost (~200 lines, exhaustively tested) is paid once.

## Consequences

- Push requires `notifications.enabled: true` (the sink must run); `notifications.endpoints: []`
  with `notifications.webpush.enabled: true` is a valid push-only setup.
- PWA install + push require a **secure context** (HTTPS or localhost). The exposure runbook's
  `tailscale serve` (HTTPS) and SSH-tunnel-to-localhost paths already provide one; a raw
  `http://<tailnet-ip>` URL does not (service workers/Push are disabled). See OPERATING.md §6.
- The daemon never trusts a push payload's plaintext to carry authority — push is a *nudge*; the
  Inbox / run viewer remain the source of truth for acting on an escalation (ADR-0032: writes
  are eventually-consistent via the reconciler).
