# Embedded web control plane: an in-process HTTP server, not a sidecar

> Design of record for the web control plane (legacy epic 106). Numbered to match the
> epic's references (ADR-0029 embedded control plane, ADR-0031 stack & contract,
> ADR-0032 exposure & writes); ADR-0030 — daemon-owned transcripts — is reserved
> for the transcript-capture slice. The 0029 number is shared with the
> github-rate-limit ADR, consistent with the repo's existing duplicate-number ADRs.

The operator's only window into the daemon was the Ink TUI (`ralph-monitor`): a
read-only, single-screen, terminal-bound SQLite poller. It cannot show history, let
the operator read what an agent actually *did*, stream a live run, or answer
escalations (that is a separate CLI). The repo is going public, so the bar is an
enterprise-grade operator UI. The question is *where the UI's server lives*.

## Decision

**The control plane is an HTTP (+ SSE, later slices) server embedded in the daemon
process — not a sidecar, not Next.js.**

This is *forced* by the live requirement: only an in-process reader can observe
event-log appends as they commit and reach the in-process `SDKMessage` stream. A
sidecar would have to re-poll SQLite or invent an IPC channel for both; an in-process
edge module gets them for free.

- **Read endpoints are a thin serialization edge** over existing pure functions —
  `buildSnapshot` and the event-log projections — adding no decision logic.
  `projection/snapshot.ts` is **kept and reused**; only the Ink rendering + `bin/ralph-monitor`
  are retired (a late slice).
- **Live updates** (slice 2) ride an in-process after-commit emitter on the event-log
  append path, fanned out to **SSE** subscribers, with `global_position` cursor
  catch-up on reconnect. No polling.
- It **serves the built SPA statically** (ADR-0031), same-origin with the API.

## The isolation contract (binding)

The web layer is an **edge**, never on the daemon's critical path:

- **The reconcile tick never `await`s the web layer.** The server is started once at
  daemon startup and stopped after the loop has drained; the tick loop holds no
  reference to it. A web fault cannot wedge reconciliation.
- **The web layer depends only on ports** (`WebControlPlanePorts`) — pure reads. It
  never reaches into the reconciler, store, or SDK sessions directly. New capability
  is an additive port, never a reach-in.
- **Startup/shutdown are unaffected.** `startWebControlPlane` never throws — a bind
  failure (e.g. port in use) is logged and the daemon runs on headless. The server
  socket is `unref`'d so it never holds the process open past a drain, and `--drain`
  (which only signals the running daemon) never touches the web layer at all.
- **Slow clients never back-pressure the daemon** — the live channel is wake-only and
  coalesces signals while consumers re-read from the durable event log by cursor.

## Consequences

- The daemon process owns one more listening socket; on a credential-free box bound
  to loopback (ADR-0032) that is acceptable.
- The UI ships in the daemon's build gate (ADR-0018/0031), so a self-update relaunches
  daemon + UI atomically and never serves a stale frontend.
- Multi-daemon / remote fan-in is explicitly out of scope: co-located, single-operator
  only. The server reads *this* process's state.
