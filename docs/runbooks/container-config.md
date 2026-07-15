# Runbook — container config (executionMode, image registry/paths, docker access)

The daemon config + environment knobs that govern the container execution model: which target runs
in a container (`executionMode`), which image it runs, and the Docker access the daemon needs.

## `executionMode` — per target, default `container` (legacy issue 195)

`executionMode` is the **coarse selector** the composition root branches on to build the matching
`ExecutionEnvironment` (ADR-0038; `src/config/schema.ts`). It is **per target** and, since the
strangler completed (legacy issue 195), defaults to **`container`** — the daemon runs every agent in a fresh
per-target container unless a target opts out:

```yaml
# .ralph/config.yaml
targets:
  - repo: acme/example-monorepo
    commands: { build: dotnet build, test: dotnet test }
    # `container` is the DEFAULT (omit the key and the target runs in containers) — onboard +
    # smoke-test it first (container-onboarding.md). The retained legacy path is the explicit,
    # ungated one-step ROLLBACK: set `in-process` to run the SDK session on the box in a `ralph/*`
    # worktree (byte-for-byte unchanged).
    # executionMode: in-process    # <- the rollback; omit for the container default
```

- `container` (default) → `ContainerExecution`: one shared `DockerCliRunner` per target; impl,
  review, and fix all route through the container adapters while admission, the CI gate, the phase
  machine, and the squash-merge stay byte-for-byte unchanged (daemon stays the orchestrator, ADR-0038).
- `in-process` → `InProcessExecution` (the unchanged behaviour, moved behind the port), reachable
  **only by opting in explicitly** — the guarded one-step rollback.

**Going live from a prior in-process deployment is still gated.** Flipping a target *from*
`in-process` *to* `container` is an operator action gated behind the HITL stage gate (passing
smoke-test → reviewed shadow run) — see [`container-flip.md`](container-flip.md). The strangler
default-flip (legacy issue 195) does not bypass that: it changed only the **default** for targets that never set
the key. Config strict-validation rejects unknown keys, so a typo fails loud at load.

## Image registry / paths

Today the per-target image and the credential mounts are **env-sourced** in the composition root
(`src/daemon/daemon.ts`, `containerDockerConfig`) — the demo wiring the flip stage gate (legacy issue 193) was
reserved to formalise. The knobs:

| Env var | Controls | Default |
| --- | --- | --- |
| `RALPH_AGENT_IMAGE` | **pins** the image the daemon `docker run`s (skips the per-target build) | unset → the daemon **builds/ensures** the per-target image and runs it (see below) |
| `RALPH_CLAUDE_CONFIG_DIR` | host Claude OAuth dir mounted `:ro` at `/home/ralph/.claude` | `~/.claude` |
| `CODEX_HOME` | host Codex dir (`auth.json`) mounted `:ro` at `/home/ralph/.codex` | unset (no Codex mount) |
| `GH_TOKEN` | when set, forwarded into the container **by name** (`-e GH_TOKEN`) | unset |
| `RALPH_ZAI_TOKEN_ENV` | **name** of the daemon env var holding the z.ai key, forwarded by name | unset |

**The per-target image is built and ensured by the daemon, not assumed (legacy issue 190).** Unless you pin
`RALPH_AGENT_IMAGE`, before each dispatch the daemon resolves the image via `createTargetImageResolver`
(`src/container/image-build.ts`): it reads the target clone's `.ralph/agent.Dockerfile` + the
contract's `depManifests`, computes a content key over them, and **builds only on a cache miss**
(`ensureTargetImage`) — then runs **exactly that tag**, `ralph/agent/<owner>-<repo>:<depsCacheKey>`
(e.g. `ralph/agent/unimatrix27-ralph-autopilot:2b8db179ae7c4b98`). So the tag the daemon runs is the tag
it built (no drift), and a changed manifest re-keys the image → the deps layer rebuilds on the next
run with no restart. Pin `RALPH_AGENT_IMAGE` to bypass the build entirely (a digest / registry path
you manage yourself). The credential env-var details are in
[`container-auth-wiring.md`](container-auth-wiring.md).

> The L0 base (`ralph/agent-base`) is **not** pulled by the daemon — it is built/published under
> operator control ([`container-provisioning.md`](container-provisioning.md)) and referenced by the
> target Dockerfiles' `FROM`. Registry choice (local store vs remote) is an explicit open item
> parked in ADR-0038; a single box can keep images in the local Docker store.

## Docker access for the daemon

The daemon shells `docker run` / `docker kill` directly (`src/container/docker-runner.ts`). So the
**daemon's user must be able to reach the Docker socket without sudo**:

```bash
sudo usermod -aG docker "$USER"      # then log out/in, or `newgrp docker`
docker run --rm hello-world          # must succeed as the daemon's user
```

`--init` is passed on every run (a PID-1 reaper so the in-container wall-clock process-group kill
doesn't leave zombies — legacy issue 213); `--rm` makes every container ephemeral; `--name ralph-<branch>` is
the run's kill handle (`docker kill` is the abort / wall-clock backstop). These are not config —
they are baked into `buildDockerRunArgs`.

Per-container resource limits and a concurrency ceiling vs the existing open-slot budget are parked
open items in ADR-0038; extra `docker run` args go through `DockerRunnerConfig.extraArgs` if you
need them.

## Done when

- The target's `executionMode` is set deliberately (default `container` since legacy issue 195; the
  `in-process` rollback only by explicit opt-in, and a *first* flip from a prior in-process
  deployment only via the flip stage gate).
- `RALPH_AGENT_IMAGE` (or the daemon-ensured `ralph/agent/<owner>-<repo>:<depsCacheKey>`) resolves to a built,
  smoke-tested per-target image.
- The daemon's user runs `docker` without sudo.
