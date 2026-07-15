# The reconciler completeness invariant — no silent loss

The daemon's defence against *silently* losing work is **distributed**: many code
paths must each set/clear the right label + run status so the reconciler keeps
acting on an issue. Whenever an issue lands in a (label set × run status)
combination that **no path classifies**, it becomes a silent **island** — acted on
by nothing, seen by no one. Under auto-merge ([ADR-0009](0009-auto-merge.md) /
[ADR-0014](0014-harness-owned-ci-gated-rebase-aware-merge.md)) there is no human
reading every PR, so an island sits unnoticed indefinitely.

The original build shipped two islands, each found by accident:
legacy issue 8 (a crash abandons in-flight `running` runs) and legacy issue 9 (an answered
`review-maxed` heal that nothing resumes). A later one (legacy issue 132) confirmed the
need: a rate-limited resume re-arm left an **answered** escalation at
`awaiting-answer` with no `ready-for-agent` — invisible to `ralph-answer`
(already-answered) *and* to resume (no `ready-for-agent`). Point-fixing found
islands does not prevent the next one. We need a **structural** guarantee that
every open issue is always exactly one of: being worked, awaiting a human (on a
visible label), or terminal — and that anything else is made *visible within one tick*.

## Decision

Make a dead state impossible to *hide*. Three parts, all in `src/daemon/`:

1. **A total classifier** (`completeness.ts`). One pure function maps the fully
   resolved state of an issue/run — (labels × run status × in-flight × wedged × gate
   × resumable × answered × issue state) — into exactly one of `{eligible, in-flight,
   awaiting-human, terminal}`, or an `anomaly` with a reason. It is **total**: every
   combination returns a verdict, and anything contradictory or unknown (a
   `running` row the daemon isn't executing; a non-terminal run whose issue is
   closed; an answered pause nothing can resume; a pause still on its label but whose
   latest question is already answered, never re-armed (legacy issue 132); a human-attention
   label with no run to resume; an in-flight run wedged past its lifetime ceiling,
   i.e. the wall-clock failed to settle it; a status the code does not know) returns
   `anomaly` rather than falling through. Pure, so it is exhaustively matrix-tested.

2. **A completeness pass each tick** (`reconciler.ts#surfaceAnomalies`). Classify
   every open issue and every non-terminal run; surface each `anomaly` as a
   `daemon-anomaly` label + a structured `daemon.anomaly` log (and a run-log row for
   the TUI), and clear the label once the issue is no longer anomalous. Unknown
   state becomes a *visible* anomaly, never a silent island.

3. **An orphan / liveness sweeper each tick** (`reconciler.ts#sweep`). Auto-remediate
   the **slot-safe** cases: a `running` row the daemon isn't executing (re-drive if its
   PR survives, else terminate), a non-terminal run whose issue closed under it
   (terminate + prune), an in-flight run wedged past `scheduler.maxRunLifetimeSeconds`
   (terminate through the executor's abort handle — see Scope below), and a tracked
   worktree no live run/agent references (prune). The same orphan pass the startup
   reconcile (legacy issue 8) runs, now run continuously. A wedged run is **both surfaced**
   (part 2) **and actively terminated** (legacy issue 61) — see Scope below.

`daemon-anomaly` is a **human-attention state**, peer to `agent-stuck` /
`awaiting-answer` / `review-maxed`: the reconciler advances nothing in it; a human
reads the reason and repairs the underlying state (or closes the issue). The
daemon self-creates the label on the target repo on first use, so no manual setup
is required.

## Scope — wedged in-flight runs are surfaced *and* slot-safely auto-terminated (legacy issue 61)

A wedged in-flight run — one past its lifetime ceiling because the per-session
wall-clock (legacy issue 13) failed to settle it — still **holds a reconciler slot backed by a
live executor session**. The first cut of the sweeper force-terminated it by
deleting its entry from the in-flight slot map directly. That added a *second
writer* to the slot map besides `occupySlot` (breaking its documented "single home"
cap-accounting invariant) and, worse, freed a slot whose underlying session was
still running — so a new agent could be launched onto a host still executing the
wedged one. A slot can only be safely freed by the executor that owns it.

legacy issue 61 resolves this by giving the executor that capability rather than routing
around it. The executor owns a per-run `AbortController` (keyed by issue number),
linked into every session a run drives (impl/resume, then review/fix); its
`terminate(issueNumber)` aborts the controller, ending the live `query()` iteration
and — through the per-session reaper linked to the same signal — its subprocess tree.
The sweep terminates a wedged run through that handle (`reconciler.ts#terminateWedged`):
the aborted session throws, the failure guard terminalizes the run to `agent-stuck`
and prunes its worktree, and the slot frees through `occupySlot`'s single `.finally`.
The reconciler never writes the in-flight map, so the "single home" invariant holds
and the slot is never freed while its session is still alive.

Surfacing is unchanged and runs in parallel — it *is* the no-silent-loss guarantee:
a wedged in-flight run is classified an `anomaly` (`run-wedged-past-lifetime`) and
surfaced as a `daemon-anomaly` within one tick — never a silent island — and stays
surfaced until the killed session settles the run terminal, at which point the label
self-clears. A daemon restart, whose `rehydrate` reconciles orphaned `running` rows,
remains a backstop.

## Consequences

- **Unattended auto-merge has a stated completion criterion.** Merging with no
  human in the loop is only safe while, after every tick, every open issue is
  provably being worked, visibly waiting, or terminal — never silently dropped.
  This invariant *is* that criterion (DESIGN §9a, OPERATING.md §3).
- **Regression-guarded as the daemon self-modifies.** The classifier is pure and
  matrix-tested over the full (label set × run status) space
  (`completeness.test.ts`); a future change that strands a combination either keeps
  it classified or trips the totality backstop → `anomaly`. The end-to-end surfacing
  and sweep are exercised through real ticks (`sweeper.test.ts`).
- **Self-healing, not sticky.** The `daemon-anomaly` label reflects current truth
  each tick — added on the edge into an anomaly, cleared on the edge out — so a
  resolved island (swept, or fixed by a human) does not leave a stale label.
- **Config gains** `scheduler.maxRunLifetimeSeconds` (default 21600 = 6h; `0`
  disables). It must exceed the per-session wall-clock; it is the threshold past
  which an in-flight run is judged wedged — surfaced as a `daemon-anomaly` and
  actively terminated through the executor's abort handle (legacy issue 61).
- **Composes with** the startup reconcile (legacy issue 8) and the per-session wall-clock
  (legacy issue 13): the sweeper is the same orphan pass run continuously, and the lifetime
  ceiling is the wall-clock's backstop — a wedged run becomes a visible anomaly and
  is slot-safely terminated rather than left a silent island.
