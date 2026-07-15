# Dual-subscription rotation — route sessions across two OAuth logins; pause only when both are exhausted

> **Amended by ADR-0037.** The two-Claude-login meter generalises to a per-provider
> **account pool** (N accounts per provider, including zero); the headroom/rotation logic
> here is lifted to "a provider has headroom iff one of its accounts is not gated", and
> `usageLimit.subscriptions` becomes the Claude slice of that pool.

## Context

The daemon drives every agent through one OAuth subscription (ADR-0008), and
ADR-0023 made a hit usage limit a **defer**, not an `agent-stuck`: the shared
`UsageMeter` reads each plan window's live `utilization` + `resets_at`, gates
admission at `admitBelowPercent` (85%), and pauses the whole daemon until the
window resets. Correct, but when that one plan is exhausted the daemon idles even
though the operator may hold **a second** Claude subscription with headroom.

We want the daemon to use both plan budgets — switch to a fresh login instead of
pausing — and pause only when **every** login is exhausted.

The constraint that shapes the design: ADR-0008 forbids API keys, and the Agent
SDK selects a credential by `CLAUDE_CONFIG_DIR` (on this Linux box the OAuth
credential is a file, `<dir>/.credentials.json`, written by `claude login`). So a
second subscription is a second *login dir*, not a token in config.

## Decision

A **daemon-wide active-login pointer**. New impl sessions bind to the active
login; the cap is untouched (ADR-0020 stays one global pool — this changes *which*
credential the next session uses, never *how many* run).

- **Routing (the edge).** `buildAgentOptions` sets `env.CLAUDE_CONFIG_DIR` to the
  active login's store; the SDK passes it to the spawned CLI, which reads its OAuth
  credential **and** writes its transcripts there, so two concurrent sessions on
  different stores are fully isolated. Still OAuth-only, still
  `forceLoginMethod:"claudeai"` — ADR-0008's letter holds; only its "one plan per
  box" spirit bends to two.
- **Meter (the core).** `UsageMeter` holds one `UsageState` **per login** keyed by
  id, plus the active pointer. Each streamed `SDKRateLimitEvent` is folded into the
  **bound login's** state (the `UsageRouter` seam carries the token id), so the two
  windows never cross-pollute. `gate()` reads the active login.
- **Switch triggers.** The active login flips when it hits `admitBelowPercent` or a
  cooldown (the **safety** trigger — exactly the moment ADR-0023 would have
  deferred) **or** when `rotateEveryMinutes` elapses (the **even-wear** trigger). A
  flip only lands on a login that itself has headroom; an unknown (never-streamed)
  login is optimistically eligible and self-corrects after its first session. The
  selection is a pure function (`pickActiveToken`), exhaustively tested.
- **Failure = ADR-0023, per login.** A mid-session `rejected` returns `limited`
  (never `agent-stuck`); the executor restores `ready-for-agent` and drops the run.
  The cooldown is now **per login**, and the pointer flips, so the dropped issue
  re-admits next tick on the other login. Only when **all** logins are gated does
  the gate refuse and the daemon defer — the ADR-0023 whole-daemon pause, now
  reached only when both budgets are spent.
- **Config.** A global `usageLimit.subscriptions: [{id, configDir}]` +
  `rotateEveryMinutes`. `admitBelowPercent` is reused as the per-login threshold.
  Zero or one entry → the box-default single login, byte-for-byte ADR-0023. Boot
  validates each store carries a `.credentials.json`; a configured-but-unauthenticated
  store is skipped with a loud warning, and an all-invalid block halts.

## Consequences

- The daemon keeps building across a plan-limit wall instead of idling, up to the
  combined budget of both plans; it still self-heals when the earlier window resets.
- **Scope: every SDK runner is routed.** The impl runner binds inline; the review,
  fix, and moding-classifier runners bind through the same `UsageRouter` via the
  shared `runStructuredSession` seam (`bindSession`). So a busy review/fix/moding
  session also fails over instead of maxing a phase on one exhausted login, and the
  `≤3` fix attempts per phase give in-phase failover (attempt 1 trips login A →
  attempts 2–3 bind to login B). The box-default `~/.claude` is now used only when
  no `subscriptions` are configured.
- **Blast radius (OPERATING.md §2):** a second credential on the box is *not*
  isolated by its config dir (same user reads both). Two logins = one more Claude
  account in the blast radius; acceptable on the dedicated, credential-free box.
- **ToS:** two subscriptions driven from one automated box is an operator decision.
  This is recorded as **cleared / risk-accepted** by the operator; the daemon makes
  no attempt to disguise the automation, and either login can be removed by deleting
  the block.
