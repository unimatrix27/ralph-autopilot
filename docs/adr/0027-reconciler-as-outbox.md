# Effects are delivered by the reconciler as a level-triggered outbox

Daemon-set GitHub label swaps — *effects* of events (ADR-0024) — are delivered by the
**reconciler itself**, not a separate outbox. The projection defines the *desired*
daemon-set labels per issue; each tick the reconciler diffs desired (projection)
against actual (GitHub) and applies the difference, idempotently. A failed effect
reapplies next tick. No outbox table, cursor, or dispatcher.

Why: this *is* the reconciler's existing job — "diff desired vs actual, apply the
difference" — now with the desired side from a projection. Label-setting is idempotent
and the loop level-triggered, so reapply is a no-op and delivery self-heals — the
robustness that motivated rejecting webhooks (ADR-0003) and keeping the log
reconstructible (ADR-0021). On catastrophic loss, rebuilding the projection from
GitHub re-derives the desired labels — no orphaned outbox rows.

## Considered options

- **Transactional outbox** (event + outbox row in one transaction, a separate
  dispatcher with retry) — rejected: it reintroduces an edge-triggered delivery path
  plus retry state, warranted only for non-idempotent or latency-critical effects,
  which daemon-set labels are not.

## Consequences

Imperative label swaps at transition points relocate into the per-tick
desired-vs-actual diff (the desired set read from the projection alongside the
human-set intake labels). Up-to-one-tick effect latency is accepted (consistent with
ADR-0003).
