# Event modeling: business facts, derived projections, labels as effects

Three rules govern the event vocabulary (ADR-0021):

1. **Events are past-tense business facts** (`RunStarted`, `Escalated`,
   `FixAttempted`, `Merged`), never generic CRUD-events — there is no
   `StatusChanged`/`Updated`.
2. **Derived state is a projection, never stored.** Run status and fix-attempt counts
   are folded from events — `setRunStatus`/`incrementFixAttempts` disappear; the fix
   count *is* the number of `FixAttempted` events in a phase.
3. **Observability stays in `run_log`, out of the event stream.** Test: does anything
   fold it into state? No ⇒ it's a log line.

Corollary: **daemon-set label swaps become *effects* projected from events** (an
outbox — ADR-0027), while **human-set labels are *intake*** that produces events.
`ready-for-agent → awaiting-answer` is the daemon reflecting `Escalated` — an effect,
not desired state.

Why: CRUD-events throw away *why* a thing changed; business-fact events keep meaning,
keep the store append-only, and make the model AI-navigable.

## Considered options

- **Mirror the `RunStatus` machine 1:1 as transition events** — rejected: CRUD in an
  event costume; it loses the derive-don't-store win.

## Consequences

Starter vocabulary (`RunStarted`, `Escalated`, `QuestionAnswered`, `Resumed`,
`PrOpened`, `FixAttempted`, `ReviewPhasePassed`, `ReviewMaxed`, `RunStuck`, `Merged`,
`RunEnded`, `AnomalyDetected`/`Cleared`) is a working set, finalized in code — not
frozen here.
