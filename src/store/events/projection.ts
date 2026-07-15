/**
 * The inline **projection** of the issue event log (ADR-0021): the read-model the
 * reconciler reads each tick, folded from {@link IssueEvent}s and materialised in the
 * `es_issue_projection` table **in the same SQLite transaction as the append** (the
 * fold runs inside Emmett's `onBeforeCommit` — proven synchronous + same-transaction
 * by the ADR-0023 spike). No async lag, no stale reads within a tick.
 *
 * The fold itself ({@link foldIssueState}) is a pure function over `IssueState`,
 * reusing the decider's `evolve`; the Emmett wiring that calls it lives in
 * {@link import("../event-log").EventLog}. Run status and fix counts are *derived*
 * here, never stored as facts (ADR-0024); the table is rebuildable by replay (or from
 * GitHub if the log is lost, ADR-0021).
 */

import type { Phase, PhaseRoute } from "../types";
import { isProviderName } from "../../config/schema";
import type { IssueEvent } from "./event-types";
import { evolve, initialIssueState, type IssueLifecycle, type IssueState } from "./decider";
import type { IssueStreamRef } from "./streams";

/**
 * Pure inline-projection fold: reduce a batch of new events onto prior state. This is
 * the function the inline projection runs per append (over the events being committed,
 * on top of the row's last-committed state). Reuses `evolve`, so the projection and
 * the `aggregateStream` fold can never diverge.
 */
export function foldIssueState(
  events: readonly IssueEvent[],
  from: IssueState = initialIssueState(),
): IssueState {
  return events.reduce(evolve, from);
}

/** The read-model table name. Owned by the event-log module, not the CRUD migrations. */
export const ISSUE_PROJECTION_TABLE = "es_issue_projection";

/**
 * DDL for the projection table. Created idempotently by {@link import("../event-log").EventLog}
 * (not the CRUD migration ladder) so the whole event-sourcing schema stays separable —
 * a final strangler cleanup slice (ADR-0025) drops it together with the legacy tables.
 */
export const ISSUE_PROJECTION_DDL = `
  CREATE TABLE IF NOT EXISTS ${ISSUE_PROJECTION_TABLE} (
    stream_id       TEXT    PRIMARY KEY,
    repo            TEXT    NOT NULL,
    issue_number    INTEGER NOT NULL,
    status          TEXT    NOT NULL,
    run_id          TEXT,
    pr_number       INTEGER,
    fix_attempts    TEXT    NOT NULL,
    anomaly         TEXT,
    ended           INTEGER NOT NULL DEFAULT 0,
    route           TEXT,
    stream_position INTEGER NOT NULL,
    updated_at      TEXT    NOT NULL
  );
`;

/**
 * The `route` column name + its additive DDL (ADR-0037 P3.1, issue #164). Added to an existing
 * projection table via `ALTER TABLE … ADD COLUMN` ({@link import("../event-log").EventLog}'s
 * constructor) so an in-place daemon upgrade gains the column without a rebuild; on a fresh DB the
 * column is already in {@link ISSUE_PROJECTION_DDL}. A nullable column — null is "no route recorded".
 */
export const ISSUE_PROJECTION_ROUTE_COLUMN = "route";

/**
 * The decoded read-model row for one issue: the folded {@link IssueState} (the decider's
 * source of truth) plus the stream metadata that materialisation adds. Defined as that
 * intersection so the state fields can never drift from `IssueState` — add a field there
 * and it appears here for free.
 */
export type IssueProjectionRow = IssueState & {
  streamId: string;
  repo: string;
  issueNumber: number;
  /** The stream version (event count) this row reflects. */
  streamPosition: number;
  updatedAt: string;
};

/** The raw SQLite shape of a projection row. */
export interface IssueProjectionRowRaw {
  stream_id: string;
  repo: string;
  issue_number: number;
  status: string;
  run_id: string | null;
  pr_number: number | null;
  fix_attempts: string;
  anomaly: string | null;
  ended: number;
  /** JSON-encoded {@link PhaseRoute}, or null/absent (route-less or a pre-column row). */
  route: string | null;
  stream_position: number;
  updated_at: string;
}

const PHASES: Phase[] = [0, 1, 2];

/** Serialise per-phase fix counts to JSON for the `fix_attempts` column. */
export function serializeFixAttempts(fixAttempts: Record<Phase, number>): string {
  return JSON.stringify({ 0: fixAttempts[0], 1: fixAttempts[1], 2: fixAttempts[2] });
}

/**
 * State→row **write path** — the symmetric encode to {@link decodeProjectionState}.
 * The UPSERT and its positional param list live here, beside the DDL and the row→state
 * decode, so the projection table has a single owner: adding a field to {@link IssueState}
 * is one edit in this file (the DDL column, this column list, and the params below), with
 * the read and write shapes side by side rather than split across the Emmett wiring.
 */
