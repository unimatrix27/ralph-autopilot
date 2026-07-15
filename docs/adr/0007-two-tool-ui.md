# Two UIs with two data sources: a local SQLite TUI and a portable GitHub-only answer CLI

> **Status (partial):** the **monitoring TUI half of this decision is retired**
> (legacy issue 120) — superseded as the operator's window by the embedded web control
> plane ([ADR-0029](0029-embedded-web-control-plane.md)), which reuses the same
> pure `projection/snapshot.ts` projection. The **`ralph-answer` CLI** half stands. The
> rationale below is the original, point-in-time record.

Monitoring and answering are split because they have different reach
requirements. The **monitoring TUI** (Ink) runs on the daemon box and reads SQLite
for live runtime detail (agent activity, log tails, ~1s refresh) that GitHub does
not hold. The **`ralph-answer` CLI** is a thin GitHub-only client that runs
*anywhere* and serves open questions one at a time in a forever loop — its
portability is exactly why the question/answer transport lives in GitHub
(reachable from any machine), not in the daemon's local store.

## Consequences

- The operator never answers in the GitHub web UI; `ralph-answer` is the
  interface and uses GitHub purely as the wire (writes a `ralph-answer` comment +
  swaps the label).
- `review-maxed` heal-cards flow through the same one-at-a-time queue as
  escalations — same shape, same loop.
- MVP answer path is this CLI; an in-UI answer box and any controls are deferred
  to the post-MVP web UI. The TUI and CLI are both read-mostly seeds of it.
- The TUI stays **SQLite-only and read-only** even for the backlog view (the
  eligible queue, blocked issues, paused/stuck). Rather than let the viewer call
  GitHub, the daemon — which already polls GitHub and computes eligibility each
  tick — persists a per-tick **backlog snapshot** to SQLite (`daemon_snapshot`),
  and the TUI reads it. This preserves the portability/no-auth/no-latency
  properties above with no deviation from this ADR (legacy issue 20).
