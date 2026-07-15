---
name: ralph onboard
description: Onboard a target repo into ralph's container execution model (ADR-0038) — detect the toolchain, scaffold the .ralph/ container contract (agent.yaml + agent.Dockerfile + .dockerignore) from ralph's templates, then build the per-target image and smoke-test it as the acceptance gate. Use when adding a new target repo to ralph, when a repo needs its .ralph/ agent contract created or repaired, or when an onboarding smoke-test is failing and needs diagnosis.
---

# ralph onboard

Onboard a **target repo** into ralph's fresh-per-target container model (ADR-0038, legacy epic 182). The
end state is a **committable `.ralph/` contract** in the target repo plus a **proven-buildable
per-target image** — proven by an in-container smoke-test, so a misconfigured repo fails *here, at
onboarding, not mid-run*.

This skill drives the deterministic work through the `ralph-onboard` CLI; your job is to run it,
interpret detection/smoke results, and resolve the actionable failures it surfaces.

## The four steps (what the CLI does)

1. **Detect** the toolchain from the target's marker files → picks a template under
   `templates/onboard/<id>` (`node` or `dotnet-angular`).
2. **Scaffold** the contract from that template: `agent.yaml` + `agent.Dockerfile` into the target's
   `.ralph/`, and a `.dockerignore` at the repo root. The target's real default branch is
   substituted into `agent.yaml`'s `baseBranch`.
3. **Build** the per-target image from `.ralph/agent.Dockerfile` (`FROM ralph/agent-base`).
4. **Smoke-test** it — the **acceptance gate**: clone → `restore` → `test` inside the container,
   exactly as a real run would, with no GitHub round-trip.

## How to run it

From a ralph checkout (the templates + smoke-test live here), point it at the target:

```bash
npm run build         # once, so dist/bin/ralph-onboard.js exists
node dist/bin/ralph-onboard.js --target /path/to/target-repo
```

Prerequisites for the gate: **Docker** and a built **L0 base** (`./docker/agent-base/build.sh`).

Flags:

- `--target DIR` — the target repo (default: current directory).
- `--template node|dotnet-angular` — force a template when detection is ambiguous or wrong.
- `--force` — overwrite an existing `.ralph/` contract instead of refusing.
- `--skip-smoke` — scaffold only (no Docker); the operator runs the gate later.

## Reading the result

- **Success** → the `.ralph/` contract is written and the image built + smoke-tested clean. Tell the
  operator to **commit `.ralph/agent.yaml`, `.ralph/agent.Dockerfile`, and the root `.dockerignore`**.
- **Blocked at `detect`** → no template matched. Inspect the repo, then re-run with an explicit
  `--template`, or hand-author `.ralph/` from `templates/onboard` for an unsupported toolchain.
- **Blocked at `scaffold`** → a contract already exists. Re-run with `--force` to overwrite, or stop.
- **Blocked at `smoke`** → the contract is on disk (committable) but **not proven**. The CLI prints
  the smoke-test output. Diagnose it and fix the contract, then re-run:
  - wrong/missing `build`/`test`/`restore` command → edit `.ralph/agent.yaml`.
  - missing toolchain or system package → edit `.ralph/agent.Dockerfile` (install it in a
    `USER root` block, return to `USER ralph`).
  - wrong `depManifests` (deps don't restore, or the L2 cache never warms) → fix the manifest list.
  - wrong `baseBranch` (clone fails on a missing branch) → set the repo's real default branch.

A failing smoke-test **blocks onboarding** — never report it as done. Resolve it or escalate; the
gate exists precisely so the failure surfaces now rather than inside a live agent run.

## Notes

- The `.ralph/agent.*` contract is **distinct from the daemon's `.ralph/config.yaml`** — it is the
  *target's* container contract, versioned with the target's code.
- Onboarding does **not** flip the target to `executionMode: container`. That is a separate,
  HITL-gated operator action taken only after a passing smoke-test and a reviewed shadow run.
- Templates and the gate live in this repo: `templates/onboard/` and
  `ops/smoke-test-agent-image.sh`. The CLI is `src/bin/ralph-onboard.ts`; its tested cores are in
  `src/onboard/`.
