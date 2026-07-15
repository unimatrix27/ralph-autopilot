# Runbook — auth wiring for run containers

**Exactly which credential mounts where** when the daemon `docker run`s a per-target agent
container, the uid/permission alignment each requires, and the **read-only-vs-writable decision**
per mount including how an OAuth token refresh / transcript write is handled for a run longer than
the token lifetime. This is the credential-wiring contract ADR-0038 commits to ("Credentials are
mounted, not brokered") hardened by the Gate A / Gate B field runs.

> **Credential isolation is an explicit non-goal** (ADR-0038). The run container **holds the
> agent's own credentials by design**; there is no broker, no egress proxy, no short-lived scoped
> token. That is safe **only** because of the dedicated-box / blast-radius rule (ADR-0008,
> `docs/OPERATING.md` §2). Wiring these mounts widens the blast radius by exactly the credentials
> you mount — acceptable only on the dedicated, credential-free box.

## The credential matrix — what mounts where

The daemon builds each mount/forward in `src/container/docker-runner.ts` (`buildDockerRunArgs`)
from the per-target `DockerRunnerConfig.credentials`. `CONTAINER_HOME` is hardcoded `/home/ralph`.

| Credential | Host source | Where in the container | How | r/o vs writable |
| --- | --- | --- | --- | --- |
| **Claude OAuth dir** | `claudeConfigDir` (default `~/.claude`) | `/home/ralph/.claude` | `-v <host>:/home/ralph/.claude:rw` (bind mount) | **read-WRITE** — the SDK writes `session-env/<uuid>` here (`:ro` ⇒ EROFS, fatal); see below |
| **Codex `CODEX_HOME`** | `codexHome` (holds `auth.json`) | `/home/ralph/.codex` | `-v <host>:/home/ralph/.codex:rw` (bind mount) | **read-WRITE** — same reason |
| **GitHub token** | the daemon's env var named by `githubTokenEnv` (e.g. `GH_TOKEN`) | same env var name in the container | `-e GH_TOKEN` (name only — value read from the daemon's env at spawn, **never in argv**) | n/a (env, not a file) |
| **z.ai key** | the daemon's env var named by `zaiTokenEnv` | same env var name in the container | `-e <NAME>` (name only) | n/a (env, not a file) |

Notes that make this correct:

- **No `--user` is passed.** The container runs as its image's `USER ralph` (uid 1000). That is
  why the uid pin (below) is mandatory.
- **Secrets are forwarded by env-var *name*, not value** (`-e GH_TOKEN`, not `-e GH_TOKEN=…`), so
  a token never lands in the process argv / `docker inspect`. The daemon must therefore have the
  token in its **own** environment (e.g. `GH_TOKEN` from its `.env`) at dispatch.
- The Claude path is the **proven** one (Gate A/B). Codex-in-container is wired in
  `docker-runner.ts` but L0 ships Claude-only for now (legacy issue 210); the Codex mount is identical shape.

## uid / permission alignment (the Gate A/B hard finding)

The host Claude creds are `0600`, owned by the host's **uid 1000**. The mount has **no `--user`**, so
the in-container agent user must satisfy **both** conditions or auth fails:

1. **Be uid 1000** — otherwise it cannot read/write the `0600` creds.
2. **Resolve to a user named `ralph` with `$HOME=/home/ralph`** — otherwise `os.homedir()` points
   the SDK at the wrong directory and it reports `"Not logged in"` even though the file is mounted.

**This is solved in the L0 image, not at `docker run` time.** `Dockerfile.agent-base` deletes the
base's `node` user (which squats uid 1000) and creates `ralph` at uid 1000 / `/home/ralph`. The
two naïve fixes that **do not work** (both reproduce `"Not logged in"`):

- `useradd -o -u 1000 ralph` — `-o` collides with `node`'s passwd entry → `$HOME` resolves to
  `/home/node`.
- reuse `node` — its home is `/home/node`, not the `/home/ralph` mount point.

