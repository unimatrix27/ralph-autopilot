# Per-issue event streams (the issue is the aggregate)

The aggregate and consistency boundary of the event log (ADR-0021) is the **issue**,
repo-scoped: `stream_id = <repo>#<issue>` — aligning with the schema multi-repo
already uses (`UNIQUE(repo, issue_number)`, ADR-0020). Every event across *every*
pickup of an issue lands in one continuous stream; a **run** is a
`RunStarted … RunEnded` span within it, and `runId` is a correlation tag, not a
durable identity. Daemon-lifecycle events that belong to no issue (startup, drain,
self-update) go in a separate **system stream**.

Why the issue, not the run: it is the stable business key (GitHub keys on it; the
completeness invariant classifies per issue), one continuous per-issue history is the
audit/AI artifact we want, and admission guarantees at most one live run per issue —
so a per-issue stream has a single writer and clean `expected-version` concurrency.

## Considered options

- **Per-run streams** — rejected: a re-pickup starts a new stream, shredding one
  issue's history.
- **One global stream** — rejected: no per-aggregate isolation; every issue contends
  on one version counter.

## Consequences

`runId` demotes to an in-stream correlation tag; the `deleteRunByIssue`-then-recreate
dance becomes appended events (a re-pickup is `RunStarted` again, no destructive
delete).
