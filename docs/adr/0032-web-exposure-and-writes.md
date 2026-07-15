# Web control plane: exposure & writes

> Part of the web-control-plane design of record (legacy epic 106); see
> [ADR-0029](0029-embedded-web-control-plane.md) (process model) and
> [ADR-0031](0031-web-stack-and-contract.md) (stack & contract).

The control plane must be reachable from a laptop or phone (the operator's real
relationship to the daemon is check-in-driven), yet the box runs agents under
`bypassPermissions` — "the box is the blast radius" (OPERATING.md). It must not become
a new way to attack the daemon, and writes must not let a random web page act as the
operator's daemon.

## Decision

**Bind loopback by default; reach it over Tailscale; guard writes against cross-site
requests; reserve an auth seam.**

- **Loopback by default.** The server binds `127.0.0.1` unless configured otherwise.
  The bind `host` is configurable but **never `0.0.0.0` by default**; binding to a
  non-loopback address is permitted but emits a loud **exposure warning** at startup.
- **Tailscale is the identity boundary.** A single-user tailnet *is* the
  authentication — the operator reaches the loopback service over their tailnet from
  their own devices. There is **no managed auth, multi-user, or RBAC** (out of scope).
- **Origin guard on mutating routes.** Confused-deputy hygiene: even on loopback, a
  browser tab on any website can issue a cross-site `POST` to
  `http://127.0.0.1:<port>`. Unsafe-method requests (`POST`/`PUT`/`PATCH`/`DELETE`) are
  rejected unless the `Origin` is same-origin (matches the request `Host`) or in a
  configured allowlist. A request with no `Origin` (a non-browser client / the CLI) is
  allowed. The decision is a **pure predicate** (`isOriginAllowed`), wired in front of
  every mutating route — so the first write route (slice 5) is protected by
  construction. (The foundations slice ships no mutating routes; the guard is a
  wired-but-idle seam.)
- **Reserved auth-middleware seam.** A pluggable `AuthMiddleware` sits in front of the
  API; the default is allow-all (Tailscale is the boundary). Anyone exposing the plane
  beyond loopback/tailnet can drop in real auth without touching the server core.

## Write scope (sliced; later)

All writes are **eventually-consistent via the reconciler**, so the UI is a *control
surface*, not a second source of truth:

- **Answers** reuse `RalphAnswerService` (slice 5).
- **Tier-1 GitHub label effects** — re-admit / close / `mode:*` / priority /
  pause-unpause — applied by the reconciler next tick (destructive ones confirm).
- **Tier-2 daemon control** — drain / force-tick / kill-run — via a new
  `DaemonControl` port the orchestrator implements (plus a `runId → AbortController`
  registry for kill-run).

## Why not managed auth / public binding

A single-operator, co-located tool gated by Tailscale + loopback gets device-level
identity for free; bolting on OAuth/RBAC would be cost with no benefit for the actual
deployment. The seams (auth middleware, allowlist, exposure warning) keep the door open
for anyone who *does* expose it, without making the common case heavier.

## Consequences

- The default deployment is unauthenticated *by design*, safe only because it is
  loopback + tailnet on a credential-free box (OPERATING.md). The exposure warning and
  the reserved seam make a riskier configuration a conscious operator choice.
- Writes never bypass the reconciler, so the completeness invariant (ADR-0016) still
  holds: the UI cannot silently lose or strand an issue.

## Operator runbook

The how-to that follows from this decision — loopback-default bind, the Origin guard,
reaching the UI remotely over `tailscale serve` / an SSH tunnel, and the
"bind beyond loopback ⇒ TLS-terminating reverse proxy + auth in front" steps — lives in
[OPERATING.md §6 — Exposing the web control plane](../OPERATING.md#6-exposing-the-web-control-plane-the-exposure-runbook).
