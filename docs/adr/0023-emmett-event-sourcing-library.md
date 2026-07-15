# Emmett as the event-sourcing library, on its SQLite backend

We implement the event log (ADR-0021) with **Emmett** (`@event-driven-io/emmett` +
`emmett-sqlite`) rather than a hand-rolled store: it is the only actively-maintained
TypeScript event-sourcing *library* that provides the decider/projection model while
abstracting the store — matching the requirements "a library" and "store-agnostic."
We start on the **SQLite** backend (zero-ops, embedded); Postgres/EventStoreDB remain
a later backend swap without rewriting deciders or projections. The decider model
(`decide`/`evolve`, pure functions) fits this repo's DI + pure-core grain.

License risk (Emmett's license is pending, RFC toward AGPLv3/SSPL) is accepted —
personal, single-operator use. Exit hatch: deciders are plain functions and payloads
plain JSON, so the event model is portable off Emmett.

## Considered options

- **Roll-your-own on `better-sqlite3`** — rejected by the operator in favour of a
  maintained library.
- **Castore** — rejected: its only durable adapter is DynamoDB, and OPERATING.md §2
  forbids prod AWS credentials on the box.
- **EventStoreDB / KurrentDB** — rejected: a separate gRPC server with a restrictive
  server license; its Node package is a network client, not the programming-model
  library wanted.

## Consequences

**Spike before committing code:** confirm Emmett-SQLite gives **synchronous,
same-transaction** projections (not async-only) — the reconciler reads projections
every tick and must not act on stale state. A later swap to Postgres may shift
projections to async/eventual consistency; re-evaluate the reconciler's staleness
assumptions then.
