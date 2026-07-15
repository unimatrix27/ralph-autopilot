# Runbook — provisioning the box + building/publishing `ralph/agent-base` (L0)

Stand up a clean box for the container execution model (ADR-0038) and build/publish the L0
`ralph/agent-base` image every per-target agent image builds `FROM`. The L0 Dockerfile and build
script already ship in this repo (legacy issue 210 / legacy issue 211) — this runbook **documents building and publishing
the existing artifact**, including the uid pin that makes the `:ro` host credentials readable
in-container.

> **The box is the blast radius** (ADR-0008, `docs/OPERATING.md` §2). Provision only a dedicated,
> credential-free machine with no reachable prod secrets. Containers are a *freshness /
> reproducibility* boundary, **not** a security boundary against the agent — the run container
> legitimately holds the agent's own credentials (ADR-0038, "Credentials are mounted, not
> brokered").

## 1. Provision the box

A dedicated Linux box (the daemon already runs here in-process; ADR-0038 only adds Docker):

1. **Node ≥ 20** and the native-build toolchain `better-sqlite3` needs.
   - `better-sqlite3` recompiles on any Node bump and runs `node-gyp` → which needs a Python that
     still ships `distutils`. **System Python 3.14 removed `distutils`** — use Python **3.13**
     (or point `npm_config_python` at a 3.13 with `setuptools`) for installs / native rebuilds.
2. **Git** and the **GitHub CLI (`gh`)**, authenticated for the target repos.
3. **Docker Engine.** The daemon shells `docker run` / `docker kill` (`src/container/docker-runner.ts`).

   ```bash
   # Debian/Ubuntu — install Docker Engine, then let the daemon's user run docker without sudo:
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"      # log out/in (or `newgrp docker`) for it to take effect
   docker run --rm hello-world          # verify the daemon's user can reach the docker socket
   ```

   Docker access for the daemon user is a provisioning prerequisite, surfaced again in
   [`container-config.md`](container-config.md).

4. **The box's credentials** (see [`container-auth-wiring.md`](container-auth-wiring.md) for the
   full matrix): the Claude OAuth login dir (`~/.claude`), optionally the Codex `CODEX_HOME`
   (`docs/runbooks/openai-codex-auth.md`), the GitHub token in the daemon's environment, and the
   z.ai `.env` key. These stay on the box; they are *mounted/forwarded* into run containers, never
   baked into an image.

## 2. Build the L0 `ralph/agent-base` image

The definition is [`/Dockerfile.agent-base`](../../Dockerfile.agent-base); the build context
**must** be the repo root (the Dockerfile `COPY`s `package*.json`, `tsconfig.json`, and `src`):

```bash
./docker/agent-base/build.sh             # tags ralph/agent-base:<pkg-version> + :latest
./docker/agent-base/build.sh 1.2.0       # or pin an explicit version tag
```

The tag defaults to the `package.json` version (ADR-0038 image lifecycle: **versioned by ralph
release**, adopted under operator control, never auto-pulled mid-fleet). What the image carries
and the two decisions baked into it are in [`/docker/agent-base/README.md`](../../docker/agent-base/README.md).

### The uid pin is load-bearing — this is the Gate A/B field finding

`src/container/docker-runner.ts` bind-mounts the host Claude OAuth dir **read-only** at
`/home/ralph/.claude` (its hardcoded `CONTAINER_HOME`) with **no `--user`**. The host creds are
`0600`, owned by the host's **uid 1000**. So the in-container agent user must satisfy **both**:

- **be uid 1000** (or it cannot read the `0600` `:ro` creds), **and**
- **resolve to a user named `ralph` whose `$HOME` is `/home/ralph`** (or the SDK looks for creds
  under the wrong home and reports `"Not logged in"`).

The naïve fixes are themselves buggy (proven in the field):

- `useradd -o -u 1000 ralph` — **wrong.** `-o` lets uid 1000 *collide* with `node:20-bookworm`'s
  existing `node` user (which already owns uid 1000), so `getpwuid(1000)` / `$HOME` /
  `os.homedir()` resolve to `node` / `/home/node`. The SDK reads creds from the wrong home and
  reproduces `apiKeySource:"none"`, `error:authentication_failed`, `"Not logged in · Please run
  /login"` — a ~20 ms failed run.
- "reuse the `node` user" — **wrong.** Its home is `/home/node`, not the `/home/ralph` mount point.

The shipped `Dockerfile.agent-base` therefore **deletes `node` first, then creates `ralph` at uid
1000 with home `/home/ralph`**:

```dockerfile
RUN userdel -r node 2>/dev/null || true \
 && useradd -u 1000 -m -d /home/ralph ralph
USER ralph
```

(Equivalent: `usermod` to rename `node`→`ralph` and move its home.) This applies to **both** the
Claude and Codex cred mounts. If your host creds-owner uid is not 1000, rebuild with the matching
uid, or have `docker-runner.ts` pass `--user <hostuid>` **and** `-e HOME=/home/ralph` — see
[`container-auth-wiring.md`](container-auth-wiring.md).

> **Codex CLI in L0 is a follow-up** (legacy issue 210). L0 ships the **Claude path only** today; the `codex`
> CLI that ADR-0038 lists for L0 lands once the rest of the container path is running (`@openai/codex-sdk`
> is not yet a tracked runtime dep and Codex-in-Docker hits the bubblewrap sandbox landmine).

## 3. Verify the image

```bash
# Entrypoint is wired — with no dispatch it errors and exits 1:
docker run --rm ralph/agent-base:latest          # -> "RALPH_CONTAINER_DISPATCH is unset …", exit 1
```

Full end-to-end verification (auth → clone → push → PR, and the escalate→resume HITL loop) is the
**onboarding smoke-test** ([`container-onboarding.md`](container-onboarding.md)) plus the Gate A /
Gate B procedure run against this image. The unit suite deliberately runs **no real images or
containers** (ADR-0038) — image builds are infra; their acceptance test is the smoke-test.

## 4. Publish the image (registry)

For a single box you can leave the image in the local Docker image store (per-target images build
`FROM ralph/agent-base:latest` locally — no registry needed). Publish only if you build on one box
and run on another, or want an auditable release artifact:

```bash
# Tag for your registry and push the released version (NOT a moving :latest for the fleet):
docker tag ralph/agent-base:1.2.0 registry.example.com/ralph/agent-base:1.2.0
docker push registry.example.com/ralph/agent-base:1.2.0
```

Registry choice (local vs remote) is an explicit open item parked in ADR-0038; the daemon does not
pull L0 itself. **Adopting a new base release across the fleet is an operator action, never
auto-pulled mid-fleet** — see [`container-image-refresh.md`](container-image-refresh.md). Pin the
target Dockerfiles' `FROM ralph/agent-base:<ver>` to a released tag rather than the moving
`:latest` once you publish, so a base refresh is a deliberate bump.

## Done when

- `docker run --rm hello-world` works as the daemon's user (Docker access).
- `./docker/agent-base/build.sh` tags `ralph/agent-base:<ver>` + `:latest`.
- `docker run --rm ralph/agent-base:latest` errors on the missing dispatch and exits 1.
- The image authenticates Claude in a real run (`apiKeySource:"none"`, **no**
  `authentication_failed`) — proven by the onboarding smoke-test / Gate A.
