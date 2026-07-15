# GitHub rate-limit defer-not-stuck on the merge/resume terminal paths

## Context

[ADR-0023](0023-usage-limit-guard.md) made the daemon **defer, not `agent-stuck`**,
when a *Claude* OAuth usage limit is hit: a transient, self-clearing condition must
never become a terminal human-attention state. The **same defect class exists on the
GitHub side**, and bit in production overnight (2026-06-20→21). During a GitHub GraphQL
rate-limit window, two runs were terminalized `agent-stuck` by transient `gh` failures,
not by being genuinely stuck:

- **legacy issue 1922** reached `awaiting-merge` (review **and** CI clean), then `gh pr merge` failed
  with `GraphQL: API rate limit already exceeded` → `executor.integrate-failed` →
  terminalized `agent-stuck`. The `agent-stuck` **label swap then failed on the same
  limit**, leaving a SQLite(`agent-stuck`)↔GitHub(`awaiting-merge`) island and a
  closed-but-unmerged PR.
- **legacy issue 2069** hit `executor.resume-failed` in the same window and terminalized `agent-stuck`.

The `gh` client already has retry/backoff ([gh-cli.ts](../../src/github/gh-cli.ts)), but
the **terminal paths bypass or exhaust it**: a rate-limit error that survives the retries
throws to the post-claim failure guard (legacy issue 34)
and is terminalized `agent-stuck`. There was no GitHub analog of `isUsageLimitError`
classifying "transient GitHub limit → defer, don't terminalize."

## Decision

One predicate, **`isGitHubRateLimitError`** (the GitHub analog of `isUsageLimitError`,
ADR-0023) — matching the primary, secondary, and abuse/`403` wording GitHub writes to
stderr, scoped to `gh`-command errors so it never swallows an unrelated fault. It is the
single source of truth for "transient GitHub limit," used at two layers: the gh-client
retry choke point (as before), and the executor's terminal paths, which now **defer
instead of `agent-stuck`** when a limit survives those retries:

1. **Integrate/merge path.** When `gh pr merge` (or any pre-merge `gh` step under the
   merge lease) fails `isGitHubRateLimitError`, the executor does **not** terminalize:
   the run already passed review + CI, so it is left `awaiting-merge` (status **and** its
   queue label kept) and the next tick's merge worker retries the merge. No PR close, no
   label swap.

2. **Resume path.** A GitHub-rate-limit failure during a resumed session **defers** the
   run: restore its prior paused status (`awaiting-answer` / `review-maxed`) and re-arm
   `ready-for-agent`, so `findResumableRuns` re-resumes it next tick from the WIP branch
   (the work is checkpointed; nothing is lost).

   **Re-arm durability (legacy issue 132).**
   Unlike the `agent-stuck` terminal label (§3), `ready-for-agent` is an *intake* label, not
   a state-effect of the run-status projection — so the ADR-0027 outbox does **not** re-apply
   it. The deferred re-arm above is therefore best-effort, and during the original incident
   (`example-monorepo` legacy issue 2112/legacy issue 2113) it *also* lost to the same rate-limit window. That left
   an **answered** run at `awaiting-answer` with no `ready-for-agent`: invisible to
   `ralph-answer` (the latest comment is its own `ralph-answer`, so the question reads
   already-answered ⇒ unservable) **and** to resume (no `ready-for-agent`) — a silent island.
   The completeness pass now closes this: `scanPausedRuns`
   ([resume.ts](../../src/hitl/resume.ts)) detects a paused run whose latest `ralph-question`
   already carries a following `ralph-answer` but that lacks `ready-for-agent`, the reconciler
   **idempotently re-arms it every tick** until the write lands (the persisted state — the
   paused run row + the durable `ralph-answer` on GitHub — survives a daemon restart, where
   any in-memory retry intent would not), and `classifyIssueState` surfaces it as a
   `daemon-anomaly` (reason `answered-pause-stranded`) so the wedge is visible within one tick
   rather than parked silently ([ADR-0016](0016-reconciler-completeness-invariant.md)). Retried
   until it lands *or* surfaced as an anomaly — never silently stranded.

3. **Label-swap durability.** If applying the `agent-stuck` terminal label itself fails on
   a rate limit, no separate retry is needed: the daemon-set state labels — `agent-stuck`
   among them — are level-triggered **effects** of the run-status projection, relocated into
   the reconciler's per-tick outbox by [ADR-0027](0027-reconciler-as-outbox.md).
   Each tick `surfaceAnomalies` already diffs the desired state label (from the run status)
   against the actual GitHub labels and re-applies the difference idempotently — with the
   same skip conditions a rate-limited swap needs (it yields to `ready-for-agent`, an
   operator heal in progress, and to a `daemon-anomaly` claim-park's sole surface). So an
   `agent-stuck` run whose label write lost to a rate limit re-acquires the label on the
   next tick from the single-writer outbox, keeping the completeness invariant
   ([ADR-0016](0016-reconciler-completeness-invariant.md)) holding without a second writer
   of the label (which ADR-0027 forbids).

A genuine fault on any of these paths still terminalizes `agent-stuck` exactly as before
— the defer is scoped to `isGitHubRateLimitError`.

## Consequences

- A transient GitHub limit on the merge/resume/label paths no longer manufactures
  `agent-stuck`; the run self-heals when the window clears (the merge retries, the resume
  re-resumes, the ADR-0027 outbox re-applies the label), and no human is paged for a
  rate-limit casualty.
- No silent SQLite↔GitHub island: a terminal label swap that loses to a rate limit is
  re-applied by the per-tick outbox, not left for a human to happen upon.
- Same family as ADR-0023 and the existing `gh` retry/backoff — GitHub is the source of
  truth ([ADR-0003](0003-reconciler-poll.md)); a transient external limit is retried or
  deferred, never turned into a terminal human state.
- The **read amplification** that drives the daemon into these windows (the off-slot
  CI-park reads, flagged in legacy issue 88's phase-2 review) is what makes the limit likely; cutting
  that read volume is a complementary follow-up — this decision is about not terminalizing
  when a limit is nonetheless hit.
