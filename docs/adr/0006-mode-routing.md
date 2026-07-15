# Route implementation strategy by an explicit mode label, decided at triage

An issue carries a `mode:tdd` (default) or `mode:infra` label that selects the
implementation prompt and the review shape — `tdd` gates on red-green-refactor and
a green test suite; `infra` (no-code / no-test work like infrastructure or config)
replaces the test gate with a mode-appropriate verification. The mode is stamped
by a human at triage, not guessed by the agent at runtime, keeping the system
grounded in hard facts. A missing mode defaults to `tdd` (most issues are code).

## Consequences

Two modes ship for the pilot; more (`docs`, `spike`) are added later by extending
the routing, not redesigning it. The `triage` skill is responsible for stamping
the mode.
