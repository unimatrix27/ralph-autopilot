/**
 * Stream identity for the event log (ADR-0022).
 *
 * The aggregate and consistency boundary is the **issue**, repo-scoped:
 * `stream_id = <repo>#<issue>`, aligning with the schema's `UNIQUE(repo, issue_number)`.
 * Every pickup of an issue lands in one continuous stream; a *run* is a
 * `RunStarted … RunEnded` span within it. Admission guarantees at most one live run
 * per issue, so a per-issue stream has a single writer and clean expected-version
 * concurrency.
 *
 * Daemon-lifecycle events that belong to no issue (startup, drain, self-update) go in
 * a separate **system stream** ({@link SYSTEM_STREAM_ID}), isolated from issue streams.
 */

/**
 * The system stream id for daemon-lifecycle events (ADR-0022). The `$` prefix marks
 * it as a system stream and keeps it disjoint from every issue stream (issue streams
 * are `<repo>#<issue>`; a repo slug never starts with `$`).
 */
export const SYSTEM_STREAM_ID = "$daemon-system";

/** The stream id for one issue's event sequence: `<repo>#<issue>` (ADR-0022). */
export function issueStreamId(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/** A parsed issue-stream reference. */
export interface IssueStreamRef {
  repo: string;
  issueNumber: number;
}

/**
 * Parse a `<repo>#<issue>` stream id back into its repo + issue. Returns `null` for
 * the system stream or any id that is not a well-formed issue stream — repo slugs may
 * contain `/` but never `#`, so the issue number is the segment after the **last** `#`.
 */
export function parseIssueStreamId(streamId: string): IssueStreamRef | null {
  if (isSystemStream(streamId)) {
    return null;
  }
  const hash = streamId.lastIndexOf("#");
  if (hash <= 0 || hash === streamId.length - 1) {
    return null;
  }
  const issuePart = streamId.slice(hash + 1);
  if (!/^\d+$/.test(issuePart)) {
    return null;
  }
  return { repo: streamId.slice(0, hash), issueNumber: Number(issuePart) };
}

/** Whether a stream id names the system stream (any `$`-prefixed id). */
export function isSystemStream(streamId: string): boolean {
  return streamId.startsWith("$");
}
