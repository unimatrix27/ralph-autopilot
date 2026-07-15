# Daemon self-update: split daemon (drain) from supervisor (rebuild + restart)

An always-on daemon should adopt new commits — its own auto-merged fixes, or
operator pushes — without a manual stop → pull → build → restart, and **without
abandoning in-flight runs**. A naive restart mid-run orphans work (observed live:
a restart orphaned 5 issues until manual recovery). But a Node process cannot
cleanly `exec`-replace itself, and it must not rebuild *itself* while its own
files are mid-flight. So the concern is split in two.

## Decision

**The daemon detects + drains; a supervisor rebuilds + restarts.**

- **Daemon (detection + graceful drain).** Every `selfUpdate.checkEveryTicks`
  reconcile ticks the daemon `git fetch`es its *own* repo and compares local HEAD
  to `origin/<branch>` (`rev-list --count HEAD..origin/<branch>`; a local-only
  commit is *ahead*, not behind, and does not trigger). If behind it begins
  **draining**: the reconciler starts and resumes **no** new agents while
  continuing to tick so in-flight runs (review + merge) finish. Once idle — or
  once `selfUpdate.drainTimeoutSeconds` elapses, to force progress past a hung
  agent — it exits with a dedicated **restart code, 75** (`RESTART_EXIT_CODE`).

- **Supervisor (rebuild + restart, outside the daemon).** A shipped wrapper
  (`ops/ralph-supervisor.sh`, kept alive by `ops/ralph-supervisor.service`,
  `Restart=always`) runs the daemon in the foreground. On exit code 75 it does the
  pull + (npm ci only if the lockfile changed) + build **while the daemon is down**
  (no partial state), then relaunches.

## Build-gate + rollback (safety)

The supervisor builds the new code *before* relaunching, so a broken commit cannot
wedge the box:

- **Build-gate.** A failed `npm run build` must NOT relaunch into broken code: the
  supervisor surfaces a `daemon-anomaly`, restores the last-good commit
  (`git reset --hard` + rebuild), and relaunches **last-good**.
- **Health check.** A freshly-updated launch is "on probation". If it exits
  quickly (within `RALPH_HEALTH_WINDOW`) with a crash code, the supervisor rolls
  back to the previous good commit, rebuilds, and surfaces a `daemon-anomaly` —
  catching a commit that builds but crash-loops on startup.

The rollback path is pure git + npm (not the new code), so it survives even a
commit that breaks the daemon entirely.

## Quarantine: converging on a persistently-failing commit

Build-gate + rollback alone do **not** converge. A commit that always fails the
build (or crash-loops) leaves the box thrashing: the supervisor rolls back to
last-good, but the daemon — now running last-good code — re-detects `origin/<branch>`
ahead on its next check, drains, and exits 75 again, every cycle (~5 min). A
supervisor-only fix is insufficient because the *daemon* keeps initiating the drain.

**Decision: a shared quarantine record.** The supervisor and daemon coordinate
through one file, `.ralph/quarantine` (the supervisor's `RALPH_QUARANTINE_FILE`,
the daemon's `QUARANTINE_RELATIVE_PATH`):

- On a **build-gate or health-check failure** the supervisor writes the failed
  remote sha to the record (skipping the no-op case where a fetch/pull never moved
  HEAD, so a transient network blip never quarantines the good commit).
- The daemon's update checker reads the record: a remote HEAD **equal to** the
  quarantined sha is treated as *not behind* — no drain, no exit-75.
- The checker **clears** the record the moment origin advances **past** the sha (a
  fix was pushed), and normal detection resumes — the box adopts the fix on its own.

This halts both the rebuild thrash and the daemon's drain/exit thrash, stays
observable (the record is a plain sha file; the failure is already in the anomaly
log), and auto-recovers without operator action once a fixing commit lands. A bad
commit on the tracked branch can no longer wedge an unattended box.

## Why this split

- **No self-`exec`.** A process rebuilding its own running files is fragile; doing
  it from *outside*, while the daemon is down, is clean. This is the classic
  supervisor pattern (the `while`-wrapper / `Restart=always`).
- **No abandoned work.** Draining before exit is the whole point: in-flight runs
  reach a terminal state (merge) first. A forced (timeout) restart is still safe
  because startup reconciliation re-derives in-flight runs from GitHub
  ([ADR-0003](0003-reconciler-poll.md)) — the store is rebuildable, GitHub is the
  source of truth.
- **Off by default.** `selfUpdate.enabled` defaults to `false`. A bare daemon that
  exits 75 without a supervisor simply stops; enable it only on a box running
  under `ralph-supervisor`.

## Consequences

- A new config block: `selfUpdate { enabled (false), checkEveryTicks (10),
  branch (main), drainTimeoutSeconds (1800), repoDir (.) }`.
- `Reconciler.runForever` now returns a `DaemonOutcome` (`stopped` |
  `restart-for-update`); `bin/ralph-daemon.ts` sets `process.exitCode = 75` on the
  latter.
- A new operator surface, `daemon-anomaly`: a JSON line written to the anomaly file
  and stderr (journald) for build-gate and health-check failures. Distinct from
  issue-level state, which the daemon still surfaces via GitHub labels — a
  supervisor-level failure is not scoped to any one issue.
- A new coordination file, `.ralph/quarantine` (gitignored): the supervisor writes
  the failed remote sha, the daemon reads it to suppress the drain and clears it
  once origin advances. One sha per line; absent ⇒ nothing quarantined.
- Ships `ops/ralph-supervisor.sh`, `ops/ralph-supervisor.service`, and operator
  docs ([docs/SELF-UPDATE.md](../SELF-UPDATE.md)).
- The git-guardrails hook (DESIGN §8) is unaffected: the supervisor's git ops run
  *outside* agent sessions, in the daemon's own repo, not in a worktree.
