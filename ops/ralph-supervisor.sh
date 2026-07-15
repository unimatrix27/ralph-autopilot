#!/usr/bin/env bash
#
# ralph-supervisor — restart mechanics for the self-updating daemon (issue #30).
#
# A Node process cannot cleanly exec-replace itself, so the concern is split
# (DESIGN §11 / ADR-0018): the *daemon* detects it is behind, gracefully drains
# in-flight runs, then exits with a dedicated restart code; this *supervisor*
# performs the pull + build + relaunch WHILE THE DAEMON IS DOWN (no partial
# state), with a build-gate and rollback so a bad commit can never wedge the box.
#
# Flow per cycle:
#   1. Run the daemon in the foreground; capture its exit code and run duration.
#   2. If the previous launch was a freshly-updated one (on probation) and it
#      died quickly with a crash code → roll back to the last-good commit (AC5).
#   3. On the restart code (75): record last-good HEAD, then pull + (npm ci only
#      if the lockfile changed) + build. Build OK → relaunch the new code on
#      probation. Build FAILS → surface a daemon-anomaly, restore last-good, and
#      relaunch last-good — never relaunch into broken code (AC4).
#   4. Exit 0 → operator stop, leave the loop. Any other code → a non-update
#      crash: surface it and relaunch after a short backoff (Restart=always).
#
# Run it under systemd (ops/ralph-supervisor.service, Restart=always) or any
# process manager so the supervisor itself is kept alive.
#
# Almost everything is overridable via env (defaults in parentheses) so the
# script is testable and adaptable:
#   RALPH_REPO_DIR        the daemon's git checkout            (script's repo root)
#   RALPH_BRANCH          branch to track / pull               (main)
#   RALPH_DAEMON_CMD      command that runs the daemon         (node dist/bin/ralph-daemon.js)
#   RALPH_HEALTH_WINDOW   seconds a fresh launch must survive  (60)
#   RALPH_ANOMALY_FILE    where daemon-anomalies are recorded  ($RALPH_REPO_DIR/.ralph/daemon-anomaly.log)
#   RALPH_QUARANTINE_FILE where a build/health-failing sha is recorded ($RALPH_REPO_DIR/.ralph/quarantine)
#   RALPH_CRASH_BACKOFF   seconds to wait after a non-update crash (5)
#   RALPH_MAX_CYCLES      stop after N cycles, 0 = forever     (0)
#   RALPH_UPDATE_CMD      override the pull+build step          (built-in default_update)
#   RALPH_ROLLBACK_CMD    override the rollback step (gets the commit as $1) (built-in default_rollback)
#   RALPH_CURRENT_COMMIT_CMD  override "print current commit"  (git -C $REPO rev-parse HEAD)
#
set -uo pipefail

# The daemon exits with this code to ask for a pull + build + relaunch. Keep in
# sync with RESTART_EXIT_CODE in src/daemon/self-update.ts.
RESTART_EXIT_CODE=75

REPO_DIR="${RALPH_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Load operator secrets/overrides from the gitignored .env here as well as in
# ralph-start. This makes direct supervisor starts and systemd ExecStart entries
# work for API-key providers (z.ai) without requiring a manual export.
if [ -f "${REPO_DIR}/.env" ]; then
  log_env_path="${REPO_DIR}/.env"
  set -a
  # shellcheck disable=SC1091
  . "$log_env_path"
  set +a
  unset log_env_path
fi

# Keep agent/build scratch off the RAM-backed /tmp by default. Operators can still
# override either variable; when only one is provided, use it for both the daemon
# scratch scrub root and child-process temp files.
if [ -z "${RALPH_TMP_DIR:-}" ] && [ -z "${TMPDIR:-}" ]; then
  export RALPH_TMP_DIR="${REPO_DIR}/.ralph/tmp"
  export TMPDIR="$RALPH_TMP_DIR"
elif [ -z "${RALPH_TMP_DIR:-}" ]; then
  export RALPH_TMP_DIR="$TMPDIR"
elif [ -z "${TMPDIR:-}" ]; then
  export TMPDIR="$RALPH_TMP_DIR"