Working recipe (baked into L0; see [`container-provisioning.md`](container-provisioning.md) §2):

```dockerfile
RUN userdel -r node 2>/dev/null || true \
 && useradd -u 1000 -m -d /home/ralph ralph
USER ralph
```

This applies to **both** the Claude and Codex cred mounts. If your host creds-owner uid is **not
1000**, either rebuild L0 with the matching uid, or have `docker-runner.ts` pass `--user
<hostuid>` **and** `-e HOME=/home/ralph` (it must set `HOME` too, or `os.homedir()` drifts again).

**Acceptance proof:** a real run authenticates — `apiKeySource:"none"`, **no**
`authentication_failed`, the SDK does **not** print `"Not logged in"`. That is exactly the Gate A
failure → fix → pass signal.

## Read-only vs writable — the mount is READ-WRITE (`:rw`)

Both credential dirs are mounted **`:rw`**. This is a deliberate reversal of the original `:ro`
posture: the Claude SDK **requires a writable `~/.claude`** and a read-only mount is **fatal**, not
merely a latent refresh problem.

> The SDK creates a per-session **`~/.claude/session-env/<uuid>`** directory at start; under a `:ro`
> mount that `mkdir` fails with **`EROFS: read-only file system`** and the run dies. (It also
> refreshes the OAuth token and writes transcripts under `~/.claude`.) The SDK is *built* to share a
> writable `~/.claude` across processes — `:rw` is its normal mode, exactly how any `claude` process
> on the box runs.

Why `:rw` of the live host dir (not a copy or a read-only store):

- **A per-run copy is impractical.** The box's `~/.claude` is hundreds of MB (transcript history),
  so copying it per run — × the concurrency budget — is far too expensive.
- **Concurrency is safe.** Each run's session state is under its own `session-env/<uuid>`, so
  concurrent containers never collide. The only shared mutable file is `.credentials.json`, written
  only on a **token refresh** — and a refresh by a container just updates the shared box login (the
  same one the box would refresh itself), which is beneficial, not a conflict.
- **Cred isolation is an explicit non-goal** (ADR-0038) — the container runs as the box's own uid
  and writes into the box's own login, exactly like any other `claude` process. The box is the
  blast radius.

Token refresh now **just works** in-container (the writable mount lets the SDK refresh), so the old
"keep the token > 2 h valid" guardrail is no longer load-bearing — though keeping the box login
healthy is still good practice. Transcripts: the daemon remains the **sole authoritative transcript
store** (ADR-0030, via the pipe); the SDK's filesystem transcripts under `~/.claude` are redundant.

## Which Claude store to mount

On the daemon box, mount the store that **actually holds a valid token**. On 2026-06-27 only
`~/.claude` had a valid token (`~/.claude-a` / `~/.claude-b` OAuth tokens were expired), so the
**box-default `~/.claude`** is the one to mount. `RALPH_CLAUDE_CONFIG_DIR` overrides the default if
your valid login lives elsewhere — see [`container-config.md`](container-config.md).

## Codex and z.ai

- **Codex** (`CODEX_HOME` → `auth.json`): set `codexHome` so it mounts `:rw` at `/home/ralph/.codex`.
  Same uid alignment and same writable-store reasoning as Claude. Put the credential on the box per
  [`openai-codex-auth.md`](openai-codex-auth.md). (L0 ships Claude-only for now, legacy issue 210 — the mount
  is ready, the in-container `codex` CLI is the follow-up.)
- **z.ai**: a key in the daemon's env, forwarded by name via `zaiTokenEnv` — no file, no refresh
  concern.

## Done when

- A real container run authenticates Claude (`apiKeySource:"none"`, no `authentication_failed`, no
  `"Not logged in"`).
- The Claude store is mounted `:rw`, so the SDK's `session-env/<uuid>` mkdir + token refresh succeed
  (a `:ro` mount fails fast with `EROFS`).
- The GitHub token reaches the container as an env var by name (the runner can `git push` / `gh pr
  create`), with no token in any argv.
