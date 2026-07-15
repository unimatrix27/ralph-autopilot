# Runbook — image refresh + incident recovery

Refresh the container images (L0 base release, L1/L2 toolchain / deps bump) and recover from
incidents (wedged container, failing build, rollback to in-process). The governing rule (ADR-0038
image lifecycle, amending ADR-0018): **base-image releases are adopted under operator control,
never auto-pulled mid-fleet, and the daemon never autonomously changes its own execution substrate.**

## Image refresh

### A. New L0 `ralph/agent-base` release

The L0 base is **versioned by ralph release** and adopted deliberately:

1. Build the new base on the box:

   ```bash
   ./docker/agent-base/build.sh 1.3.0       # tags ralph/agent-base:1.3.0 (+ :latest locally)
   ```

   (Publish to your registry if you run multi-box — [`container-provisioning.md`](container-provisioning.md) §4.)

2. **Bump the target Dockerfiles' `FROM` deliberately.** Each target's `.ralph/agent.Dockerfile`
   pins `FROM ralph/agent-base:<ver>`. Bump it to the new tag in the target repo (a PR to that
   repo). Pinning to a released tag rather than the moving `:latest` is what makes a base refresh a
   conscious, reviewable bump per target — **not** a silent fleet-wide change.

3. **Re-run the smoke-test** for each bumped target (clone → restore → test). A base regression
   fails here, at refresh time, not mid-run:

   ```bash
   ./ops/smoke-test-agent-image.sh /path/to/target
   ```

4. Treat a base bump on a live `container` target like any substrate change: a passing smoke-test
   re-establishes container-eligibility; if you want the full belt-and-braces, produce + review a
   shadow run before relying on it ([`container-flip.md`](container-flip.md)).

### B. Toolchain / deps bump (L1 / L2)

L1 (toolchain) and L2 (deps) are **owned by the target repo** and rebuilt on change:

- **Toolchain (L1):** bump the version in the target's `.ralph/agent.Dockerfile` (e.g.
  `DOTNET_CHANNEL`, a Node major), commit to the target repo.
- **Deps (L2):** the L2 deps layer's **cache key is the `depManifests` contents** (ADR-0038). Any
  change to a declared manifest (lockfile, `Directory.Packages.props`, `**/*.csproj`, …) rebuilds
  the deps layer automatically on the next image build — `node_modules` / `obj` are immutable for a
  run, so an in-flight agent can never lose them mid-run.
- Rebuild the per-target image and **re-run the smoke-test**. If you changed `depManifests` itself,
  confirm the new manifest list still keys the cache correctly (the smoke-test's restore proves it).

> Because L3 is a **fresh clone at run start**, the running agent always gets the bumped toolchain /
> deps the moment the image is rebuilt and the next run dispatches — no live run is mutated.

## Incident recovery

### Wedged container

A run container that hangs is caught by the layered backstops; manual recovery if needed:

- The **agent wall-clock** (this box: 7200 s / 2 h; schema default 3600 s — check
  `agent.wallClockSeconds` in your `.ralph/config.yaml`) + the in-container process-group reaper kill
  an overrunning session; `--init` (PID-1) reaps the resulting zombies (legacy issue 213). On wall-clock or abort
  the daemon's `ContainerExecution` path shells the graceful-then-hard `docker stop -t <N>` (SIGTERM,
  grace period, then SIGKILL — the backstop that reaps the whole container), so a wedged run is
  normally torn down without you. The reconciler's **orphan sweep** kills a wedged *run* through the
  abort registry, **and** runs a "kill containers with no live run" pass each tick (legacy issue 219): it
  enumerates the running `ralph-*` container fleet (`docker ps`) and `docker stop`s any container
  that backs no live run — so a daemon crash / lost run row that strands a container is reaped
  automatically. You should rarely need to reap one by hand, but if you do:
- Manual reap (containers are named `ralph-<branch>`):

  ```bash
  docker ps --filter name=ralph- --format '{{.Names}}\t{{.Status}}'   # find it
  docker kill ralph-<branch>                                          # reap it
  ```

  The run's work product is **independent of the pipe** — the runner pushes its branch / opens its
  PR / posts `escalate` **directly to GitHub** (ADR-0038 runner-direct), so a killed container does
  **not** mean lost work; the **completeness invariant** (ADR-0016) re-surfaces the issue next tick
  (GitHub is the source of truth; the pipe is best-effort and never load-bearing). Do **not** delete
  worktrees / branches by hand to "clean up" — that can falsely terminalize a successful run.

### Failing image build

- A target's image fails to build → **that target cannot dispatch container runs**, but the daemon
  and every `in-process` target keep running. Fix the `.ralph/agent.Dockerfile` / `agent.yaml` in
  the target repo and re-run the smoke-test; nothing goes live until it passes.
- The L0 base fails to build → keep the last-good `ralph/agent-base` tag (do not bump targets'
  `FROM`); the old base keeps serving. The daemon-side `ops/verify-deps.sh` gate independently keeps
  the *daemon* from running degraded.

### Rollback to in-process — the universal safety valve

If the container path misbehaves for a target (bad base, wedged runs, build you can't fix fast),
**roll that target back to `in-process` in one step** — always available, **ungated**
(`planExecutionFlip` with `target: "in-process"`):

1. Set the target's `executionMode: in-process` **explicitly** — since legacy issue 195 completed the strangler,
   `container` is the default, so removing the key no longer rolls back (it now resolves to
   `container`).
2. Next tick builds `InProcessExecution` for it — today's behaviour, byte-for-byte unchanged. No
   re-gating required.

Both models coexist through the migration, so rollback is per target and immediate. Full procedure:
[`container-flip.md`](container-flip.md) ("Rollback").

## Done when

- A base / toolchain / deps refresh is a **deliberate** `FROM` / manifest bump in the target repo,
  re-validated by a passing smoke-test before it serves runs.
- A wedged container can be reaped (`docker kill ralph-<branch>`) with **no lost work** (runner-
  direct + completeness invariant).
- You can roll any target back to `in-process` in one step when an incident demands it.
