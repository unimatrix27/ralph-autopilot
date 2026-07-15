# Usage-limit guard — defer-not-stuck on the Claude plan limit, and gate admission at a utilization threshold

## Context

The daemon drives agents through the Claude Agent SDK under an **OAuth subscription**
(never an API key). That plan has rolling **usage windows** — a 5-hour window and
several weekly (7-day) windows — and when one is exhausted a session ends with
`You've hit your session limit · resets <time>`.

Two failures followed, both observed in production:

1. **The limit was terminalizing successful work into `agent-stuck`.** A session-limit
   error threw out of the agent runner, the post-claim failure guard (legacy issue 34)
   caught it, and the run was flipped to the human-attention terminal `agent-stuck` —
   exactly the wrong response to a *transient, self-clearing* condition. Worse, it was
   self-amplifying: every issue admitted while the window was exhausted failed
   instantly and went stuck, converting the whole backlog to `agent-stuck` in one
   burst. This is the same defect class as a GitHub rate-limit storm
   ([the gh-client retry/backoff work](../../src/github/gh-cli.ts)).

2. **The daemon kept starting work it could not finish**, burning agent slots on
   sessions doomed to hit the wall.

The SDK already surfaces what is needed to prevent both: for OAuth sessions it streams
an `SDKRateLimitEvent` carrying each window's `utilization` (0-100) and `resets_at`, and
a `status` of `allowed` / `allowed_warning` / `rejected`.

## Decision

A **shared usage meter** (one per daemon, across all targets — the OAuth budget is
global, like `maxConcurrentAgents`) folds the streamed signals into a small pure
`UsageState` (per-window utilization + a global `cooldownUntilMs`). Two levers act on
it, both pure (`src/core/usage.ts`), applied at the edges:

1. **Defer, never `agent-stuck` (reactive).** When a session aborts on a usage limit
   (`isUsageLimitError`), the agent runner returns a `limited` result instead of
   throwing, so the failure guard is never reached. The executor then **restores
   `ready-for-agent` and drops the run** (`deleteRunByIssue`) — a clean slate, no work
   to preserve since the session aborted — and the meter's **cooldown** (set from the
   `rejected` event's precise `resets_at`, or a conservative fallback) blocks
   re-admission until the window resets. The issue self-heals into the backlog; no
   human is paged.

2. **Gate admission at a threshold (proactive).** Each tick, the reconciler consults
   `usageGate`: while a cooldown is active, or any window's utilization is at/above
   `usageLimit.admitBelowPercent` (default **85**), it admits **nothing new** — no
   fill, no resume, no moding pass — by passing `openSlots: 0` to the existing
   `admit()`. In-flight runs and the read-only backlog snapshot are unaffected.

Config is one global block (not per-target): `usageLimit: { enabled (default true),
admitBelowPercent (default 85) }`.

## Consequences

- A hit usage limit no longer manufactures `agent-stuck`; the backlog is preserved and
  resumes automatically when the window resets. The cooldown is exact (read from the
  plan's own `resets_at`), so the daemon neither hammers a closed window nor idles past
  the reset.
- Peak useful work rises: slots are not spent on sessions that will hit the wall.
- The guard is **reactive + proactive** on purpose. The reactive deferral is the
  correctness fix (it cannot be skipped); the proactive gate is prevention layered on
  top, and degrades to a no-op when the SDK reports no plan windows
  (`rate_limits_available: false`, e.g. an API-key session) since no `rejected`/window
  signal ever arrives.
- **Scoped to the impl agent runner for now.** The review/fix runners and the moding
  classifier also run SDK sessions; the proactive gate already stops most of their work
  from starting (review only follows an admitted impl), but a usage limit hit *mid
  review* still maxes the phase rather than deferring. Wiring the meter through the
  review/fix runners is a follow-up — the same `RateLimitListener` seam extends to them.
- Same family as the GitHub rate-limit handling: a transient external limit is retried
  or deferred, never turned into a terminal human state.