export const ISSUE_PROJECTION_UPSERT_SQL = `
  INSERT INTO ${ISSUE_PROJECTION_TABLE}
    (stream_id, repo, issue_number, status, run_id, pr_number, fix_attempts, anomaly, ended, route, stream_position, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(stream_id) DO UPDATE SET
    status          = excluded.status,
    run_id          = excluded.run_id,
    pr_number       = excluded.pr_number,
    fix_attempts    = excluded.fix_attempts,
    anomaly         = excluded.anomaly,
    ended           = excluded.ended,
    route           = excluded.route,
    stream_position = excluded.stream_position,
    updated_at      = excluded.updated_at
`;

/**
 * Positional params for {@link ISSUE_PROJECTION_UPSERT_SQL}, in its column order. The
 * inline projection ({@link import("../event-log").EventLog}) calls this to materialise a
 * folded {@link IssueState} into the table; `ended` is encoded as 0/1 to mirror the raw
 * column ({@link IssueProjectionRowRaw}) and the boolean `decodeProjectionState` reads back.
 */
export function projectionUpsertParams(
  streamId: string,
  ref: IssueStreamRef,
  state: IssueState,
  streamPosition: number,
  updatedAt: string,
): (string | number | null)[] {
  return [
    streamId,
    ref.repo,
    ref.issueNumber,
    state.status,
    state.runId,
    state.prNumber,
    serializeFixAttempts(state.fixAttempts),
    state.anomaly,
    state.ended ? 1 : 0,
    serializeRoute(state.route),
    streamPosition,
    updatedAt,
  ];
}

/** Serialise a {@link PhaseRoute} to its JSON column value, or null when no route is recorded. */
export function serializeRoute(route: PhaseRoute | null | undefined): string | null {
  return route ? JSON.stringify(route) : null;
}

/**
 * Coerce an arbitrary value — a parsed JSON object (the projection's `route` column) or a raw
 * event payload's `route` field (the run-detail timeline) — into a {@link PhaseRoute}, or null.
 * The **single** tolerant `unknown → PhaseRoute` reader both read paths share, so they validate
 * identically (the fleet projection via {@link parseRoute}, the run-detail timeline via
 * `timelineRoute`). Tolerant by construction (the row is rebuildable from the log, ADR-0021): a
 * non-object, a missing/non-string `account`, or a `provider` that is not a known
 * {@link import("../../config/schema").ProviderName} all decode to null — never a throw. The
 * provider-enum check is the deliberately-canonical strictness (it makes the `PhaseRoute` provider
 * sound rather than a blind cast, and degrades one corrupt route to null instead of poisoning the
 * whole response at the serialize boundary). `model` is carried through only when it is a string
 * (absent → the provider's default model).
 */
export function coerceRoute(value: unknown): PhaseRoute | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const r = value as Record<string, unknown>;
  if (typeof r.provider !== "string" || !isProviderName(r.provider) || typeof r.account !== "string") {
    return null;
  }
  return typeof r.model === "string"
    ? { provider: r.provider, model: r.model, account: r.account }
    : { provider: r.provider, account: r.account };
}

/**
 * Parse the `route` JSON column back to a {@link PhaseRoute}, or null. A null/missing column or
 * corrupt JSON decodes to null (never a throw); the parsed value's shape is validated by the
 * shared {@link coerceRoute}, so the column read and the timeline read can never drift.
 */
export function parseRoute(json: string | null | undefined): PhaseRoute | null {
  if (!json) {
    return null;
  }
  try {
    return coerceRoute(JSON.parse(json));
  } catch {
    return null; // tolerant: corrupt JSON → no route
  }
}

/**
 * Parse the `fix_attempts` JSON column back to per-phase counts. Tolerant: missing or
 * corrupt JSON yields zeros (the row is rebuildable from the log, so a soft default is
 * safe — never throw on read).
 */
export function parseFixAttempts(json: string): Record<Phase, number> {
  const counts: Record<Phase, number> = { 0: 0, 1: 0, 2: 0 };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    for (const phase of PHASES) {
      const value = parsed[String(phase)];
      if (typeof value === "number" && Number.isFinite(value)) {
        counts[phase] = value;
      }
    }
  } catch {
    /* tolerant: corrupt JSON → zeros */
  }
  return counts;
}

/**
 * The current {@link IssueState} a projection row encodes (or the initial state when
 * the row is absent). Used by the inline projection to read-modify-write, and to keep
 * the materialised table and the event-log fold in lockstep.
 */
export function decodeProjectionState(raw: IssueProjectionRowRaw | null | undefined): IssueState {
  if (!raw) {
    return initialIssueState();
  }
  return {
    status: raw.status as IssueLifecycle,
    runId: raw.run_id,
    prNumber: raw.pr_number,
    fixAttempts: parseFixAttempts(raw.fix_attempts),
    anomaly: raw.anomaly,
    ended: raw.ended !== 0,
    route: parseRoute(raw.route),
  };
}

/** Decode a raw row into the public {@link IssueProjectionRow}: the folded state plus stream metadata. */
export function mapProjectionRow(raw: IssueProjectionRowRaw): IssueProjectionRow {
  return {
    streamId: raw.stream_id,
    repo: raw.repo,
    issueNumber: raw.issue_number,
    ...decodeProjectionState(raw),
    streamPosition: raw.stream_position,
    updatedAt: raw.updated_at,
  };
}
