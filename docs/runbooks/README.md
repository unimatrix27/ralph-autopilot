# Runbooks

Operator procedures for running `ralph-autopilot`. These are the **how-to** companions to the
design of record (`docs/DESIGN.md`, `docs/adr/`, `docs/OPERATING.md`): the design says *what*
the system does and *why*; a runbook says *what you type* to stand it up, move it forward, and
recover it.

Read `docs/OPERATING.md` first — **the box is the blast radius** (ADR-0008). Every runbook here
assumes a dedicated, credential-free machine whose only secrets are scoped GitHub access, the
box's Claude OAuth login, and (optionally) the Codex / z.ai credentials.

## The container rollout (ADR-0038, legacy epic 182)

These runbooks take a clean box all the way to running agents in fresh per-target containers.
Read them roughly in order the first time; jump straight to one once the box is up.

| Runbook | When you reach for it |
| --- | --- |
| [`container-provisioning.md`](container-provisioning.md) | Stand up a clean box; install Docker; **build + publish the L0 `ralph/agent-base` image**. |
| [`container-onboarding.md`](container-onboarding.md) | Onboard a target repo (the TS repo and the .NET + Angular repo) — land its `.ralph/` contract, build its image, pass the smoke-test. |
| [`container-auth-wiring.md`](container-auth-wiring.md) | Wire credentials into run containers — **exactly which credential mounts where**, the uid alignment, and the read-only-vs-writable + token-refresh decision per mount. |
| [`container-config.md`](container-config.md) | The daemon config + env knobs for the container model: `executionMode`, image registry/paths, docker access. |
| [`container-flip.md`](container-flip.md) | Flip a target from `in-process` to `container` through the HITL stage gate, and the one-step rollback. |
| [`container-image-refresh.md`](container-image-refresh.md) | Refresh images (base release, toolchain / deps bump) **and** incident recovery — wedged container, failing build, rollback to in-process. |

Other runbooks:

- [`openai-codex-auth.md`](openai-codex-auth.md) — one-time setup to put the ChatGPT-subscription
  Codex OAuth credential on the box (referenced by the auth-wiring runbook).

## Provenance — these procedures are field-proven

The credential-wiring details below are not theoretical. Two real end-to-end container runs
hardened them:

- **Gate A / Test A (2026-06-27)** — the first real `mode:infra` impl run inside a
  `ralph/agent-base` container opened a PR. It proved the bet **and** surfaced the uid-alignment
  hard failure and the read-only-mount token-refresh latent failure that the auth-wiring runbook
  now captures.
- **Gate B (2026-06-28)** — a second real run drove the full HITL loop (escalate → answer →
  resume) in containers end-to-end, runner-direct against GitHub, and **refined the uid fix**
  (the naïve `useradd -o -u 1000` is itself buggy — see the auth-wiring runbook).
