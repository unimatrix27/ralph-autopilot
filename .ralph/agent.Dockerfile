# syntax=docker/dockerfile:1
#
# L1+L2 for ralph-autopilot ITSELF as a container target (ADR-0038 §"Layered per-target images",
# issue #191). The L0 base (`ralph/agent-base`) already ships Node 24 + the in-container runner,
# so a pure-Node target adds no L1 toolchain — this Dockerfile only warms the L2 deps cache,
# keyed (via `.ralph/agent.yaml`'s `depManifests`) on package-lock.json. The agent's fresh
# per-run clone (L3, into /tmp) then restores from the warm cache instead of the network.
#
# Built by the daemon's per-target image build (`src/container/image-build.ts`): build context =
# a fresh clone of this repo, `--file .ralph/agent.Dockerfile`, tagged on the L2 deps cache key.
# The base ref is PINNED (ADR-0038 lifecycle): the FROM line is part of the L2 content key, so
# bumping this version is what re-keys + rebuilds this image onto a new base (a floating :latest
# would silently keep the old base forever — the key never moves when the tag's contents change).
FROM ralph/agent-base:0.0.5

# Warm the `ralph` user's npm cache from the lockfile. The base's own `npm ci` ran as root, so
# its cache lives in /root — not in ~ralph; this primes ~/.npm/_cacache so a run-time `npm ci`
# is a fast, offline cache hit. node_modules is discarded — only the populated cache is the
# point. Docker layer caching rebuilds this only when package-lock.json changes (the L2 key).
WORKDIR /home/ralph/.l2-cache
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && rm -rf node_modules
WORKDIR /home/ralph
