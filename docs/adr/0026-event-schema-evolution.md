# Event schema evolution: tolerant reader, additive-only, rebuild as escape hatch

Events are plain JSON with a `type` discriminator; evolution is **tolerant-reader +
additive-only**. Binding discipline: **never mutate or remove a field on an existing
event type in place — only add optional fields, or mint a new type** (`RunStartedV2`),
so events written months ago stay replayable. A breaking change uses a new type or —
when history across it isn't needed — a **rebuild-from-GitHub** (ADR-0003/0021). No
upcaster framework up front: the log is reconstructible (ADR-0021), which is exactly
when upcasters are *not* mandatory.

## Considered options

- **Per-event versioning + upcaster pipeline up front** — rejected as premature
  machinery the rebuildable log makes unnecessary until proven otherwise.

## Consequences

The "add or mint, never mutate in place" rule must live in the implement/review prompt
templates (sibling to the design-authority and no-deferral rules). The first breaking
change that must preserve history is the trigger to add a minimal upcaster.
