# Review as a durable step machine — the PR comment is the review→fix message bus

## Context

The reconciler models the whole system as a step machine: every tick diffs desired
state (GitHub labels) against actual state and advances one step. Most of the loop
honours this — admission, the off-slot merge lease ([ADR-0017](0017-single-concurrency-integration-flow.md)),
HITL resume-not-restart ([ADR-0004](0004-async-escalate.md)), `rehydrate` rebuilding
SQLite from GitHub. The one place that does **not** is the review loop
([ADR-0014](0014-harness-owned-ci-gated-rebase-aware-merge.md)): `driveSession →
runReviewLoop` runs **Phase 0** CI gate → **Phase 1** review → **Phase 2** thermo as
one continuous, in-process procedure that holds a build slot from impl all the way to
hand-off, and on a drain or crash mid-review must re-drive the whole loop.

Two costs follow:

1. **The pre-review CI gate holds a build slot to poll `gh pr checks`.** Phase 0
   waits for the target's CI to go green *before* review, occupying a precious agent
   slot for minutes doing nothing but polling — while real work queues. (The
   *pre-merge* CI wait is already off-slot inside `integrate()`; the *pre-review* one
   is not.)

2. **Review and fix are coupled only incidentally.** They are already **two separate
   fresh-context SDK sessions** (`SdkReviewAgentRunner`, `SdkFixAgentRunner`) that
   share no model conversation. Their entire hand-off is already serialised to
   GitHub: the review agent's worklist is posted as the rolling `ralph-review`
   comment (legacy issue 47), and `FixContext` is explicit that the in-process worklist is
   *"a cache of what the loop posted to the PR; the authoritative copy is the
   `reviewComment` … GitHub is the source of truth, not the in-process worklist."*
   So nothing authoritative is lost by decoupling them — the only thing binding them
   is that they happen to run in the same in-process loop holding the same slot.

The review loop is the last component that violates the system's own thesis (GitHub
is the source of truth; labels are the protocol; resume-not-restart). This ADR makes
it conform.

## Decision

Treat each **phase step** as an atomic, independently-admitted unit of work whose
only durable input/output is the PR — the `ralph-review` comment is the **message
bus**, and the PR carries the **cursor** (current phase + sub-step + attempt count).
The reconciler schedules whichever step is due, runs exactly that step, records its
result on the PR, and stops — freeing the slot between steps.

The model, by step:

- **Implement** → open PR → stop. (Already true.)
- **CI gate (off-slot).** "Awaiting CI" becomes a durable, off-build-pool state,
  exactly like `awaiting-merge` ([ADR-0017](0017-single-concurrency-integration-flow.md)):
  the run yields its slot and a poller advances it when checks settle. No agent
  context is held while waiting, so this is a clean cut with nothing to re-prime.
- **Review** = a producer step: read the diff + PR comments, write the `ralph-review`
  comment for the phase, advance the cursor, stop.
- **Fix** = a consumer step: cold-read that comment (the authoritative worklist),
  re-attach the branch (as `integrate()` already does), resolve the gating items,
  push, update the comment/marker, advance the cursor, stop.

Five rules make this safe:

1. **The PR comment is the only review→fix channel.** A fix step reads the
   `ralph-review` comment (`parseReviewComment` / `RALPH_REVIEW_FENCE`), never an
   in-process worklist. The in-process worklist cache is deleted as a dependency: a
   fix step started cold from a bare PR must reach the identical decision a hot one
   would. This is already the documented contract; the change is to *rely* on it.

2. **The attempt budget moves onto the PR.** The `≤ maxFixAttempts` count is today an
   in-process loop counter; decoupled cold steps would reset it on every restart and
   loop a phase forever, losing the `review-maxed` guarantee. The per-phase attempt
   count is persisted on the PR (the phase marker — `buildPhaseMarker` /
   `parsePhaseMarker`, or the review comment payload). Every cold fix step reads it
   and, at the cap, terminalizes to `review-maxed` + heal-card. **This is the crux of
   the change** — get it wrong and the maxout invariant is lost.

3. **The phase cursor lives on the PR.** Which phase (0/1/2) and which sub-step
   (review vs fix) is due is read from the PR marker, not in-process state. Admission
   picks up "a PR needing its next phase step" as a first-class unit alongside "an
   issue needing impl". One off-slot label (`awaiting-ci`, mirroring `awaiting-merge`)
   makes the wait visible to the completeness pass and the TUI.

4. **Every step is idempotent and leaves the branch pushed.** A step that crashes
   after pushing but before recording must be safely re-runnable from the PR + git
   state (re-reading the comment + `git log` makes it re-entrant). A cut point is
   legal only where the branch is clean and pushed — so cuts land at the *waits* and
   at *post-push* boundaries, never mid-rebase or on an uncommitted fix.

5. **Completeness stays total.** Each new durable state (`awaiting-ci`, an explicit
   review/fix-pending cursor) is added to `classifyIssueState`
   ([ADR-0016](0016-reconciler-completeness-invariant.md)) **with its matrix test**,
   one at a time, so no PR can fall into an unclassifiable island.

## Staged migration

Each stage is independently shippable and independently valuable:

1. **Off-slot CI gate.** Move the Phase 0 pre-review CI wait off the build pool into
   a durable `awaiting-ci` state, advanced by a poller like the merge lease. Biggest
   immediate win (reclaims slots, survives drain), smallest blast radius, no change to
   the review/fix decomposition. Do this first.
2. **Externalise the attempt budget.** Persist the per-phase fix-attempt count on the
   PR and read it cold. No decomposition yet — just stop relying on the in-process
   counter. This de-risks stage 3.
3. **Split review and fix into separately-admitted steps** reading the `ralph-review`
   comment as the sole channel. With (1) and (2) in place this is mechanical.

## Consequences

- The review loop becomes legible and drain/crash-resilient: each step's result is a
  visible event on the PR, and a drain mid-review loses at most one step, not the
  whole loop. A restart resumes from the PR cursor, not from scratch.
- Slots free between steps; the daemon stops burning an agent slot to poll CI. Peak
  useful concurrency rises without raising the cap.
- The cost is **more GitHub round-trips and more wall-clock**: each cold step
  re-reads the PR + comments instead of holding them in memory, and review↔fix
  ping-pongs across 30s ticks. Given rate-limit pressure is real (the incident that
  motivated the gh-client retry/backoff), each step's read must be lean (one targeted
  comment fetch, not a re-scan) and steps must not re-pickup faster than a phase
  actually advances.
- This is the natural extension of resume-not-restart ([ADR-0004](0004-async-escalate.md))
  and the reconciler-completeness invariant ([ADR-0016](0016-reconciler-completeness-invariant.md))
  to the review loop. It does not change the review rubrics
  ([ADR-0012](0012-hardcoded-review-rubrics.md)) or the harness-owned merge
  ([ADR-0014](0014-harness-owned-ci-gated-rebase-aware-merge.md)) — only *where the
  loop's state lives* and *when it holds a slot*.