fi
mkdir -p "$RALPH_TMP_DIR" "$TMPDIR"

BRANCH="${RALPH_BRANCH:-main}"
DAEMON_CMD="${RALPH_DAEMON_CMD:-node dist/bin/ralph-daemon.js}"
HEALTH_WINDOW="${RALPH_HEALTH_WINDOW:-60}"
ANOMALY_FILE="${RALPH_ANOMALY_FILE:-$REPO_DIR/.ralph/daemon-anomaly.log}"
QUARANTINE_FILE="${RALPH_QUARANTINE_FILE:-$REPO_DIR/.ralph/quarantine}"
CRASH_BACKOFF="${RALPH_CRASH_BACKOFF:-5}"
MAX_CYCLES="${RALPH_MAX_CYCLES:-0}"
TMP_DIR="${RALPH_TMP_DIR:-/tmp}"
# Space-separated globs (relative to TMP_DIR) of stale agent scratch to delete before
# each daemon launch, while the daemon is DOWN. A full /tmp tmpfs wedges the Codex
# sandbox's bubblewrap mounts (quota-exceeded) and maxes out runs; reclaiming per-run
# scratch between launches keeps it clear. Empty = scrub disabled — the safe default, so
# tests and generic deployments never touch /tmp. ops/ralph-start.sh sets it for this box.
TMP_SCRUB_GLOBS="${RALPH_TMP_SCRUB_GLOBS:-}"

LAST_RUN_SECONDS=0

log() {
  printf 'ralph-supervisor: %s\n' "$*"
}

# Record an operator-visible daemon-level anomaly: one JSON line to the anomaly
# file AND to stderr, which journald/systemd captures. This is the daemon-anomaly
# surface for build-gate and health-check failures (the daemon itself surfaces
# issue-level state via GitHub labels; supervisor failures are not issue-scoped).
anomaly() {
  local reason="$1" ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  mkdir -p "$(dirname "$ANOMALY_FILE")" 2>/dev/null || true
  printf '{"ts":"%s","event":"daemon-anomaly","reason":"%s"}\n' "$ts" "$reason" >> "$ANOMALY_FILE"
  printf 'ralph-supervisor: daemon-anomaly: %s\n' "$reason" >&2
}

current_commit() {
  if [ -n "${RALPH_CURRENT_COMMIT_CMD:-}" ]; then
    eval "$RALPH_CURRENT_COMMIT_CMD"
  else
    git -C "$REPO_DIR" rev-parse HEAD
  fi
}

