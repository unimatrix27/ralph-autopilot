# Runbook — flip a target to `container` (stage gate) + rollback

Move a target from `executionMode: in-process` to `container` through the **HITL stage gate**, and
the **one-step rollback** back to in-process. The daemon **never flips its own substrate
autonomously** (ADR-0038) — flipping is an operator action only. The governance is the pure core
`planExecutionFlip` / `planShadowRun` (`src/core/execution-flip.ts`, legacy issue 193); this runbook is the
operator procedure that drives it.

## The two stage gates (flip *to* `container`)

A flip to `container` clears two gates, **in this order**:

1. **Onboarding smoke-test gate** — the target is *container-eligible* only after a passing
   smoke-test (`ops/smoke-test-agent-image.sh`; [`container-onboarding.md`](container-onboarding.md)).
   `SmokeTestGate` must be `passed`.
2. **Reviewed shadow run gate** — the live flip is gated on a **reviewed shadow run**. The
   `ShadowRunGate` must reach `reviewed-clean` (the only state that clears the gate).

`planExecutionFlip` is total over `(current, target, evidence)` and returns an operator-facing
reason naming the gate that blocks:

| Situation | Result |
| --- | --- |
| smoke-test not `passed` | **blocked** — "Container-ineligible: the onboarding smoke-test has not passed…" |
| smoke-test `passed`, shadow run not `reviewed-clean` | **blocked** — "Flip gated on a reviewed shadow run…" |
| smoke-test `passed` **and** shadow run `reviewed-clean` | **allowed** → `container` |
| already `container` | allowed (no-op) — "Already running in container." |

## Procedure — flip to container

> **No wired flip command yet.** `planExecutionFlip` / `planShadowRun` are exported **pure decision
> cores** (`src/index.ts`), not yet wired to a CLI or web endpoint. So today the flip is an
> **operator-performed sequence**: you run the smoke-test, dispatch + review a shadow run, and then
> **edit `executionMode` by hand** — the gates below are the discipline you apply, and the two
> `plan*` functions encode that discipline for when the operator action is automated. Treat the steps
> as a manual checklist, not commands to invoke.

1. **Pass the smoke-test** (gate 1). See [`container-onboarding.md`](container-onboarding.md):

   ```bash
   ./ops/smoke-test-agent-image.sh /path/to/target      # must print SMOKE TEST PASSED
   ```

2. **Produce a shadow run** (gate 2 input). A shadow run is a container run of the target's **next
   eligible issue** (admission's FIFO pick) on an **isolated `ralph-shadow/*` branch** — a distinct
   namespace from the live `ralph/*` branch, so it shares no worktree or branch with the live
   in-process run and **never affects it**. The `planShadowRun` decision core encodes the guard: it
   refuses when the target is not yet container-eligible, nothing is eligible, or the candidate
   **already has a live run** (shadowing it would touch the live run), and otherwise yields
   `{ produced: true, issueNumber, branch: "ralph-shadow/<n>-<slug>" }` — the branch to dispatch the
   shadow run on.

3. **Review the shadow run.** Inspect the shadow run's PR / branch end-to-end — auth, clone, build,
   test, the PR it opened — exactly as you would review a normal run. This is the human checkpoint
   the flip is gated on.
   - Clean → record `shadowRun: reviewed-clean`.
   - Problems → `reviewed-rejected`; fix the `.ralph/` contract / image and produce a new shadow
     run. **Do not flip.**

4. **Flip.** With `smokeTest: passed` and `shadowRun: reviewed-clean`, the operator flip is
   allowed; set the target's `executionMode: container` (the persisted result of the cleared gate)
   and the next tick routes that target's runs through `ContainerExecution`. Admission, the CI
   gate, and the squash-merge are unchanged — only the execution substrate moved.

> **Strangler order** (ADR-0038): the **.NET target** was flipped **first** (it cannot run
> in-process anyway — highest value, proved the model end-to-end behind the switch); this
> TypeScript repo (`unimatrix27/ralph-autopilot`) was flipped **last** (legacy issue 195), completing the strangler.
> `container` is now the **schema default** (`src/config/schema.ts`): a target with no
> `executionMode` key runs in containers, so onboard + smoke-test a new target *before* the daemon
> picks it up. The two models still coexist via `executionMode` — flip one target at a time, and
> the in-process path is retained behind the explicit rollback below.

## Rollback — always available, in one step, ungated

A rollback to `in-process` is **always allowed, ungated** (`planExecutionFlip` with
`target: "in-process"` returns `allowed: true` for any current state). To roll a target back:

1. **Set its `executionMode` explicitly to `in-process`.**

   ```yaml
   targets:
     - repo: unimatrix27/ralph-autopilot
       commands: { build: npm run build, test: npm test }
       executionMode: in-process     # the one-step rollback
   ```

   > Since legacy issue 195 completed the strangler, `container` is the **default** — so you must opt back into
   > the legacy path **explicitly**. Removing the key no longer rolls back; it now resolves to
   > `container`.

2. The next tick builds `InProcessExecution` for that target — today's behaviour, byte-for-byte
   unchanged. No re-gating, no smoke-test, no shadow run required.

This one-step rollback is the safety valve behind the whole rollout: if the container path
misbehaves in production, flip back immediately. The daemon-side `ops/verify-deps.sh` gate keeps
guarding the *daemon's own* deps either way. Incident-driven rollback (wedged container, failing
image build) is in [`container-image-refresh.md`](container-image-refresh.md).

### Verify the rollback resolves

The rollback is config-only and resolves deterministically through the same loader the daemon uses,
so you can confirm it without starting the daemon. The config tests assert it directly
(`src/config/config.test.ts`, "guards the retained in-process path behind explicit config"): an
explicit `executionMode: in-process` resolves to `in-process` (rebuilding `InProcessExecution` next
tick), while omitting the key resolves to `container`. Run `npm test -- src/config` after editing,
or load the config and read the resolved mode back. A clean rollback is: the target's resolved
`executionMode` reads `in-process`, and the next tick logs no `DockerCliRunner` for it.

## Done when

- The target's smoke-test has passed (container-eligible).
- A shadow run on a `ralph-shadow/*` branch was produced and **reviewed clean**.
- `executionMode: container` is set and the next tick runs that target in containers — **or** the
  flip stayed blocked with the gate's reason surfaced.
- You have confirmed the one-step rollback path (set `executionMode: in-process`) is understood
  before going live.
