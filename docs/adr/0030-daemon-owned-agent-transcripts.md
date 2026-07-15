# Daemon-owned agent transcripts: capture the SDK message stream as first-class, prunable data

> Part of the web-control-plane design of record (legacy epic 106); see
> [ADR-0029](0029-embedded-web-control-plane.md) for the process model,
> [ADR-0031](0031-web-stack-and-contract.md) for the stack, and
> [ADR-0032](0032-web-exposure-and-writes.md) for exposure/writes. Reserved by the
> ADR-0029 header; filled by the transcript-capture slice (legacy issue 110). The 0030 number is the
> transcript ADR; the codebase's other duplicate-numbered ADRs are unrelated.

The operator's most valuable question about a finished or in-flight run is *"what did the
agent actually do?"* — the conversation, the tool calls, the diffs, the commands. Today
that lives only inside the Claude Agent SDK's own session files under `CLAUDE_CONFIG_DIR`:
an opaque, per-login, on-disk artifact the daemon does not own, cannot query, cannot
stream to a browser, and cannot retain on its own terms. The run log (`appendLog`) records
lifecycle breadcrumbs (`pickup`, `pr-opened`, heartbeats), not the conversation.

For the web control plane (legacy epic 106) the transcript must become **first-class, queryable
data the daemon owns** — so a Run-detail page can render the conversation, a live run can
be tailed, and an old run's verbose log can age out without losing the run's story.

## Decision

**The daemon owns the agent transcript.** A capture **sink** wraps the per-message
`onMessage` callback of the one execution chokepoint —
`runReapedWallClockedSession` (the shared substrate of impl/resume/review/fix/moding) —
and appends each completed `SDKMessage` as events on a **dedicated per-run stream**.

### Stream model — a verbose tier beside the permanent timeline

Transcripts ride **their own per-run stream**, `transcript:<repo>#<issue>:<runId>`,
distinct from the issue/domain stream `<repo>#<issue>` (ADR-0022) and the system stream
(`$…`). The prefix keeps the three families disjoint (a repo slug starts with none of
`transcript:`/`$`/`#`).

They are **appended raw**:

- **No inline domain projection.** No transcript event type is in any projection's
  `canHandle`, so the issue-state fold never fires for a transcript append, and a
  transcript stream is never materialised into `es_issue_projection`.
- **No expected-version guard.** Capture is a high-volume side-channel, not a
  single-writer domain decision; it must never contend with or wedge the domain log.
- **Never on the issue/domain stream.** The domain timeline (`RunStarted … Merged`) stays
  the small, permanent, replayable story of the run; the transcript is the verbose tier.

This is the **two-tier** model: the **timeline is permanent**; the **transcript is
prunable**.

### A pure, message-level mapper

`SDKMessage → transcript event` is a **pure** function at **message-level** granularity
(token-level streaming partials are deferred — they map to `null` and are dropped, as do
rate-limit telemetry and system bookkeeping). The representative conversational shapes —
assistant text + `tool_use`, `user` `tool_result`, and the session `result` — normalise
to a small, SDK-independent block vocabulary so the viewer never couples to SDK internals.

### Redaction before persistence

Each event is run through the **existing `log/` secret-redaction** *before* it is
appended, so a token leaked into assistant text or a tool result never reaches the store.

### Capture is a best-effort edge, never on the critical path

The sink **never throws**: a malformed message or a failed append is logged and dropped.
Appends are **serialised** through one promise chain so concurrent messages cannot race on
the stream's append position. A transcript fault can never break, slow, or wedge a run —
the same isolation discipline ADR-0029 applies to the web layer.

### Two-tier retention

The verbose transcript is pruned under a configurable budget (`config.transcript`):
**default 30 days**, plus an optional total **size cap** (oldest-first eviction). Pruning
deletes a run's `TranscriptMessage`s and leaves a **`TranscriptPruned` marker** so the
viewer can explain "transcript pruned" while the run's domain timeline survives untouched.
The marker is written *before* the delete, so a crash mid-prune can never leave a
silently-empty stream. The reconciler runs the prune periodically (paced, off the critical
path), each repo pruning its own transcripts.

## Why captured at the chokepoint (not per-runner)

`runReapedWallClockedSession` is the single point every session kind flows through. Wrapping
`onMessage` there makes capture **uniform by construction** — there is no runner that can
forget to wire it — and keeps the runners thin (they only forward an optional, pre-bound
sink). The moding pass has no run row, so it captures on the synthetic per-issue stream
`transcript:<repo>#<issue>:moding`.

## Consequences

- The event log grows a high-volume, prunable stream family. It rides the same
  `better-sqlite3` connection and Emmett store as the domain log (ADR-0023), but is
  isolated from it by stream id and by carrying no projection.
- Pruning is the one place transcript message rows are deleted directly from Emmett's
  `emt_messages` table (Emmett has no delete API); reads go through the log. This couples
  retention to Emmett's table name, imported from the library rather than hardcoded.
- Backfill of pre-capture runs is out of scope: older runs are timeline-only, and their
  transcript reads return empty (or, after a prune, just the marker).
- This slice is **backend capture + retention only** — no viewer. The Run-detail
  transcript view, live-tailing, and the timeline↔transcript spine are later slices
  (legacy epic 106), which read the per-run stream this slice fills.
