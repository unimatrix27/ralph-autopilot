# One Claude session-drive primitive owns terminal detection; disposition stays per-caller

## Context

The weekly-cap incident (commit `23e357e`) had to be fixed in **two places** —
`src/executor/agent.ts` (impl) *and* `src/providers/claude-backend.ts` (review/fix/autoMode)
— because both reimplemented the SDK message-handling for a Claude session.

Both already share the session-drive primitive `runReapedWallClockedSession` (the controller
+ reaper + `buildAgentOptions` + wall-clock + transcript capture + the `query()` loop). What
was **duplicated** was the per-call-site `onMessage` body:

- `result` message → success-text extraction vs. error,
- `rate_limit_event` → `onRateLimit` / `router.record`,
- usage-cap detection → `UsageLimitError` + meter trip (added to BOTH in `23e357e`).

Divergence here is silent and dangerous: the cap bug terminalized the whole backlog to
`agent-stuck` from the review/fix copy while the impl copy behaved differently — the two
copies had already drifted, and a future cap-style fix would have to land in both again.

This decision is the architectural follow-up (legacy issue 146) so it never needs a two-place fix
again.

## Scope (confirmed by code audit)

- **Exactly two call sites** of `runReapedWallClockedSession`: impl (`SdkAgentRunner.run`) and
  `ClaudeSessionBackend.run`. review / fix / autoMode all funnel through the backend (the
  Claude mode classifier is a thin `ClaudeSessionBackend` runner — NOT a third site).
- **Codex backend is out of scope**: it shells the `codex` CLI, a separate implementation; it
  does not touch this primitive.
- **The `SessionBackend` interface is unchanged**: impl does NOT start routing through
  `SessionBackend.run` (that contract returns only text and has no escalate/stuck tools —
  forcing impl through it would drag the Codex backend along for a contract it doesn't use). We
  evolve the **shared primitive** instead.

## Decision

Evolve `runReapedWallClockedSession` into the single Claude session-drive primitive that owns
terminal **detection + classification**, but NOT the **disposition** of non-cap outcomes
(which legitimately differs per caller and must be preserved):

- impl treats a non-cap error result as non-fatal — **PR-presence is the source of truth**
  (`result.ok` is only logged; the executor reads the PR back from GitHub).
- backend treats a non-cap error result as **fatal** (it throws), because the *result text* is
  its contract.

### Primitive contract

- Replace the `onMessage` param with `onRateLimit?: (signal) => void` (its only consumers were
  the `result` + `rate_limit_event` handling, both now owned internally). Transcript capture
  stays inside.
- Returns a **classified result** on a normal end: `{ subtype; isError; text; turns }`.
- **Throws** the two terminals every caller recognises:
  - `UsageLimitError` on a usage cap — and first fires `onRateLimit({ status: "rejected",
    resetsAt })` (the meter trip moves here; the single owner, so no caller can double-trip or
    skip it).
  - `WallClockExceededError` on overrun (replaces the returned `{ expired }` flag).

### Caller mappings (disposition stays here)

- **backend.run()**: `if (r.isError) throw …; return r.text;` — both typed terminals propagate
  untouched.
- **impl.run()**: `catch WallClockExceededError` → the existing wall-clock stuck report;
  `catch isUsageLimitError` → `{ limited: true }` (it no longer records the rejected signal —
  the primitive already did); else `ok = !r.isError` and log `agent.result` off the return.

## Consequences

- **One primitive owns `rate_limit_event` forwarding + cap detection (+ meter trip) +
  wall-clock; no `result` / cap / rate-limit handling remains** in `agent.ts` or
  `claude-backend.ts` `onMessage` (the param is gone). A future cap-style fix is a one-place
  edit.
- **No double meter-trip.** The primitive trips once on cap; impl's catch must not (and does
  not) also trip. This is directly unit-tested.
- **Migration of the impl wall-clock path** from an `{ expired }` return to a
  `WallClockExceededError` catch is byte-identical (the stuck report is asserted unchanged).
- **A capped impl session stops emitting `agent.result`** (it throws first); `agent.usage-limited`
  covers it.
- **The `SessionBackend` seam is unchanged**, so Codex is unaffected and the provider contract
  stays "run a session, return text."
