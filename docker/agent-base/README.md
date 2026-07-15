# L0 — `ralph/agent-base`

The ralph-shipped base image every per-target agent image builds `FROM` (ADR-0038
§"Layered per-target images (L0→L3)"). It carries Node, the `claude` CLI, and the thin
in-container runner (`ralph-runner`) that hosts one agent run inside a container.

- **Definition:** [`/Dockerfile.agent-base`](../../Dockerfile.agent-base) (build context = repo root).
- **Build:** `./docker/agent-base/build.sh [version]` → tags `ralph/agent-base:<version>` + `:latest`.

## What it contains

| Layer | Provides |
| --- | --- |
| `node:24-bookworm` | Node 24 + the python3/build toolchain `npm ci` needs for native addons |
| `git`, `gh` | runner-direct clone/push, PR open/update, `ralph-question` comments (legacy issue 187) |
| `npm ci` | `better-sqlite3` native addon **and** the SDK-vendored `claude` binary the agent spawns |
| `npm run build:daemon` | the compiled `dist/`, incl. the `ralph-runner` entrypoint |
| uid pin | uid 1000 = `ralph`, home `/home/ralph` (so the `:ro` host `~/.claude` is readable — see below) |
| `uv`/`uvx` | generic launcher for python-based stdio MCP servers, if a config def names one (legacy issue 264) |
| `codebase-memory-mcp` | the symbol/structure-navigation MCP server, pinned + checksum-verified (legacy issue 276) |
| npx cache warm | `morph-mcp` + `context7` start as cache hits, not registry fetches (legacy issue 269) |

## Version history

- **0.0.4** — serena uvx cache-warm dropped; `codebase-memory-mcp` v0.9.0 baked
  (checksum-verified, `auto_index` on) as its replacement (legacy issue 276).
- **0.0.3** — ships the legacy issue 273 runner (containerized rebase-conflict resolution).
- **0.0.2** — npx cache warmed for `morph-mcp` + `context7` (legacy issue 269).
- **0.0.1** — uv/uvx baked for python stdio MCP servers (legacy issue 264).

## Two decisions worth knowing

**uid 1000 → `ralph` → `/home/ralph`.** `docker-runner.ts` mounts the host Claude OAuth dir
read-only at `/home/ralph/.claude` (`CONTAINER_HOME`). The host creds are `0600`, owned by the
host's uid 1000, so the in-container agent user must *be* uid 1000 **and** have `/home/ralph` as
its home. A naïve `useradd -o -u 1000 ralph` does not work: `-o` collides with the base image's
existing uid-1000 `node` user, so `$HOME`/`os.homedir()` resolve to `/home/node` and the SDK
reports `"Not logged in"`. The Dockerfile therefore deletes `node` first, then creates `ralph` at
uid 1000. (Gate A/B finding; see legacy issue 210 / legacy issue 194.)

**Claude only, for now.** ADR-0038 lists both `claude` and `codex` CLIs for L0. This image ships
only the `claude` path (the proven one). Codex is a deliberate follow-up: `@openai/codex-sdk` is
not yet a tracked runtime dependency, Codex is dormant in the box config (everything routes to
Claude, ADR-0033/0034), and Codex-in-Docker hits the unsolved bubblewrap sandbox landmine. It
lands once the rest of the container path is running.

## Verifying

```bash
./docker/agent-base/build.sh
# entrypoint is wired — with no dispatch it errors and exits 1:
docker run --rm ralph/agent-base:latest    # -> "RALPH_CONTAINER_DISPATCH is unset …", exit 1
```

Full end-to-end verification (auth → clone → push → PR, and the escalate→resume HITL loop) is
the Gate A / Gate B procedure run against this image.
