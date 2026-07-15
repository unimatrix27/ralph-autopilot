# Self-update: drain, rebuild, restart (legacy issue 30)

The daemon can adopt new commits on its own branch — its auto-merged fixes or your
pushes — without a manual stop → pull → build → restart, and **without abandoning
in-flight runs**. It does this by *draining* (finishing in-flight work, starting
nothing new) and then asking a **supervisor** to pull + build + relaunch it. See
[`adr/0018-self-update-supervisor.md`](adr/0018-self-update-supervisor.md) for the
rationale and [`DESIGN.md` §11](DESIGN.md) for where it sits in the architecture.

> Self-update is **off by default**. A bare daemon that exits the restart code is
> not relaunched — only run with `selfUpdate.enabled: true` when the daemon runs
> **under the supervisor**.

## How it works

```
daemon: every checkEveryTicks ticks → git fetch own repo → origin/<branch> ahead?
   │ no → keep working
   ▼ yes
DRAIN: start/resume no new agents; let in-flight runs finish (review + merge)
   │ idle  (or drainTimeoutSeconds elapsed → force progress past a hung agent)
   ▼
exit 75  ──►  supervisor (daemon is now down):
                git pull --ff-only  +  npm ci (only if lockfile changed)  +  npm run build
                   │ build OK            │ build FAILS
                   ▼                     ▼
                relaunch new         daemon-anomaly + quarantine bad sha + restore last-good (AC4)
                   │
                   ▼ health check (probation window)
                new version crash-loops? → daemon-anomaly + quarantine bad sha + roll back (AC5)
```

A forced (timeout) restart is safe: on startup the daemon re-derives in-flight runs
from GitHub ([ADR-0003](adr/0003-reconciler-poll.md)), so nothing is abandoned.

A persistently build/health-failing commit cannot wedge the box: the supervisor
**quarantines** the bad sha and the daemon stops re-draining for it until a fix is
pushed (see [Quarantine](#quarantine-converging-on-a-bad-commit) below).

## Configure

In `.ralph/config.yaml` (see [`.ralph/config.example.yaml`](../.ralph/config.example.yaml)):

```yaml
selfUpdate:
  enabled: true          # default false
  checkEveryTicks: 10    # ~5 min at a 30s tick
  branch: main           # the daemon's own branch to track
  drainTimeoutSeconds: 1800
  repoDir: .             # the daemon's own git checkout
```

> Keep `selfUpdate.branch` and the supervisor's [`RALPH_BRANCH`](#supervisor-knobs-env) in sync: the daemon drains when `origin/<selfUpdate.branch>` is ahead, but the supervisor pulls `RALPH_BRANCH` — if they disagree the daemon will re-drain forever against a branch the supervisor never advances.

## Run under the supervisor

The supervisor ([`ops/ralph-supervisor.sh`](../ops/ralph-supervisor.sh)) runs the
daemon in the foreground and reacts to its exit code:

- **75 (`RESTART_EXIT_CODE`)** — pull + build + relaunch (build-gated, see below).
- **0** — operator stop; the supervisor exits too.
- **anything else** — a non-update crash; relaunch after `RALPH_CRASH_BACKOFF`.

### systemd (recommended)

```bash
sudo cp ops/ralph-supervisor.service /etc/systemd/system/ralph-supervisor.service
sudo "$EDITOR" /etc/systemd/system/ralph-supervisor.service   # set User / WorkingDirectory / Environment
sudo systemctl daemon-reload
sudo systemctl enable --now ralph-supervisor
journalctl -u ralph-supervisor -f
```

systemd keeps the **supervisor** alive (`Restart=always`); the supervisor keeps the
**daemon** alive (drain-aware, build-gated). Two layers, on purpose.

### Bare wrapper (no systemd)

```bash
RALPH_BRANCH=main ops/ralph-supervisor.sh
```

### Supervisor knobs (env)

| Env | Default | Meaning |
| --- | --- | --- |
| `RALPH_REPO_DIR` | the script's repo root | the daemon's git checkout |
| `RALPH_BRANCH` | `main` | branch to pull |
| `RALPH_DAEMON_CMD` | `node dist/bin/ralph-daemon.js` | how to launch the daemon |
| `RALPH_HEALTH_WINDOW` | `60` | seconds a fresh launch must survive to be healthy |
| `RALPH_ANOMALY_FILE` | `$RALPH_REPO_DIR/.ralph/daemon-anomaly.log` | where anomalies are recorded |
| `RALPH_QUARANTINE_FILE` | `$RALPH_REPO_DIR/.ralph/quarantine` | where a build/health-failing sha is recorded (must match the daemon's repo) |
| `RALPH_CRASH_BACKOFF` | `5` | seconds to wait after a non-update crash |
| `RALPH_MAX_CYCLES` | `0` (forever) | stop after N cycles (testing) |

## Build-gate + rollback

- **Build-gate (AC4).** If `npm run build` fails on the new commit, the supervisor
  does **not** relaunch broken code: it restores the last-good commit and rebuilds,
  relaunching last-good, and records a `daemon-anomaly`.
- **Health check (AC5).** A freshly-updated launch is on probation for
  `RALPH_HEALTH_WINDOW` seconds. If it exits quickly with a crash code, the
  supervisor rolls back to the previous good commit and records a `daemon-anomaly`.

## Quarantine: converging on a bad commit

Build-gate + rollback stop the box relaunching broken code, but on their own they
do **not** converge: after a rollback the daemon is back on last-good code, re-detects
`origin/<branch>` ahead on its next check, drains, and exits again — an endless
~5-min drain → rebuild → rollback thrash for a single bad commit. To break it, the
supervisor and daemon share one record, **`.ralph/quarantine`**:

- On a **build-gate or health-check failure** the supervisor writes the failed remote
  sha to `RALPH_QUARANTINE_FILE`.
- The daemon's update checker treats a remote HEAD **equal to** that sha as *not
  behind* — it does **not** drain or exit for a commit known to fail.
- The daemon **clears** the record the moment origin advances **past** the sha (you
  push a fix), and self-update resumes — the fix is adopted with no operator action.

So a bad commit on the tracked branch can't wedge an unattended box; it parks at
last-good and waits for a fix. Inspect it with `cat .ralph/quarantine` (a single
sha; absent means nothing is quarantined). The matching failure is in the anomaly
log. The file is gitignored and lives in the daemon's own repo — keep
`RALPH_QUARANTINE_FILE` pointing at the same checkout the daemon runs from (the
default does).

## Anomalies

`daemon-anomaly` is the daemon-*level* surface (distinct from issue-level GitHub
labels). The supervisor writes one JSON line per anomaly to `RALPH_ANOMALY_FILE`
**and** to stderr (captured by journald):

```json
{"ts":"2026-06-19T12:00:00Z","event":"daemon-anomaly","reason":"build-failed for the new commit; keeping last-good <sha>, not relaunching broken code"}
```

Watch with `tail -f .ralph/daemon-anomaly.log` or `journalctl -u ralph-supervisor`.

## Safety note

The supervisor runs `git pull` / `npm ci` / `npm run build` on the box with the
daemon's privileges. As everywhere in ralph-autopilot, **the box is the blast radius** —
run only on a dedicated, credential-free machine ([`OPERATING.md`](OPERATING.md)).
