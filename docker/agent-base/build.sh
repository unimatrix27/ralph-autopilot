#!/usr/bin/env bash
# Build + tag the L0 ralph/agent-base image (ADR-0038). Run from the repo root; the build
# context MUST be the repo root so Dockerfile.agent-base can COPY package*.json / tsconfig.json
# / src. Versioning is by ralph release (ADR-0038 image lifecycle); the tag defaults to the
# package.json version, overridable via the first arg or $RALPH_AGENT_BASE_VERSION.
#
#   ./docker/agent-base/build.sh            # tags ralph/agent-base:<pkg-version> + :latest
#   ./docker/agent-base/build.sh 1.2.0      # tags ralph/agent-base:1.2.0 + :latest
#
# Publishing (push to a registry) is an operator step — see the provisioning runbook (#194).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

default_version="$(node -e 'process.stdout.write(require("./package.json").version)')"
version="${1:-${RALPH_AGENT_BASE_VERSION:-$default_version}}"
image="ralph/agent-base"

echo "Building ${image}:${version} (+ :latest) from ${repo_root} ..."
docker build -f Dockerfile.agent-base -t "${image}:${version}" -t "${image}:latest" .
echo "Built ${image}:${version} and ${image}:latest"
