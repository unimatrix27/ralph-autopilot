# Web control-plane contract leaf (ADR-0031)

The single client/server type seam for the embedded web control plane. Every wire
shape (request/response bodies, the SSE event envelope to come, route paths) lives
here as a **zod** schema plus its inferred TypeScript type, and is imported by
**both** sides:

- the daemon (`src/web/server/`) — to validate/serialize responses, and
- the UI (`web/`, via the `@contract` alias) — to type fetches and parse payloads.

Because the same module is compiled into the browser bundle, this leaf is a
**discipline boundary**: it must import **nothing from Node** — only `zod` and other
files in this directory. A transitive `node:*` (or core-module) import here breaks
the Vite build by design (the `forbid-node-builtins` plugin in `web/vite.config.ts`
turns it into a hard error). Keep it pure data + zod; push anything that needs `fs`,
`path`, `http`, etc. to `src/web/server/`.
