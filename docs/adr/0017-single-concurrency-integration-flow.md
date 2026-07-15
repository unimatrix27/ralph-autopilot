# Single-concurrency integration (resolve+merge) flow behind the high-concurrency build pool

ADR-0014 made the merge a deterministic, rebase-aware harness action, but every run
still merged inside its own high-concurrency build slot. At a real concurrency cap
that races: N branches rebase onto the same base and merge in parallel, so the
second-and-later PRs go stale the instant the first lands — the parallel-edit
pileup. The rebase-aware merge *mitigates* it (each PR rebases before merging) but
does not *serialize* it, so the daemon had to run at `maxConcurrentAgents: 1`.

This ADR splits the run lifecycle into two flows and serializes the one genuinely
racy step. It generalizes the resolve-before-review fix (the `syncWithBase` guard)
into a single invariant:

> Every step that touches an existing PR may only run when the branch is current
> with base. A `resolve` guard re-establishes that before each step; it is a cheap
> no-op when base has not moved, and re-gates CI when a resolve moves the branch.
> The only way to give up is to escalate.

## Two flows

1. **Build flow** (high concurrency, ≤ `maxConcurrentAgents`). Claim → impl →
   `[resolve]` CI gate → `[resolve]` review P1 → P2. On success the run does **not**
   merge: `ReviewLoop.runReview` returns `awaiting-merge`, the executor sets that
   run status, adds the durable `awaiting-merge` issue label, and frees the build
   slot (the worktree is torn down as usual).

2. **Integration flow** (SINGLE concurrency). The reconciler holds one merge lease
   (a size-1 in-flight set, separate from the build pool, serviced every tick —
   including when the build pool is full — and throughout drain). It pulls the
   oldest `awaiting-merge` run FIFO, re-attaches its worktree (resume-style, not a
   fresh impl), and runs `ReviewLoop.runIntegration` under the lease. Nothing else
   advances base while the lease is held, so the resolve converges in one pass.

## The integration step — keyed on whether the branch *moved*

`syncWithBase` already reports `moved`. `runIntegration`:

- **not moved** → nothing changed since review; prior gates hold → **merge**.
- **moved** (clean replay onto an advanced base *or* a conflict resolution — both
  can break semantics with green CI) → **re-review P1+P2 under the lease**, re-gate
  CI (re-review may have pushed fixes), then merge.

Re-review happens **under the lease**, never by bouncing the run back to the build
pool: bouncing would surrender the lease and FIFO head position and livelock the
contended cohort (O(N) re-reviews for the tail run). Under the lease the head
always makes terminal progress, so the queue strictly shrinks → starvation-free.
Re-review is bounded by `review.maxFixAttempts`; exhaustion → `review-maxed`, which
releases the lease.

(Follow-up: when the rebase is a pure fast-forward replay whose net branch diff vs
base is unchanged, skip re-review and re-gate CI only. Implemented conservatively
first — any `moved` re-reviews.)

## Durable marker

A run in `awaiting-merge` is observationally identical on GitHub to an in-flight
review run (open PR, green CI, both phases done, no awaiting label). So the handoff
carries a positive `awaiting-merge` **issue label**, set on handoff and cleared
when integration terminalizes. Rehydrate (ADR-0003) reads it to rebuild the merge
queue from GitHub on a cold-store restart — distinct from an in-flight review run,
which it would otherwise re-review and merge off-lease.

## Consequences

- `RunStatus` gains `awaiting-merge` (non-terminal, not in `RE_ADMITTABLE_STATUSES`,
  so it holds the issue). `core/labels` gains `LABEL_AWAITING_MERGE` (also in
  `PAUSED_LABELS`, defence-in-depth).
- **Drain** services the merge worker until the build pool, the lease, AND the
  `awaiting-merge` queue are all empty: draining build runs *feed* the queue, so a
  one-shot await of the in-flight snapshot would strand merged-ready PRs.
- **Crash-safe / re-entrant.** The integrating run keeps status `awaiting-merge`
  (the lease, not the status, marks "currently integrating"), so a crash re-picks
  it; re-attach + `--force-with-lease` make a re-resolve from the last pushed commit
  idempotent.
- **High concurrency is safe again.** Only one branch races base at a time, so
  `maxConcurrentAgents` can return to ~10. The merge throughput ceiling becomes one
  integration at a time — acceptable: integration is fast unless base moved, and a
  serialized merge train is the correct model for a shared trunk.
- Escalation during integration (a rebase conflict needing a human) → `awaiting-answer`;
  the lease releases and the run resumes through the normal answer path. Routing an
  integration-origin resume straight back to integration (rather than through the
  impl/review path) is the same open refinement tracked for review-loop escalations.
