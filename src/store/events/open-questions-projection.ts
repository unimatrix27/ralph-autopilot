/**
 * The inline **open-question projection** of the issue event log (ADR-0021, slice 3 /
 * issue #79): the HITL open-question index — the escalate / heal-card state of DESIGN §6
 * — folded from {@link IssueEvent}s and materialised in the `es_open_questions` table
 * **in the same SQLite transaction as the append** (Emmett `onBeforeCommit`, proven
 * synchronous + same-transaction by the ADR-0023 spike). No async lag, no stale reads.
 *
 * Two facts drive it, both keyed by the question's GitHub comment id (the same
 * correlation key the resume path and `ralph-answer` already use, issue #10):
 *   - `Escalated` opens a question (a new `status='open'` row);
 *   - `QuestionAnswered` closes it (flips the matching open row to `status='answered'`).
 *
 * `QuestionAnswered` is retained over `Resumed` deliberately (the issue #79 grilled
 * decision): the index is a row-per-question read-model that keeps answered rows, so it
 * needs an explicit close fact *scoped to the question cluster*. `Resumed` is a run-
 * *lifecycle* fact whose fold belongs to `runs.status` (slice 4, ADR-0025 "runs.status
 * last") — borrowing it here would prematurely event-source run status and conflate
 * "answered" with "resumed". `QuestionAnswered` folds into this projection (open →
 * answered), so it is a real event under ADR-0024, not a log line.
 *
 * Admission guarantees a single live run per issue and a paused run frees its slot, so a
 * stream has **at most one open question at a time** — the close events match cleanly.
 * This projection table is owned by the event-log module (created idempotently by {@link
 * import("../event-log").EventLog}, not the CRUD migration ladder); the strangler cleanup
 * (ADR-0025, issue #83) dropped the legacy `open_questions` table, so it is now the only
 * open-question store.
 */

import type { OpenQuestion, QuestionKind, QuestionStatus } from "../types";
import { sqliteProjection } from "@event-driven-io/emmett-sqlite";
import type { Escalated, IssueEvent, IssueEventType, QuestionAnswered } from "./event-types";
import { parseIssueStreamId } from "./streams";

/** The open-question read-model table name. Owned by the event-log module, not migrations. */
export const OPEN_QUESTIONS_TABLE = "es_open_questions";

/**
 * DDL for the open-question projection table — mirrors the legacy `open_questions`
 * columns 1:1 so the {@link OpenQuestion} read-model is unchanged. Created idempotently
 * by {@link import("../event-log").EventLog} (not the CRUD migration ladder) so the
 * whole event-sourcing schema stays separable.
 */
export const OPEN_QUESTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS ${OPEN_QUESTIONS_TABLE} (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id    TEXT    NOT NULL,
    repo         TEXT    NOT NULL,
    issue_number INTEGER NOT NULL,
    run_id       INTEGER,
    kind         TEXT    NOT NULL,
    headline     TEXT    NOT NULL,
    comment_id   INTEGER,
    status       TEXT    NOT NULL DEFAULT 'open',
    created_at   TEXT    NOT NULL,
    answered_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_es_open_questions_status ON ${OPEN_QUESTIONS_TABLE}(status);
  CREATE INDEX IF NOT EXISTS idx_es_open_questions_stream ON ${OPEN_QUESTIONS_TABLE}(stream_id);
`;

/** The raw SQLite shape of an open-question projection row. */
export interface OpenQuestionRowRaw {
  id: number;
  stream_id: string;
  repo: string;
  issue_number: number;
  run_id: number | null;
  kind: string;
  headline: string;
  comment_id: number | null;
  status: string;
  created_at: string;
  answered_at: string | null;
}

/** Decode a raw row into the public {@link OpenQuestion} read-model. */
export function mapOpenQuestionRow(raw: OpenQuestionRowRaw): OpenQuestion {
  return {
    id: raw.id,
    repo: raw.repo,
    issueNumber: raw.issue_number,
    runId: raw.run_id,
    kind: raw.kind as QuestionKind,
    headline: raw.headline,
    commentId: raw.comment_id,
    status: raw.status as QuestionStatus,
    createdAt: raw.created_at,
    answeredAt: raw.answered_at,
  };
}

/**
 * The issue-event types this projection folds — `Escalated` opens, `QuestionAnswered`
 * closes. `satisfies IssueEventType[]` makes a typo or a renamed event a compile error.
 */
export const OPEN_QUESTION_EVENT_TYPES = [
  "Escalated",
  "QuestionAnswered",
] satisfies IssueEventType[];

const INSERT_SQL = `
  INSERT INTO ${OPEN_QUESTIONS_TABLE}
    (stream_id, repo, issue_number, run_id, kind, headline, comment_id, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
`;

/** Close the question matching this comment id (the precise, production path). */
const CLOSE_BY_COMMENT_SQL = `
  UPDATE ${OPEN_QUESTIONS_TABLE} SET status = 'answered', answered_at = ?
  WHERE stream_id = ? AND status = 'open' AND comment_id = ?
`;

/**
 * Close the stream's open question when the answer fact carries no comment id. Sound
 * because a stream has at most one open question at a time (single-writer per issue).
 */
const CLOSE_BY_STREAM_SQL = `
  UPDATE ${OPEN_QUESTIONS_TABLE} SET status = 'answered', answered_at = ?
  WHERE stream_id = ? AND status = 'open'
`;

/**
 * The event carries `runId` as a string correlation tag (ADR-0022); the legacy column is
 * the numeric `runs.id`. Convert back, tolerating an empty/non-numeric tag as `null`.
 */
function runIdToColumn(runId: string): number | null {
  if (runId === "") {
    return null;
  }
  const n = Number(runId);
  return Number.isFinite(n) ? n : null;
}

/**
 * The inline open-question projection. For each appended `Escalated` it inserts an open
 * row; for each `QuestionAnswered` it flips the matching open row to answered — all
 * inside the append's transaction. System-stream events are skipped (not issue events).
 */
export function createOpenQuestionsProjection(now: () => string) {
  return sqliteProjection<IssueEvent>({
    name: "open-questions",
    canHandle: OPEN_QUESTION_EVENT_TYPES,
    handle: async (events, context) => {
      for (const recorded of events) {
        const ref = parseIssueStreamId(recorded.metadata.streamName);
        if (!ref) {
          continue; // not an issue stream
        }
        const streamId = recorded.metadata.streamName;
        if (recorded.type === "Escalated") {
          const data = recorded.data as Escalated["data"];
          await context.connection.command(INSERT_SQL, [
            streamId,
            ref.repo,
            ref.issueNumber,
            runIdToColumn(data.runId),
            data.kind,
            data.headline ?? "",
            data.commentId ?? null,
            now(),
          ]);
        } else if (recorded.type === "QuestionAnswered") {
          const data = recorded.data as QuestionAnswered["data"];
          await (data.commentId != null
            ? context.connection.command(CLOSE_BY_COMMENT_SQL, [now(), streamId, data.commentId])
            : context.connection.command(CLOSE_BY_STREAM_SQL, [now(), streamId]));
        }
      }
    },
  });
}
