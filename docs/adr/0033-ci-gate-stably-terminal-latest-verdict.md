# Pre-review CI gate waits for a stably-terminal, latest verdict before maxing

## Context

The Phase-0 pre-review CI gate ([ADR-0014](0014-harness-owned-ci-gated-rebase-aware-merge.md),
parked off-slot by [ADR-0022](0022-review-as-durable-step-machine.md)) reads `gh pr
checks`, and on a red verdict it spends a bounded fix budget and — still red — flips the
issue to the human-attention terminal `review-maxed (ci)`. That gate manufactured a
`review-maxed` while CI was actually about to be (and moments later was) green — the
same defect class as a usage limit turning successful work into `agent-stuck`
([ADR-0023](0023-usage-limit-guard.md)) and the GitHub rate-limit storm: **a transient
external condition (CI in flight) manufacturing a terminal state.**

Incident — example-monorepo legacy issue 2113 (PR legacy issue 2136), 2026-06-21. The gate read red and maxed `~10s
after CI went green`, well inside the 30-minute CI timeout. Four distinct defects fed
it:

1. **Stale, non-latest check reads.** A check name can carry multiple runs — a failed
   run *and* a passing re-run on the live sha. `classifyChecks` counted the earlier
   failed `.NET Tests` while a passing run of the same name already existed, so it read
   red when CI was green.
2. **`pending` read as a verdict.** PR legacy issue 2136 carried a `state=pending` external
   commit-status context that never reported. A never-completing pending must be "keep
   waiting" (up to `ciTimeoutMinutes`), not a hard red.
3. **No re-confirm before maxing.** A single red read at the wire was enough to
   terminalize; with slow CI, green can land inside the poll window after that read.
4. **Fix budget not visibly spent.** It maxed at `attempts:1` against `maxFixAttempts:
   3` — the off-slot CI-park re-enters the gate per poller advance, and the bounded fix
   loop appeared to max without consuming the full budget.

## Decision

The gate must wait for a **stably-terminal, latest** verdict and spend its full fix
budget before manufacturing a `review-maxed` human-attention state. Concretely:

- **Latest run per check name.** `classifyChecks` collapses multiple runs of one check
  name to the most recent run (by `startedAt`/`completedAt`, ISO-8601 ordered) before
  computing the verdict. A passing re-run supersedes an earlier failure of the same
  name; a fresh failure still supersedes a stale pass, so a real regression is caught.
  The `gh pr checks` read carries `startedAt,completedAt` for this.
- **`pending` is non-terminal.** Any latest-run check still running — a workflow check
  or an external commit-status context that never reports — keeps the verdict `pending`,
  so the off-slot poller keeps waiting up to `ciTimeoutMinutes`. A persistent pending
  becomes a `timeout`, never a red.
- **Re-confirm before maxing.** Just before the CI phase would flip to `review-maxed`
  (budget exhausted, or a `timeout` hard-stop), the gate takes **one** more lean
  snapshot read. A latest, stably-terminal green/none means CI actually passed —
  proceed to review rather than terminalize, closing the race where green lands inside
  the poll window.
- **Full fix budget across off-slot re-entry.** The CI phase consumes its full
  `maxFixAttempts` budget — counted in the event log as `FixAttempted` events
  ([ADR-0024](0024-event-modeling-principle.md)) — before maxing; a run can never max at
  fewer attempts than configured. Matrix-tested across budget sizes.

A genuine, stable red still maxes after the full budget and the re-confirm read — the
gate's purpose (never spend review on a PR that does not even compile) is preserved.

## Consequences

- A slow-but-green CI no longer pages a human. The gate distinguishes "CI in flight /
  re-running" (wait) from "CI stably failed" (max), the same way the usage-limit guard
  distinguishes a transient limit from a real fault.
- `classifyChecks` is now the single place that defines "the current verdict" — latest
  run wins, pending is non-terminal — so both the blocking `awaitChecks` and the
  off-slot `readChecks` snapshot inherit it.
- The re-confirm is one extra `gh pr checks` read per would-be maxout (a rare path), not
  per poll — it does not add to the off-slot read amplification noted in legacy issue 88/legacy issue 101.
- Same family as [ADR-0023](0023-usage-limit-guard.md) and the GitHub rate-limit
  handling: a transient external condition is waited out, never turned into a terminal
  human state. The off-slot CI-park read amplification (legacy issue 88) remains a separate,
  complementary slice.
