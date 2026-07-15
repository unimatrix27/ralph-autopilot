# Actual state is event-sourced; GitHub stays the source of truth (extends ADR-0003)

The daemon's **actual state** — its own decisions (admit, launch, escalate,
fix-attempt, review-maxed, merge) — is recorded as an **append-only event log**, and
the current-state views the reconciler reads (`runs`, fix-attempt counts, resume
context) become **projections** folded from it. GitHub stays the source of truth for
**desired state** (labels, answers, issue bodies); ingestion stays poll-based
(ADR-0003) — no webhooks. "100% event-sourced" means the daemon's *own* state, not
GitHub's. An append-only core is easier to extend, audit, and develop against
(including with AI) than in-place CRUD — the storage shape for an enterprise harness.

It reuses the existing per-repo `ScopedStore` (ADR-0020): streams are repo-scoped and
the global build budget is unchanged. Projections update **inline** — in the same
SQLite transaction as the append (`better-sqlite3` is synchronous) — so no async lag,
no dual-write, no separate read store. Durability is unchanged from ADR-0003: normal
restart folds the local log (now recovering full *history*, not just current-state
rows); on catastrophic loss, current state re-derives from GitHub as before, losing
only history, never correctness. The log is **durable-but-reconstructible**, never
precious. Inherently-local ephemeral state (agent PIDs, worktree paths) is not
event-sourced and can live in memory.

## Considered options

- **Webhooks / ingest GitHub's timeline as events.** Rejected: a level-triggered
  reconciler self-heals each tick; webhooks need a public ingress on a
  `bypassPermissions` box (OPERATING.md §2), don't replace polling (best-effort
  delivery still needs a reconcile backstop), and optimize a latency axis that is
  noise against multi-minute agent runs. Storage (ES) and delivery (webhooks) are
  orthogonal; we adopt the former only.
- **GitHub-only, no local store.** Rejected: makes GitHub the hot-path database (rate
  limits — worse multi-repo — no atomic transaction, no concurrency guard) and
  discards the queryable decision history GitHub can't hold without spamming issues.
- **A precious log.** Rejected: would weaken ADR-0003's "no permanent data loss."
