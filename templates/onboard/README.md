# Onboarding templates — the target `.ralph/` container contract

Templates a target repo copies to opt into the container execution model (ADR-0038, legacy epic 182,
legacy issue 191). Each target carries, **in its own repo**, a `.ralph/` contract — distinct from the
daemon's per-deployment `.ralph/config.yaml`:

| File | What it is |
| --- | --- |
| `agent.yaml` | `build` / `test` / `restore` commands, `depManifests`, `baseBranch`. Strict-zod validated (`src/container/agent-contract.ts`); unknown keys fail loud. |
| `agent.Dockerfile` | `FROM ralph/agent-base` + the target's **L1** toolchain and **L2** deps-cache warm. |
| `.dockerignore` | Keeps the build context small; never ships host build artifacts. |

The layered images (ADR-0038): **L0** `ralph/agent-base` (ralph-shipped — Node + the
`ralph-runner`; see [`/docker/agent-base`](../../docker/agent-base)) → **L1** target toolchain →
**L2** deps (cache key = `depManifests` contents) → **L3** a fresh per-run clone (never baked).

## Templates

- **[`node/`](node)** — Node / TypeScript (the base already ships Node 20, so L1 is empty).
- **[`dotnet-angular/`](dotnet-angular)** — a worked .NET backend + Angular (nx) monorepo, the
  shape of `acme/example-monorepo`: installs the .NET SDK (pinned to `global.json`) on
  top of the base's Node.

This repo's own definitions live in [`/.ralph/agent.yaml`](../../.ralph/agent.yaml) +
[`/.ralph/agent.Dockerfile`](../../.ralph/agent.Dockerfile) (a worked Node target).

## Onboard a target

The **`ralph onboard` skill** ([`skills/ralph-onboard`](../../skills/ralph-onboard)) automates
detect → scaffold → build → smoke-test, driving the `ralph-onboard` CLI:

```bash
./docker/agent-base/build.sh                                  # build the L0 base once (needs Docker)
npm run build && node dist/bin/ralph-onboard.js --target /path/to/your/target-repo
```

It detects the toolchain, scaffolds `agent.yaml` + `agent.Dockerfile` into the target's `.ralph/`
and a root `.dockerignore`, then builds + smoke-tests the image as the **acceptance gate**. Pass
`--template` to force a template, `--force` to overwrite, or `--skip-smoke` to scaffold without
Docker.

To do it by hand instead:

1. Build the base once: `./docker/agent-base/build.sh` (needs Docker; see its README).
2. Copy a template into your repo's `.ralph/` and edit `agent.yaml` + `agent.Dockerfile`.
3. Smoke-test it — **the onboarding acceptance gate** (clone → restore → test in-container):

   ```bash
   ./ops/smoke-test-agent-image.sh /path/to/your/target-repo
   ```

   A misconfigured repo fails here, not mid-run. For this repo, run it with no argument.
