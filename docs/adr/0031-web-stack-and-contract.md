# Web stack & the browser-safe contract leaf

> Part of the web-control-plane design of record (legacy epic 106); see
> [ADR-0029](0029-embedded-web-control-plane.md) for the process model and
> [ADR-0032](0032-web-exposure-and-writes.md) for exposure/writes.

The control plane needs a frontend stack and a way to keep client and server wire
shapes from drifting — without a heavyweight schema-codegen pipeline, and without the
UI accidentally pulling Node-only code into the browser bundle.

## Decision

**Frontend:** Vite + React + TypeScript + Tailwind + shadcn/ui + TanStack
Query/Router, built static and daemon-served, in an `npm` **workspace** at `web/`.

- A single `npm install` at the repo root installs both toolchains (the daemon and the
  `web/` workspace). `npm run build` builds the daemon (`tsc`) **and** the UI
  (`vite build`) and **fails if the UI build fails** — the UI is part of the
  **build gate** (ADR-0018) so a self-update ships it atomically and the daemon never
  serves a stale frontend.
- **Design-tokens + primitives first.** A dark-first (light available) token set in
  CSS variables — a *fresh* palette, not the TUI's — including a **semantic status
  palette mapped to the label state machine** (DESIGN §9: eligible / running / waiting
  / attention / danger / success). A shadcn-based primitives layer (`components/ui`) is
  established before any feature component, so nothing is one-off styled.
- **App shell first.** Aggregate-first navigation (capacity is one shared global build
  budget — ADR-0020 — so the views are only meaningful aggregate) with **repo as a
  filter**, and a **⌘K command palette**.

**API:** REST + a shared zod contract + (later) one SSE stream. **SSE over WebSocket**
— push-only, auto-reconnecting, no upgrade handshake; writes are ordinary `POST`.

### The contract leaf (the client/server seam)

Wire shapes live in a **browser-safe contract leaf** (`src/web/contract`) imported by
**both** the daemon (server) and the UI (via the `@contract` alias). It is plain data
+ zod, and a drift between the two sides is a **compile error**, not a runtime 404.

This leaf is a **discipline boundary**: it must import **nothing from Node** — only
`zod` and its own files. A transitive `node:*`/core-module import anywhere in the
browser graph (the leaf or the UI) is turned into a **hard Vite build error** by the
`forbid-node-builtins` plugin in `web/vite.config.ts` (scoped to first-party code, so a
third-party dep's legitimate node fallback isn't penalised). Node-only code lives in
`src/web/server` instead. This boundary is verified in CI-by-construction: adding a
`node:fs` import to the leaf fails `npm run build`.

## Why these choices

- **Vite/React/Tailwind/shadcn/TanStack** is a mainstream, well-documented stack; a
  prospective public user recognises and trusts it, and contributors are productive.
- **Shared zod over codegen** reuses a dependency the daemon already pins (ADR-0010,
  zod v4) and makes the type seam ordinary TypeScript — no schema build step.
- **A workspace (not a separate repo/deploy)** is what lets one `npm install` / one
  build gate cover both toolchains, which is the whole point of the embedded model.

## Consequences

- The daemon once carried its own React 17 toolchain for the Ink TUI alongside the
  web's React 18. Now that the Ink TUI is retired (legacy issue 120), the React 17 dep is gone too;
  React lives only in the `web/` workspace, and first-party UI code resolves React 18.
- `web/dist` is a build artifact (git-ignored); the build gate regenerates it, and the
  embedded server serves it.
