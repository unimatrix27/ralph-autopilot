# Daemon is a polling reconciler; GitHub is the source of truth, SQLite is rebuildable

The daemon polls GitHub every 30s and reconciles desired state (labels) against
actual state (running agents + SQLite), rather than reacting to webhooks. This box
has no stable public ingress, so webhooks would mean a fragile tunnel; one repo at
30s is trivial against GitHub's rate limit. The reconciler framing makes the
daemon stateless-recoverable: restart it and it re-derives reality from labels and
open PRs.

## Consequences

SQLite stores only runtime state (fix-attempt counters, resume context, the
question index, the run log). If it is lost, in-flight work is re-derived from
GitHub — no permanent data loss. Worst-case pickup latency is one tick (~30s),
accepted deliberately over push complexity.