# Record a build/health-failing remote sha to the shared quarantine record
# (operator ruling, ADR-0018). The daemon's update checker reads this file and
# treats a remote HEAD equal to it as 'not behind' (no drain), so a single bad
# commit cannot trap the box in an endless drain→rebuild→rollback thrash. The
# daemon clears the record once origin advances past the sha (a fix is pushed).
# Skip empty or last-good shas: a fetch/pull that never moved HEAD (e.g. a network
# blip) must not quarantine the good commit the daemon is already on.
quarantine() {
  local sha="$1"
  if [ -z "$sha" ] || [ "$sha" = "$2" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$QUARANTINE_FILE")" 2>/dev/null || true
  printf '%s\n' "$sha" > "$QUARANTINE_FILE"
  log "quarantined remote sha ${sha} (build/health-failing); daemon will not re-drain for it"
}

lockfile_hash() {
  if [ -f "$REPO_DIR/package-lock.json" ]; then
    sha1sum "$REPO_DIR/package-lock.json" 2>/dev/null | awk '{print $1}'
  fi
}

# Pull the tracked branch, reinstall deps only if the lockfile changed, then
# build. Returns the build's exit status; non-zero means "do not relaunch this".
default_update() {
  git -C "$REPO_DIR" fetch origin "$BRANCH" || return 1
  local before after
  before="$(lockfile_hash)"
  git -C "$REPO_DIR" pull --ff-only origin "$BRANCH" || return 1
  after="$(lockfile_hash)"
  if [ "$before" != "$after" ]; then
    log "lockfile changed; running npm ci"
    ( cd "$REPO_DIR" && npm ci ) || return 1
  fi
  ( cd "$REPO_DIR" && npm run build ) || return 1
  return 0
}

# Restore the working tree to a known-good commit and rebuild its dist. Pure
# git+npm so it does not depend on the (possibly broken) new code.
default_rollback() {
  local commit="$1"
  git -C "$REPO_DIR" reset --hard "$commit" || return 1
  ( cd "$REPO_DIR" && npm ci ) || return 1
  ( cd "$REPO_DIR" && npm run build ) || return 1
  return 0
}

do_update() {
  if [ -n "${RALPH_UPDATE_CMD:-}" ]; then
    eval "$RALPH_UPDATE_CMD"
  else
    default_update
  fi
}

do_rollback() {
  if [ -n "${RALPH_ROLLBACK_CMD:-}" ]; then
    eval "$RALPH_ROLLBACK_CMD \"$1\""
  else
    default_rollback "$1"
  fi
}

# Reclaim stale agent scratch under $TMP_DIR before a launch. Safe because it runs only
# while the daemon is DOWN (top of the supervisor loop, after a drain/crash/update), so no
# in-flight agent owns the paths and per-run scratch is recreated on demand. Deletes only
# paths matching the operator's $TMP_SCRUB_GLOBS under $TMP_DIR — never the repo, the store,
# or anything outside $TMP_DIR. A no-op when globs are empty (the default).
default_scrub() {
  [ -n "$TMP_SCRUB_GLOBS" ] || return 0
  case "$TMP_DIR" in
    "" | "/" | "/.") log "tmp-scrub: refusing unsafe RALPH_TMP_DIR='${TMP_DIR}'"; return 0 ;;
  esac
  local before after g
  before="$(df -Pk "$TMP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  for g in $TMP_SCRUB_GLOBS; do
    # shellcheck disable=SC2086  # $g must word-split + glob-expand into the paths to remove
    rm -rf -- "$TMP_DIR"/$g 2>/dev/null || true
  done
  after="$(df -Pk "$TMP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  log "tmp-scrub: ${TMP_DIR} freeKB ${before:-?}->${after:-?} (globs: ${TMP_SCRUB_GLOBS})"
}

scrub_tmp() {
  if [ -n "${RALPH_TMP_SCRUB_CMD:-}" ]; then
    eval "$RALPH_TMP_SCRUB_CMD"
  else
    default_scrub
  fi
}

# Shared recovery for both "never relaunch broken code" paths — the build-gate
# (AC4) and the post-restart health check (AC5). Quarantine the bad sha so the
# daemon stops re-draining for it, then roll the working tree back to last-good.
# If even the rollback fails, the box is wedged on broken code with no automatic
# way out → surface a human-needed anomaly. Keeping this in one place means a
# future fix to the rollback-failure handling can't be applied to one path but
# not the other, in the spot where divergence is most dangerous.
# $1 bad sha to quarantine, $2 last-good commit to restore, $3 what triggered it.
restore_last_good() {
  quarantine "$1" "$2"
  if ! do_rollback "$2"; then
    anomaly "rollback to last-good $2 FAILED after $3; the box needs a human"
  fi
}

# The pid of the daemon child currently being waited on, and a sticky flag set when
# systemd (or an operator) asks the SUPERVISOR to stop. Tracked so the SIGTERM/SIGINT
# trap can forward the signal to the daemon for a graceful drain instead of letting
# the supervisor die and ORPHAN the daemon outside the cgroup (issue #240: a detached
# PPID-1 daemon survives a stop and races the next instance). KillMode=mixed only
# SIGTERMs the main process (this script), so without forwarding the daemon never
# learns it should drain.
DAEMON_PID=""
STOP_REQUESTED=0

