# Strangler migration to event sourcing: runnable after every slice, zero data migration

We migrate to event sourcing (ADR-0021/0023/0024) as a **strangler** — one state
cluster at a time, behind the existing `Store`/`ScopedStore` interface — not a
big-bang branch. **Every slice must leave the daemon fully runnable** (build + tests
green, daemon boots and reconciles, completeness invariant intact, independently
mergeable): the daemon self-updates by adopting merged commits (ADR-0018), so any
slice may run in production.

**No data migration.** The store is rebuildable from GitHub (ADR-0003) — the same
approach multi-repo's v4 migration already took (clear runtime tables, rehydrate from
open PRs). Each cutover rebuilds fresh; a botched slice is recoverable by revert +
rebuild.

## Technique

- Mutating methods (`setRunStatus`, `incrementFixAttempts`) become **shims that append
  the matching event** while the interface stays stable; readers fold projections.
  CRUD tables + shims are removed in a final cleanup slice. No runtime feature flag —
  each cluster is CRUD- or event-backed per commit.
- The existing test suite + fakes are the **equivalence proof** per slice; the pure
  cores (`admit`, `classifyIssueState`) keep identical logic over projections.

## Sequencing

1. **Step zero — the Emmett-SQLite inline-projection spike** (ADR-0023).
2. Order by blast radius: `fix_attempts` first (a fresh budget on a glitch is
   harmless), then `open_questions`/`resume_context`, then `runs.status` **last** (it
   gates admission and the completeness invariant).

## Considered options

- **Big-bang feature branch** — rejected: a large, hard-to-roll-back swap into a
  self-updating daemon, fighting the repo's each-PR-green workflow.
