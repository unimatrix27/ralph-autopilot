/**
 * The inline **resume-context projection** of the issue event log (ADR-0021, slice 4 /
 * issue #80): the WIP checkpoint a paused run carries (DESIGN §6, CONTEXT: resume, not
 * restart) — folded over the **latest run span** and materialised in the
 * `es_resume_context` table.
 *
 * A run is a `RunStarted … RunEnded` span within the issue stream (ADR-0022). The resume
 * context is scoped to the *current* span, so the projection has two write paths over the
 * one stream-keyed row:
 *   - the span boundary is **event-folded**: `RunStarted` opens a fresh span, so this
 *     inline projection clears the stream's resume context (a re-pickup starts with no
 *     checkpoint — "the latest span is the projected current run"). The prior span's
 *     events stay in the log; only the read-model row resets (no destructive delete).
 *   - the checkpoint itself is the **shim on write** ({@link import("../store").Store.setResumeContext}):
 *     it stays a synchronous {@link upsertResumeContextRow} into this same table, because
 *     its callers (`resume.ts`, `rehydrate.ts`, `escalation-checkpoint.ts`) read it back
 *     in the same tick and must not change to `await` an async append (issue #80). The
 *     `RunStarted` clear is what makes the synchronous row a per-span projection rather
 *     than a stale carry-over across pickups.
 *
 * This projection table is owned by the event-log module (created idempotently by {@link
 * import("../event-log").EventLog}, not the CRUD migration ladder); the strangler cleanup
 * (ADR-0025, issue #83) dropped the legacy `resume_context` table, so it is now the only
 * resume-context store.
 */

import { sqliteProjection } from "@event-driven-io/emmett-sqlite";
import type { ResumePayload } from "../types";
import type { IssueEvent, IssueEventType } from "./event-types";
import { parseIssueStreamId } from "./streams";

/** The resume-context read-model table name. Owned by the event-log module, not migrations. */
export const RESUME_CONTEXT_TABLE = "es_resume_context";

/**
 * DDL for the resume-context projection table — keyed by the issue stream (`<repo>#<issue>`),
 * one row per stream (the latest span's checkpoint). `context` holds the JSON-serialised
 * {@link ResumePayload}, mirroring the legacy `resume_context.context` column 1:1 so the
 * read-model is unchanged. Created idempotently by {@link import("../event-log").EventLog}.
 */
export const RESUME_CONTEXT_DDL = `
  CREATE TABLE IF NOT EXISTS ${RESUME_CONTEXT_TABLE} (
    stream_id    TEXT    PRIMARY KEY,
    repo         TEXT    NOT NULL,
    issue_number INTEGER NOT NULL,
    run_id       INTEGER,
    branch       TEXT,
    context      TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );
`;

/** The raw SQLite shape of a resume-context projection row. */
export interface ResumeContextRowRaw {
  stream_id: string;
  repo: string;
  issue_number: number;
  run_id: number | null;
  branch: string | null;
  context: string;
  updated_at: string;
}

/** The decoded resume-context row: the WIP branch, the typed payload, and its timestamp. */
export interface ResumeContextRow {
  /** The numeric run id (`runs.id`) that wrote the checkpoint — the shim's lookup key. */
  runId: number | null;
  branch: string | null;
  /** The typed {@link ResumePayload} (parsed once, the single trust boundary — issue #9). */
  context: ResumePayload;
  updatedAt: string;
}

/** Decode a raw row into the public {@link ResumeContextRow}. */
export function mapResumeContextRow(raw: ResumeContextRowRaw): ResumeContextRow {
  return {
    runId: raw.run_id,
    branch: raw.branch,
    context: JSON.parse(raw.context) as ResumePayload,
    updatedAt: raw.updated_at,
  };
}

/**
 * The issue-event types this projection folds — only `RunStarted` (the span boundary), at
 * which the stream's resume context resets. `satisfies IssueEventType[]` makes a typo or a
 * renamed event a compile error.
 */
export const RESUME_CONTEXT_EVENT_TYPES = ["RunStarted"] satisfies IssueEventType[];

/** Synchronous UPSERT of a stream's resume context — the {@link setResumeContext} shim's write. */
export const RESUME_CONTEXT_UPSERT_SQL = `
  INSERT INTO ${RESUME_CONTEXT_TABLE} (stream_id, repo, issue_number, run_id, branch, context, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(stream_id) DO UPDATE SET
    run_id     = excluded.run_id,
    branch     = excluded.branch,
    context    = excluded.context,
    updated_at = excluded.updated_at
`;

/** Reset a stream's resume context — a fresh span has no checkpoint (the `RunStarted` fold). */
const CLEAR_BY_STREAM_SQL = `DELETE FROM ${RESUME_CONTEXT_TABLE} WHERE stream_id = ?`;

/**
 * The inline resume-context projection. For each appended `RunStarted` it clears the
 * stream's resume context — opening a fresh span with no carried checkpoint — inside the
 * append's transaction. System-stream events are skipped (not issue events). The
 * checkpoint *write* is the synchronous shim (see the module header), not this fold.
 */
export function createResumeContextProjection() {
  return sqliteProjection<IssueEvent>({
    name: "resume-context",
    canHandle: RESUME_CONTEXT_EVENT_TYPES,
    handle: async (events, context) => {
      for (const recorded of events) {
        if (!parseIssueStreamId(recorded.metadata.streamName)) {
          continue; // not an issue stream
        }
        if (recorded.type === "RunStarted") {
          await context.connection.command(CLEAR_BY_STREAM_SQL, [recorded.metadata.streamName]);
        }
      }
    },
  });
}
