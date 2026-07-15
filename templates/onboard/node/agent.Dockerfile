# syntax=docker/dockerfile:1
#
# agent.Dockerfile — Node/TypeScript onboarding template (ADR-0038, issue #191).
# Copy to your target repo's `.ralph/agent.Dockerfile` and edit.
#
# L1 (toolchain): the L0 base (`ralph/agent-base`) already ships Node 24, so a pure-Node target
# needs nothing here. If you need a different Node major or extra system packages, install them
# in a `USER root` block, then return to `USER ralph`.
# L2 (deps): warm the package-manager cache keyed on your lockfile so the agent's fresh per-run
# clone restores fast/offline. Docker rebuilds this layer only when the lockfile changes.
#
# Pin `:latest` to a released base tag once `ralph/agent-base` is versioned (ADR-0038 lifecycle).
FROM ralph/agent-base:latest

# Warm the `ralph` user's npm cache from the lockfile (node_modules is discarded — only the
# populated ~/.npm cache matters, so a run-time `npm ci` is a fast cache hit). Swap `npm ci` for
# your package manager's equivalent (`yarn install --immutable`, `pnpm install --frozen-lockfile`).
WORKDIR /home/ralph/.l2-cache
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && rm -rf node_modules
WORKDIR /home/ralph
