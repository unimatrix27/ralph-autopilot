# web — the embedded control-plane SPA

The operator UI for the ralph-autopilot daemon (legacy epic 106; ADR-0029/0031/0032). Vite +
React + TypeScript + Tailwind + shadcn/ui + TanStack Query/Router, built static and
**served by the daemon process itself** — not a sidecar, not a separate deployment.

## How it fits

- This is an **npm workspace** of the root `ralph-autopilot` package. A single
  `npm install` at the repo root installs both toolchains; `npm run build` at the
  root builds the daemon (`tsc`) **and** this UI (`vite build`) as a build-gate step
  (ADR-0018/0031) — a failed UI build fails the whole build, so the daemon never
  ships a stale frontend.
- The build output (`web/dist`) is served statically by the daemon's embedded HTTP
  server (`src/web/server`), bound to loopback by default and reached over Tailscale
  (ADR-0032).
- The single client/server type seam is the **browser-safe contract leaf** at
  `src/web/contract`, imported here as `@contract`. It must import nothing from Node;
  the `forbid-node-builtins` plugin in `vite.config.ts` makes a node-builtin import
  anywhere in the browser graph a hard build error (the discipline boundary).

## Develop

```bash
npm run dev        # Vite dev server on :5173, proxying /api to the daemon on :4280
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build → web/dist
```

`npm run dev` expects a daemon running locally (`node dist/bin/ralph-daemon.js`) for
live `/api` data; the shell itself renders without it.

## Layout

- `src/components/ui` — the shadcn primitives layer (button, dialog, command, badge,
  card, separator), established before any feature component.
- `src/lib` — `utils` (cn), `api` (contract-parsed fetchers), `status` (the status
  palette mapped to the label state machine), `nav` (shared nav model), `live` (the
  app-wide SSE feed: one `EventSource` over `/api/live` that merges into the TanStack
  Query cache — transcript lines per agent, plus a coalesced `overview` refresh that
  ticks the live nav badges; ADR-0029, legacy issue 109).
- `src/routes` — the routed pages, including the **Live / Fleet wall** (`live.tsx`):
  one card per running agent, each streaming phase, elapsed, fix-attempt, and the latest
  tool/assistant line, auto-reconnecting on drop.
- `src/index.css` — design tokens (dark-first, light available; `--status-*` palette).
