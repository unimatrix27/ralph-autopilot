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
echo "==> [1/3] build $tag  (-f .ralph/agent.Dockerfile)"
docker build -f "$dockerfile" -t "$tag" "$target_dir"

# The runner CAPABILITY contract (ADR-0041). A target image inherits the L0 base's
# `io.ralph.runner-capabilities` label; the daemon refuses a master-escalation dispatch into an
# image that does not declare `master-escalation`, so an image built FROM a stale base must fail
# HERE — at onboarding — rather than mid-run as a generic no-result cascade.
echo "==> [2/3] runner capability label"
caps="$(docker image inspect --format '{{ index .Config.Labels "io.ralph.runner-capabilities" }}' "$tag" 2>/dev/null || true)"
echo "    declares: ${caps:-(nothing)}"
for required in impl review-fix runner-direct-escalate master-escalation; do
  case ",$caps," in
    *",$required,"*) ;;
    *)
      echo "smoke-test: image $tag does not declare runner capability '$required'." >&2
      echo "            Rebuild ralph/agent-base (./docker/agent-base/build.sh) and bump the" >&2
      echo "            target's .ralph/agent.Dockerfile FROM tag — see" >&2
      echo "            docs/runbooks/container-image-refresh.md." >&2
      exit 1
      ;;
  esac
done

echo "==> [3/3] clone -> restore -> test in-container  (base=$base)"
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
