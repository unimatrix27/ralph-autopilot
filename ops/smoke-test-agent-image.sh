#!/usr/bin/env bash
#
# smoke-test-agent-image.sh — the onboarding ACCEPTANCE GATE (ADR-0038, issue #191).
#
# Builds a target's per-target agent image from its `.ralph/agent.Dockerfile`, then exercises
# the run shape inside a container: **clone -> restore -> test**. A misconfigured target fails
# here, at onboarding, instead of mid-run. This is the real-environment check the unit suite
# deliberately does NOT do ("no real images/containers in CI", ADR-0038).
#
# Usage:
#   ./ops/smoke-test-agent-image.sh [TARGET_DIR]      # TARGET_DIR defaults to the repo root
#
# Prerequisites: Docker, and a built L0 base (`./docker/agent-base/build.sh`). The clone step
# uses a read-only bind-mount of TARGET_DIR as the git remote, so no token/network is needed.
set -euo pipefail

target_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
target_dir="$(cd "$target_dir" && pwd)"
dockerfile="$target_dir/.ralph/agent.Dockerfile"
contract="$target_dir/.ralph/agent.yaml"

[[ -f "$dockerfile" ]] || { echo "smoke-test: no $dockerfile" >&2; exit 1; }
[[ -f "$contract" ]]   || { echo "smoke-test: no $contract" >&2; exit 1; }

# Pull a scalar field out of the (simple, unquoted) agent.yaml. The strict loader is the real
# validator; this is just enough to drive the smoke run.
field() { sed -n -E "s/^$1:[[:space:]]*(.+)$/\1/p" "$contract" | head -n1; }
restore="$(field restore)"; test_cmd="$(field test)"; base="$(field baseBranch)"
: "${restore:?smoke-test: missing 'restore' in agent.yaml}"
: "${test_cmd:?smoke-test: missing 'test' in agent.yaml}"
: "${base:?smoke-test: missing 'baseBranch' in agent.yaml}"

tag="ralph/smoke/$(basename "$target_dir"):latest"
echo "==> [1/2] build $tag  (-f .ralph/agent.Dockerfile)"
docker build -f "$dockerfile" -t "$tag" "$target_dir"

echo "==> [2/2] clone -> restore -> test in-container  (base=$base)"
# Override the runner entrypoint with a shell that reproduces the L3 fresh-clone + the contract's
# restore/test, exactly as an agent run would, but with no GitHub round-trip. `--init` mirrors the
# real runner (docker-runner.ts): a PID-1 reaper so process-group kills don't leave zombies (#213).
docker run --rm --init --entrypoint bash -v "$target_dir:/remote:ro" "$tag" -lc "
  set -euo pipefail
  # Clone into a user-writable path: the L0 base runs as non-root 'ralph', so a dir at the
  # filesystem root (/work) can't be created. /tmp matches the real runner's clone location.
  git clone --branch '$base' --single-branch /remote /tmp/work
  cd /tmp/work
  echo '--- restore: $restore'
  $restore
  echo '--- test: $test_cmd'
  $test_cmd
"
echo "==> SMOKE TEST PASSED for $target_dir"