forward_stop() {
  STOP_REQUESTED=1
  if [ -n "$DAEMON_PID" ]; then
    log "received stop signal; forwarding SIGTERM to daemon pid ${DAEMON_PID} for graceful drain"
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap forward_stop TERM INT

# Run the daemon as a backgrounded child and wait, so the supervisor stays alive to
# forward a stop signal (above). Records how long it ran and returns its exit code.
run_daemon() {
  local start=$SECONDS
  # shellcheck disable=SC2086  # DAEMON_CMD is an intentionally word-split command
  ( cd "$REPO_DIR" && exec $DAEMON_CMD ) &
  DAEMON_PID=$!
  # `wait` is interrupted by a trapped signal (returns >128); the daemon is still
  # draining, so wait again until it actually exits and we have its real code.
  local code
  wait "$DAEMON_PID"
  code=$?
  while [ "$code" -gt 128 ] && kill -0 "$DAEMON_PID" 2>/dev/null; do
    wait "$DAEMON_PID"
    code=$?
  done
  DAEMON_PID=""
  LAST_RUN_SECONDS=$(( SECONDS - start ))
  return "$code"
}

main() {
  local cycle=0
  local on_probation=0
  local last_good=""
  local probation_commit=""

  while :; do
    if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
      log "reached RALPH_MAX_CYCLES=$MAX_CYCLES; exiting"
      return 0
    fi
    cycle=$(( cycle + 1 ))

    # Reclaim stale /tmp agent scratch while the daemon is down — keeps a full tmpfs from
    # wedging the Codex sandbox on the next launch. No-op unless RALPH_TMP_SCRUB_GLOBS is set.
    scrub_tmp

    run_daemon
    local code=$?

    # A stop was requested (systemd/operator SIGTERM, forwarded to the daemon): the
    # daemon has now drained and exited, so the supervisor must exit too — never
    # relaunch, roll back, or surface a crash anomaly while we are being stopped
    # (issue #240). Exit 0 so systemd records a clean stop regardless of the drain's
    # exit code (a forced/timeout drain is still an intended stop).
    if [ "$STOP_REQUESTED" -eq 1 ]; then
      log "stop requested; daemon exited $code after drain — supervisor exiting"
      return 0
    fi

    # Health check (AC5): a freshly-updated launch is on probation. If it dies
    # quickly with a crash code (not a clean stop, not another update request),
    # the new version is bad → roll back to the previous good commit.
    if [ "$on_probation" -eq 1 ]; then
      on_probation=0
      if [ "$code" -ne 0 ] && [ "$code" -ne "$RESTART_EXIT_CODE" ] && [ "$LAST_RUN_SECONDS" -lt "$HEALTH_WINDOW" ]; then
        anomaly "health-check failed: updated daemon exited $code after ${LAST_RUN_SECONDS}s (< ${HEALTH_WINDOW}s); rolling back to ${last_good}"
        # The new commit builds but crash-loops on startup: quarantine it so the
        # rolled-back daemon does not re-adopt it and thrash (operator ruling).
        restore_last_good "$probation_commit" "$last_good" "a health-check failure"
        continue  # relaunch last-good
      fi
    fi

    if [ "$code" -eq "$RESTART_EXIT_CODE" ]; then
      last_good="$(current_commit)"
      log "daemon requested self-update restart; last-good=${last_good}"
      if do_update; then
        on_probation=1
        probation_commit="$(current_commit)"
        log "build OK; relaunching updated daemon ${probation_commit} (on probation for ${HEALTH_WINDOW}s)"
      else
        # Build-gate (AC4): never relaunch into broken code. Restore last-good.
        # The pull moved HEAD to the new (broken) sha before the build failed;
        # quarantine it so the daemon stops re-draining for it (operator ruling).
        anomaly "build-failed for the new commit; keeping last-good ${last_good}, not relaunching broken code"
        restore_last_good "$(current_commit)" "$last_good" "a build failure"
      fi
      continue
    fi

    if [ "$code" -eq 0 ]; then
      log "daemon exited cleanly (operator stop); supervisor exiting"
      return 0
    fi

    # A non-update crash. Restart=always semantics: relaunch after a short backoff.
    anomaly "daemon crashed (exit $code) without requesting an update; relaunching after ${CRASH_BACKOFF}s"
    [ "$CRASH_BACKOFF" -gt 0 ] && sleep "$CRASH_BACKOFF"
  done
}

main "$@"
