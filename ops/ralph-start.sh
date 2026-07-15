#!/usr/bin/env bash
#
# ralph-start — the "never launch stale code" front-end (operator request, #30).
#
# The supervisor (ralph-supervisor.sh) keeps the daemon fresh *thereafter* — on a
# self-update restart (exit 75) it pulls + builds + relaunches. But it runs the
# CURRENT dist on its first launch and on a plain crash-relaunch. This wrapper
# closes that gap for a COLD start: pull the tracked branch, reinstall deps if the
# lockfile moved, rebuild dist, then hand off to the supervisor. Use it as the
# entrypoint (directly, or as the systemd ExecStart) instead of running the
# supervisor or `npm run ralph-daemon` bare, so a fresh start can never run an
# out-of-date build.
#
# Honours RALPH_BRANCH (default: main), the same override the supervisor reads.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Load operator secrets/overrides from a gitignored .env (ADR-0034). The z.ai/GLM
# provider authenticates with an API KEY which — unlike the Claude/Codex OAuth stores —
# has no on-disk credential dir; it is read from an env var at runtime and kept out of
# .ralph/config.yaml (and the log redactor's path). `set -a` exports each var so the
# supervisor AND every daemon relaunch (incl. self-update) inherit it. Copy .env.example
# to .env and fill it in. A missing .env is fine (Claude/Codex-only boxes need nothing).
if [ -f "${REPO_DIR}/.env" ]; then
  echo "ralph-start: sourcing ${REPO_DIR}/.env"
  set -a
  # shellcheck disable=SC1091
  . "${REPO_DIR}/.env"
  set +a
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

echo "ralph-start: pulling origin/${BRANCH} (--ff-only)"
git pull --ff-only origin "${BRANCH}"

# Reinstall only when the lockfile actually moved — npm records its last install
# in node_modules/.package-lock.json, so compare against that. A clean `npm ci`
# (not `npm install`) keeps package-lock.json untouched, so the next --ff-only
# pull is never blocked by a dirtied working tree.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "ralph-start: lockfile changed (or no node_modules); npm ci"
  npm ci
fi

echo "ralph-start: npm run build"
npm run build

# Reclaim stale agent /tmp scratch between daemon launches (the supervisor scrubs while the
# daemon is DOWN). Agents create per-run clones/build dirs and Codex session temps under
# /tmp; left to accumulate they fill the tmpfs and the Codex sandbox's bubblewrap mounts
# fail with "Quota exceeded", maxing out runs. These globs match that ephemeral scratch
# (not the reusable nuget/npm caches). Override RALPH_TMP_SCRUB_GLOBS to tune, or set it
# empty to disable.
export RALPH_TMP_SCRUB_GLOBS="${RALPH_TMP_SCRUB_GLOBS:-ralph-pr* pr[0-9]*.* [0-9]*-pr-* ralph-autopilot-*-fix-clone.* tmp-[0-9]*}"

echo "ralph-start: handing off to the supervisor (tmp-scrub globs: ${RALPH_TMP_SCRUB_GLOBS})"
exec "${REPO_DIR}/ops/ralph-supervisor.sh"
