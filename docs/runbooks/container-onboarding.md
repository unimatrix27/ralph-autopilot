# Runbook — onboarding a target repo (TS and .NET + Angular)

Onboard a target repo into the container execution model: land its `.ralph/` container contract,
build its per-target image, and pass the **onboarding smoke-test** — the acceptance gate that a
misconfigured repo fails at *onboarding*, not mid-run (ADR-0038). Covers both shipped templates:
the TS repo and a .NET + Angular monorepo (the shape of `acme/example-monorepo`,
"example-monorepo").

Prerequisite: a built L0 base — see [`container-provisioning.md`](container-provisioning.md).

## The onboarding contract (lives in the *target* repo)

A target opts in by carrying a `.ralph/` contract **in its own repo** — distinct from the daemon's
per-deployment `.ralph/config.yaml`. ADR-0038's "Onboarding contract":

| File | What it is |
| --- | --- |
| `.ralph/agent.yaml` | `build` / `test` / `restore` commands, `depManifests: string[]`, `baseBranch`. Strict-zod validated (`src/container/agent-contract.ts`) — unknown keys rejected, missing required fails loud. |
| `.ralph/agent.Dockerfile` | `FROM ralph/agent-base:<ver>` + the target's **L1** toolchain and **L2** deps-cache warm. |
| `.ralph/.dockerignore` | Keeps the build context small; never ships host build artifacts. |

Templates to copy live in [`/templates/onboard/`](../../templates/onboard) (see its
[`README.md`](../../templates/onboard/README.md)). The layered images: **L0** `ralph/agent-base`
→ **L1** target toolchain → **L2** deps (cache key = `depManifests` contents) → **L3** a fresh
per-run clone, never baked (the freshness guarantee).

> Versioned **with the code** so the contract evolves with the codebase, not in the daemon's config.

## A. The TS repo (`node` template)

This repo dogfoods on its own clone, and ships a worked Node target at
[`/.ralph/agent.yaml`](../../.ralph/agent.yaml) + [`/.ralph/agent.Dockerfile`](../../.ralph/agent.Dockerfile).
For a fresh Node/TS target:

1. Copy the template into the target's `.ralph/`:

   ```bash
   mkdir -p /path/to/target/.ralph
   cp templates/onboard/node/agent.yaml        /path/to/target/.ralph/agent.yaml
   cp templates/onboard/node/agent.Dockerfile  /path/to/target/.ralph/agent.Dockerfile
   cp templates/onboard/node/.dockerignore     /path/to/target/.ralph/.dockerignore
   ```

2. Edit `agent.yaml` — `build` / `test` / `restore`, `depManifests` (the **lockfile your repo
   actually commits**: `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`), and `baseBranch`.
   The base already ships Node 20, so a pure-Node `agent.Dockerfile` only needs the L2 deps-cache
   warm (swap `npm ci` for your package manager if needed).

3. Commit `.ralph/` to the target repo and proceed to the smoke-test (§C).

## B. The .NET + Angular repo (`dotnet-angular` template) — landing example-monorepo's `.ralph/`

`acme/example-monorepo` is a .NET backend + Angular (nx) monorepo; it **cannot run
in-process** (the box holds one drifting toolchain), so it is the **strangler-order first** target
(ADR-0038) and the one that proves the container model end-to-end.

1. Copy the worked template into example-monorepo's `.ralph/`:

   ```bash
   cp templates/onboard/dotnet-angular/agent.yaml        <example-monorepo>/.ralph/agent.yaml
   cp templates/onboard/dotnet-angular/agent.Dockerfile  <example-monorepo>/.ralph/agent.Dockerfile
   cp templates/onboard/dotnet-angular/.dockerignore     <example-monorepo>/.ralph/.dockerignore
   ```

2. Edit for example-monorepo:
   - `agent.Dockerfile` L1 installs the **.NET SDK on top of the base's Node 20** (Node covers the
     Angular/nx client). Set `ARG DOTNET_CHANNEL` to match the repo's `global.json` `sdk.version`.
   - `agent.yaml` `depManifests` for .NET central package management: `global.json`,
     `Directory.Packages.props`, `**/*.csproj`, plus the Angular client lockfile
     (`client/package.json`, `client/package-lock.json`). `baseBranch: master` for example-monorepo.
   - `test`: a monorepo with a separate Angular client typically runs frontend tests separately
     (`cd client && npm test` / `nx test`) — wrap both in one script if you want a single `test`
     command to cover the whole repo.

3. Land the `.ralph/` files **in example-monorepo's own repo** (a PR to example-monorepo), then smoke-test (§C).

## C. Smoke-test — the onboarding acceptance gate

The smoke-test ([`/ops/smoke-test-agent-image.sh`](../../ops/smoke-test-agent-image.sh)) builds
the target's image from `.ralph/agent.Dockerfile`, then reproduces the **run shape inside a
container: clone → restore → test** (the L3 fresh-clone + the contract's `restore`/`test`, with no
GitHub round-trip — it bind-mounts the target dir read-only as the git remote):

```bash
./ops/smoke-test-agent-image.sh /path/to/target-repo   # the TS repo: run with no argument
```

A misconfigured repo (bad `restore`, missing toolchain, failing `test`) **fails here**. This is the
real-environment check the unit suite deliberately does not do ("no real images/containers in CI",
ADR-0038). It is also the first stage gate for the flip — a target is **container-eligible only
after a passing smoke-test** ([`container-flip.md`](container-flip.md)).

> The `ralph onboard` Claude skill (legacy issue 192) automates §A/§B: detect the toolchain, scaffold the
> `.ralph/` files from these templates, build the image, and run this smoke-test. The manual steps
> above are the fallback and the source of truth for what the skill does.

## Done when

- The target carries a strict-zod-valid `.ralph/agent.yaml` + `.ralph/agent.Dockerfile` +
  `.ralph/.dockerignore`, committed to its own repo.
- `./ops/smoke-test-agent-image.sh <target>` prints `SMOKE TEST PASSED` (clone → restore → test).
- The target is now **container-eligible** for the flip stage gate.
