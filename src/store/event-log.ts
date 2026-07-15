/**
 * The **event log** (ADR-0021/0023): the daemon's append-only stream of its own
 * decisions, with inline projections folded in the *same SQLite transaction* as the
 * append. It rides this repo's existing `better-sqlite3` connection — there is no
 * separate read store and no second driver — via a thin adapter implementing Emmett's
 * `SQLiteConnection` over `better-sqlite3` (the ADR-0023 spike's verified option (a):
 * one connection, so a later strangler shim can wrap an event-append and a legacy
 * write in one transaction).
 *
 * Reachable behind the existing `Store`/`ScopedStore` (ADR-0023) — see
 * {@link import("./store").Store.events} — never as a separately-injected dependency.
 * This slice (issue #77) wires the machinery and exercises it by its own tests; no
 * state cluster is cut over yet (ADR-0025).
 */

import type { Database } from "better-sqlite3";
import {
  ExpectedVersionConflictError,
  projections,
  type AggregateStreamResult,
  type Event,
} from "@event-driven-io/emmett";
import {
  getSQLiteEventStore,
  messagesTable,
  sqliteProjection,
  type SQLiteConnection,
  type SQLiteEventStore,
} from "@event-driven-io/emmett-sqlite";
import { evolve, initialIssueState, type IssueState } from "./events/decider";
import { ISSUE_EVENT_TYPES, type IssueEvent } from "./events/event-types";
import {
  decodeProjectionState,
  foldIssueState,
  ISSUE_PROJECTION_DDL,
  ISSUE_PROJECTION_ROUTE_COLUMN,
  ISSUE_PROJECTION_TABLE,
  ISSUE_PROJECTION_UPSERT_SQL,
  mapProjectionRow,
  projectionUpsertParams,
  type IssueProjectionRow,
  type IssueProjectionRowRaw,
} from "./events/projection";
import {
  createOpenQuestionsProjection,
  mapOpenQuestionRow,
  OPEN_QUESTIONS_DDL,
  OPEN_QUESTIONS_TABLE,
  type OpenQuestionRowRaw,
} from "./events/open-questions-projection";
import {
  createResumeContextProjection,
  mapResumeContextRow,
  RESUME_CONTEXT_DDL,
  RESUME_CONTEXT_TABLE,
  RESUME_CONTEXT_UPSERT_SQL,
  type ResumeContextRow,
  type ResumeContextRowRaw,
} from "./events/resume-context-projection";
import { issueStreamId, parseIssueStreamId, SYSTEM_STREAM_ID } from "./events/streams";
import type { RecordedLogEvent } from "./log-broadcast";
import {
  parseTranscriptStreamId,
  planTranscriptRetention,
  transcriptStreamId,
  TRANSCRIPT_MESSAGE_TYPE,
  type TranscriptEvent,
  type TranscriptEventType,
  type TranscriptMessage,
  type TranscriptPruned,
  type TranscriptPrunePlan,
  type TranscriptRetentionBudget,
  type TranscriptStreamSummary,
} from "./events/transcript";
import {
  evolveSystem,
  initialSystemState,
  type SystemEvent,
  type SystemState,
} from "./events/system";
import type { OpenQuestion, ResumePayload } from "./types";

/** Values Emmett binds; `better-sqlite3` accepts these scalars (plus the normalisations below). */
type EmmettParam = object | string | bigint | number | boolean | null;

/**
 * Normalise a value Emmett binds into one `better-sqlite3` accepts. `node-sqlite3`
 * coerces loosely where `better-sqlite3` rejects: a JS boolean, and — as the
 * streams-table partition default — a column-descriptor *object*
 * (`{name:"partition"}`), which `better-sqlite3` mistakes for a named-parameter
 * source. Map boolean → 0/1 and a stray object → a stable scalar (identical on INSERT
 * and UPDATE so the version check still matches). (ADR-0023 spike, Constraint 1.)
 */
function bindable(value: unknown): EmmettParam {
  if (value === null || value === undefined) {
    return null;
  }
  const t = typeof value;
  if (t === "boolean") {
    return value ? 1 : 0;
  }
  if (t === "number" || t === "bigint" || t === "string") {
    return value as EmmettParam;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value as unknown as EmmettParam;
  }
  return JSON.stringify(value);
}

const bind = (params?: EmmettParam[]): EmmettParam[] => (params ?? []).map(bindable);

/**
 * A {@link SQLiteConnection} over `better-sqlite3`, mirroring Emmett's own
 * nesting-aware `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` so nested `withTransaction`
 * (schema creation inside an append) works. Inline projections run inside this one
 * transaction, before COMMIT — the same-transaction guarantee the spike proved.
 */
function betterSqlite3Adapter(db: Database): SQLiteConnection {
  let nesting = 0;
  return {
    close: () => {
      /* the Store owns the connection lifecycle; do not close it from here */
    },
    command: async (sql, params) => {
      try {
        if (!params || params.length === 0) {
          // exec() handles param-less / multi-statement DDL + projection SQL.
          db.exec(sql);
          return { changes: 0, lastID: 0 } as never;
        }
        const info = db.prepare(sql).run(...bind(params));
        return { changes: info.changes, lastID: info.lastInsertRowid } as never;
      } catch (err) {
        // better-sqlite3's SqliteError carries `.code` but an extended `.errno`, so
        // Emmett's `isOptimisticConcurrencyError` (errno === 19) does not fire on a
        // unique-constraint conflict. Map any SQLITE_CONSTRAINT to 19 so a native
        // expected-version create-conflict still surfaces typed. (Spike Constraint 1.)
        const e = err as { code?: string; errno?: number };
        if (typeof e.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT")) {
          e.errno = 19;
        }
        throw err;
      }
    },
    batchCommand: async (sqls) => {
      for (const sql of sqls) {
        db.exec(sql);
      }
    },
    query: async <T>(sql: string, params?: EmmettParam[]) =>
      db.prepare(sql).all(...bind(params)) as T[],
    querySingle: async <T>(sql: string, params?: EmmettParam[]) =>
      (db.prepare(sql).get(...bind(params)) ?? null) as T | null,
    withTransaction: async <T>(fn: () => Promise<T>) => {
      if (nesting++ === 0) {
        db.exec("BEGIN IMMEDIATE TRANSACTION");
      }
      try {
        const result = await fn();
        if (nesting === 1) {
          db.exec("COMMIT");
        }
        nesting--;
        return result;
      } catch (err) {
        if (--nesting === 0) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* connection already rolled back */
          }
        }
        throw err;
      }
    },
  };
}

/**
 * The inline issue-state projection. For each appended event it reads the row's
 * last-committed state, folds the new events on top with the pure
 * {@link foldIssueState}, and upserts — all inside the append's transaction. Reusing
 * `foldIssueState` (which reuses `evolve`) keeps the table and the `aggregateStream`
 * fold in lockstep. System-stream events are skipped (they are not issue events).
 */
function createIssueProjection(now: () => string) {
  return sqliteProjection<IssueEvent>({
    name: "issue-state",
    canHandle: ISSUE_EVENT_TYPES,
    handle: async (events, context) => {
      // Group by stream (one append is one stream, but be defensive).
      const byStream = new Map<string, IssueEvent[]>();
      for (const recorded of events) {
        const streamId = recorded.metadata.streamName;
        if (!parseIssueStreamId(streamId)) {
          continue; // not an issue stream
        }
        const list = byStream.get(streamId) ?? [];
        list.push({ type: recorded.type, data: recorded.data } as IssueEvent);
        byStream.set(streamId, list);
      }

      for (const [streamId, streamEvents] of byStream) {
        const ref = parseIssueStreamId(streamId);
        if (!ref) {
          continue;
        }
        const current = await context.connection.querySingle<IssueProjectionRowRaw>(
          `SELECT * FROM ${ISSUE_PROJECTION_TABLE} WHERE stream_id = ?`,
          [streamId],
        );
        const nextState = foldIssueState(streamEvents, decodeProjectionState(current));
        // The new stream version is the prior version plus this batch's event count.
        // (Derived from the prior row, not Emmett's per-event metadata position, which
        // is ambiguous for batched appends — the projection sees every stream event,
        // since `canHandle` covers all issue-event types.)
        const streamPosition = (current?.stream_position ?? 0) + streamEvents.length;
        await context.connection.command(
          ISSUE_PROJECTION_UPSERT_SQL,
          projectionUpsertParams(streamId, ref, nextState, streamPosition, now()),
        );
      }
    },
  });
}

/** The aggregate of an issue stream: its folded state and current version. */
export interface IssueAggregate {
  state: IssueState;
  /** The stream version (event count); `0n` for a stream with no events. */
  version: bigint;
  /** Whether the stream has any events. */
  exists: boolean;
}

/** The aggregate of the system stream. */
export interface SystemAggregate {
  state: SystemState;
  version: bigint;
  exists: boolean;
}

/** One event read back from any single stream, with both ordering positions (the viewer read). */
export interface RecordedStreamEvent {
  type: string;
  data: unknown;
  /** Position within its own stream (append order). */
  streamPosition: number;
  /** Global append position across the whole log (shared across stream families, for interleaving). */
  globalPosition: number;
}

/** One transcript event read back from a per-run stream, with its stream ordering metadata. */
export interface RecordedTranscriptEvent {
  type: TranscriptEventType;
  data: TranscriptMessage["data"] | TranscriptPruned["data"];
  /** Position within the transcript stream (append order). */
  streamPosition: number;
  /** Global append position across the whole log (for the live SSE cursor, later slices). */
  globalPosition: number;
}

/** The outcome of one retention pass: which streams were pruned and why. */
export interface TranscriptPruneResult {
  pruned: TranscriptPrunePlan[];
}

/**
 * A no-op decider — folds no state, so {@link EventLog.aggregate} yields only a
 * stream's `currentStreamVersion` (the event count, independent of how state folds).
 * Lets the version reads share one decider-agnostic path instead of folding the whole
 * stream through a domain decider purely to count it.
 */
const VERSION_ONLY_DECIDER = {
  evolve: (state: null): null => state,
  initialState: (): null => null,
};

/**
 * The event log over one `better-sqlite3` connection. Construct it via the {@link
 * import("./store").Store}, which shares its connection — never standalone in
 * production. Emmett's store (and its `emt_*` tables) is created lazily on first use;
 * the projection table is created eagerly in the constructor so a projection *read*
 * before any append is well-defined (returns `null`).
 */
export class EventLog {
  private readonly db: Database;
  private readonly now: () => string;
  private storePromise: Promise<SQLiteEventStore> | null = null;

  /**
   * The **after-commit emitter** hook (ADR-0029, issue #109). Set by the {@link
   * import("./store").Store} to fan committed events out to the live broadcast channel
   * the moment an append commits. `null` (the default) leaves the log emitter-free — a
   * standalone log carries no listeners, so the append path stays exactly as before.
   * Called synchronously after a successful append with the just-committed events (their
   * `global_position`s derived from Emmett's `lastEventGlobalPosition`); a faulty hook can
   * never break the append (it is invoked inside a try/catch).
   */
  onCommit: ((events: RecordedLogEvent[]) => void) | null = null;

  constructor(db: Database, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
    // Ensure the read-model tables up-front so a read before the first append works.
    this.db.exec(ISSUE_PROJECTION_DDL);
    this.db.exec(OPEN_QUESTIONS_DDL);
    this.db.exec(RESUME_CONTEXT_DDL);
    // Additively backfill the `route` column on an in-place upgrade (ADR-0037 P3.1, issue #164):
    // a daemon whose `es_issue_projection` predates the column gains it without a rebuild. On a
    // fresh DB the column is already in the DDL above, so this is a no-op. Idempotent — guarded by
    // a column-presence check (SQLite has no `ADD COLUMN IF NOT EXISTS`).
    this.addColumnIfMissing(ISSUE_PROJECTION_TABLE, ISSUE_PROJECTION_ROUTE_COLUMN, "TEXT");
  }

  /**
   * Add `column` (typed `columnType`) to `table` if it is not already present — the additive,
   * non-destructive schema evolution the rebuildable projection tables use (ADR-0021/0026). Reads
   * `PRAGMA table_info` rather than catching a duplicate-column error, so an unrelated failure is
   * not swallowed. A no-op when the column already exists.
   */
  private addColumnIfMissing(table: string, column: string, columnType: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnType}`);
    }
  }

  /** Lazily build (once) the Emmett store with the inline projections registered. */
  private eventStore(): Promise<SQLiteEventStore> {
    if (!this.storePromise) {
      const connection = betterSqlite3Adapter(this.db);
      this.storePromise = Promise.resolve(
        getSQLiteEventStore({
          fileName: this.db.name,
          connectionOptions: { singleton: true, connection },
          projections: projections.inline([
            createIssueProjection(this.now),
            createOpenQuestionsProjection(this.now),
            createResumeContextProjection(),
          ]),
        }),
      );
    }
    return this.storePromise;
  }

  // ── shared stream helpers ─────────────────────────────────────────────────

  /**
   * Fold a stream into its state and current version with the given decider — the one
   * place a stream is aggregated. The issue and system families are thin wrappers that
   * differ only by their `{ evolve, initialState }` pair.
   */
  private async aggregate<State, EventType extends Event>(
    stream: string,
    decider: { evolve: (state: State, event: EventType) => State; initialState: () => State },
  ): Promise<AggregateStreamResult<State, bigint>> {
    const store = await this.eventStore();
    return store.aggregateStream<State, EventType>(stream, decider);
  }

  /**
   * Read a stream's current version without a domain fold — `currentStreamVersion` is
   * the event count, independent of how state folds, so {@link VERSION_ONLY_DECIDER}
   * extracts it. The single version read shared by the expected-version pre-check and
   * the empty-append returns (folding the whole stream through a domain decider purely
   * to count it was the duplicated waste).
   */
  private async streamVersion(stream: string): Promise<bigint> {
    const { currentStreamVersion } = await this.aggregate<null, Event>(stream, VERSION_ONLY_DECIDER);
    return currentStreamVersion;
  }

  /** Append non-empty events to a stream and return the stream's version after. */
  private async appendRaw<EventType extends Event>(
    stream: string,
    events: EventType[],
  ): Promise<bigint> {
    const store = await this.eventStore();
    const result = await store.appendToStream(stream, events);
    this.emitCommitted(stream, events, result.lastEventGlobalPosition);
    return result.nextExpectedStreamVersion;
  }

  /**
   * Fire the after-commit emitter (ADR-0029) for a just-committed batch. Emmett assigns
   * the batch consecutive `global_position`s within the one transaction and returns the
   * **last** one (`lastEventGlobalPosition`), so the first event's position is
   * `last - (n - 1)` and the rest follow — no extra read on the hot path. A `null` hook
   * or a thrown listener is swallowed: the live edge must never break the append path.
   */
  private emitCommitted(streamId: string, events: Event[], lastEventGlobalPosition: bigint): void {
    const onCommit = this.onCommit;
    if (!onCommit || events.length === 0) {
      return;
    }
    const last = Number(lastEventGlobalPosition);
    const first = last - events.length + 1;
    const recorded: RecordedLogEvent[] = events.map((event, i) => ({
      globalPosition: first + i,
      streamId,
      type: event.type,
      data: (event as { data: unknown }).data,
    }));
    try {
      onCommit(recorded);
    } catch {
      /* a faulty live subscriber must never wedge the append path (ADR-0029) */
    }
  }

  // ── issue streams (`<repo>#<issue>`) ──────────────────────────────────────

  /**
   * Append events to an issue's stream, folding the inline projection in the same
   * transaction. When `expectedVersion` is given, the append is **rejected** with an
   * {@link ExpectedVersionConflictError} if the stream is not at that version — the
   * single-writer expected-version guard (ADR-0022).
   *
   * The check is a side-effect-free pre-check (read the version, compare, throw) rather
   * than Emmett 0.42.3's native `expectedStreamVersion`, which in this version commits
   * its inline projection and bumps the stream counter *before* throwing — wedging the
   * stream (ADR-0023 spike, Constraint 2). Pre-checking is sound because admission
   * guarantees a single writer per issue, and it leaves a rejected append with no trace.
   *
   * @returns the stream's version after the append.
   */
  async appendToIssue(
    repo: string,
    issueNumber: number,
    events: IssueEvent[],
    expectedVersion?: bigint,
  ): Promise<bigint> {
    const stream = issueStreamId(repo, issueNumber);

    // A non-empty append with no guard never needs the version — append straight away.
    // Otherwise read the version once, for the guard and/or the empty-append return, so
    // an empty guarded append no longer folds the stream twice.
    if (expectedVersion === undefined && events.length > 0) {
      return this.appendRaw(stream, events);
    }
    const version = await this.streamVersion(stream);
    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new ExpectedVersionConflictError(version, expectedVersion);
    }
    return events.length === 0 ? version : this.appendRaw(stream, events);
  }

  /** Fold an issue's stream into its {@link IssueState} (read-your-write on the log). */
  async aggregateIssue(repo: string, issueNumber: number): Promise<IssueAggregate> {
    const agg = await this.aggregate<IssueState, IssueEvent>(issueStreamId(repo, issueNumber), {
      evolve,
      initialState: initialIssueState,
    });
    return { state: agg.state, version: agg.currentStreamVersion, exists: agg.streamExists };
  }

  /**
   * Read the materialised projection row for an issue, or `null` if the stream has no
   * events. Synchronous (reads the shared `better-sqlite3` connection) and observes
   * any append committed earlier in the same tick (inline, same-transaction fold).
   */
  readIssueProjection(repo: string, issueNumber: number): IssueProjectionRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM ${ISSUE_PROJECTION_TABLE} WHERE stream_id = ?`)
      .get(issueStreamId(repo, issueNumber)) as IssueProjectionRowRaw | undefined;
    return raw ? mapProjectionRow(raw) : null;
  }

  // ── open-question projection (slice 3, issue #79) ─────────────────────────
  //
  // All reads are synchronous (the shared `better-sqlite3` connection) and observe any
  // append committed earlier in the same tick — the inline, same-transaction fold the
  // `Escalated`/`QuestionAnswered` shims rely on for read-your-write.

  /** One question by its materialised id, regardless of status (open or answered), or null. */
  questionById(id: number): OpenQuestion | null {
    const raw = this.db
      .prepare(`SELECT * FROM ${OPEN_QUESTIONS_TABLE} WHERE id = ?`)
      .get(id) as OpenQuestionRowRaw | undefined;
    return raw ? mapOpenQuestionRow(raw) : null;
  }

  /** The single open question on an issue's stream (the read-back after an `Escalated`), or null. */
  openQuestionForIssue(repo: string, issueNumber: number): OpenQuestion | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM ${OPEN_QUESTIONS_TABLE} WHERE stream_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
      )
      .get(issueStreamId(repo, issueNumber)) as OpenQuestionRowRaw | undefined;
    return raw ? mapOpenQuestionRow(raw) : null;
  }

  /** Open questions for one target repo, oldest first (the per-repo HITL queue). */
  openQuestionsByRepo(repo: string): OpenQuestion[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ${OPEN_QUESTIONS_TABLE} WHERE status = 'open' AND repo = ? ORDER BY created_at, id`,
        )
        .all(repo) as OpenQuestionRowRaw[]
    ).map(mapOpenQuestionRow);
  }

  /** Open questions across every target, oldest first (the global HITL queue view). */
  allOpenQuestions(): OpenQuestion[] {
    return (
      this.db
        .prepare(`SELECT * FROM ${OPEN_QUESTIONS_TABLE} WHERE status = 'open' ORDER BY created_at, id`)
        .all() as OpenQuestionRowRaw[]
    ).map(mapOpenQuestionRow);
  }

  // ── resume-context projection (slice 4, issue #80) ────────────────────────
  //
  // The WIP checkpoint a paused run carries, folded over the latest run span. The span
  // boundary (`RunStarted`) is event-folded by {@link createResumeContextProjection}; the
  // checkpoint write below stays synchronous — its callers read it back in the same tick
  // and keep their unchanged (sync) signatures (issue #80). Both reach this one
  // stream-keyed row, and the synchronous reads observe a same-tick `RunStarted` clear.

  /**
   * Synchronously write (UPSERT) an issue's resume context — the `setResumeContext`
   * shim's write path. Keyed by the issue stream, so a re-pickup's `RunStarted` clear and
   * this write address the same row; `runId` is the numeric `runs.id` the read shim folds
   * back. `context` is the JSON-serialised {@link ResumePayload}.
   */
  upsertResumeContext(
    repo: string,
    issueNumber: number,
    input: { runId: number | null; branch: string | null; context: ResumePayload; updatedAt: string },
  ): void {
    this.db
      .prepare(RESUME_CONTEXT_UPSERT_SQL)
      .run(
        issueStreamId(repo, issueNumber),
        repo,
        issueNumber,
        input.runId,
        input.branch,
        JSON.stringify(input.context),
        input.updatedAt,
      );
  }

  /** The resume context folded over an issue's latest span, or `null` if none is pending. */
  resumeContextForIssue(repo: string, issueNumber: number): ResumeContextRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM ${RESUME_CONTEXT_TABLE} WHERE stream_id = ?`)
      .get(issueStreamId(repo, issueNumber)) as ResumeContextRowRaw | undefined;
    return raw ? mapResumeContextRow(raw) : null;
  }

  /**
   * Drop an issue's resume-context read-model row (the old FK cascade's analogue, issue
   * #80). The stream's events are untouched (no destructive delete); a re-pickup's
   * `RunStarted` would clear it regardless, so this only avoids a window where a deleted
   * run's stream still folds a superseded checkpoint.
   */
  clearResumeContext(repo: string, issueNumber: number): void {
    this.db
      .prepare(`DELETE FROM ${RESUME_CONTEXT_TABLE} WHERE stream_id = ?`)
      .run(issueStreamId(repo, issueNumber));
  }

  // ── system stream (daemon lifecycle) ──────────────────────────────────────

  /** Append daemon-lifecycle events to the isolated system stream (ADR-0022). */
  async appendToSystem(events: SystemEvent[]): Promise<bigint> {
    if (events.length === 0) {
      return this.streamVersion(SYSTEM_STREAM_ID);
    }
    return this.appendRaw(SYSTEM_STREAM_ID, events);
  }

  /** Fold the system stream into its {@link SystemState}. */
  async aggregateSystem(): Promise<SystemAggregate> {
    const agg = await this.aggregate<SystemState, SystemEvent>(SYSTEM_STREAM_ID, {
      evolve: evolveSystem,
      initialState: initialSystemState,
    });
    return { state: agg.state, version: agg.currentStreamVersion, exists: agg.streamExists };
  }

  // ── per-run transcript streams (`transcript:<repo>#<issue>:<runId>`, ADR-0030) ─
  //
  // Captured agent transcripts ride a DEDICATED per-run stream, **appended raw**: no
  // inline domain projection (no transcript event type is in any projection's
  // `canHandle`, so the folds never fire), no expected-version guard, and never on the
  // issue/domain stream. The issue projection + the domain version guard are therefore
  // untouched by transcript appends. The verbose transcript is the prunable tier; the
  // domain timeline (the issue stream) is permanent.

  /**
   * Append transcript events to a run's stream `transcript:<repo>#<issue>:<runId>` (raw —
   * no projection, no version guard). A no-op for an empty batch.
   */
  async appendToTranscript(
    repo: string,
    issueNumber: number,
    runId: string,
    events: TranscriptEvent[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await this.appendRaw(transcriptStreamId(repo, issueNumber, runId), events);
  }

  // ── global tail (live SSE cursor catch-up, ADR-0029 / issue #109) ──────────
  //
  // The live web feed is a tail over the WHOLE log keyed by `global_position` (the
  // monotonic across-streams position Emmett stamps). A (re)connecting SSE client
  // catches up from its last cursor through {@link readAfter}, then uses the live
  // {@link import("./log-broadcast").LogBroadcaster} only as a wake-up. Both paths key
  // by the same position, so the handoff dedupes cleanly with no gap. Synchronous
  // (shared `better-sqlite3` connection); reads every stream family (issue / system /
  // transcript), and the consumer filters by `streamId`.

  /**
   * Read up to `limit` committed events with `global_position` strictly greater than
   * `globalPosition`, oldest-first — the SSE catch-up read. `globalPosition: 0` reads
   * from the beginning; an empty/old log yields `[]`. Pruned transcript messages are
   * gone (their stream keeps only the {@link TranscriptPruned} marker), so a far-behind
   * cursor simply skips the deleted verbose tail — never an error.
   */
  readAfter(globalPosition: number, limit: number): RecordedLogEvent[] {
    if (!this.emtMessagesExists()) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT stream_id, message_type AS type, message_data AS data, global_position
           FROM ${messagesTable.name}
          WHERE global_position > ? AND is_archived = 0
          ORDER BY global_position ASC
          LIMIT ?`,
      )
      .all(globalPosition, Math.max(0, limit)) as {
      stream_id: string;
      type: string;
      data: string;
      global_position: number;
    }[];
    return rows.map((row) => ({
      globalPosition: Number(row.global_position),
      streamId: row.stream_id,
      type: row.type,
      data: JSON.parse(row.data) as unknown,
    }));
  }

  /**
   * The latest committed `global_position` across the whole log, or `0` before any
   * append — where a fresh "from now" SSE connect (no cursor) starts so it streams only
   * new events without replaying all of history.
   */
  head(): number {
    if (!this.emtMessagesExists()) {
      return 0;
    }
    const row = this.db
      .prepare(`SELECT MAX(global_position) AS head FROM ${messagesTable.name} WHERE is_archived = 0`)
      .get() as { head: number | null };
    return Number(row.head ?? 0);
  }

  /**
   * Read a run's transcript in append order. Synchronous (the shared `better-sqlite3`
   * connection); returns `[]` before any transcript has been written. After a prune the
   * verbose messages are gone and only the {@link TranscriptPruned} marker remains.
   */
  readTranscript(repo: string, issueNumber: number, runId: string): RecordedTranscriptEvent[] {
    return this.readTranscriptStream(transcriptStreamId(repo, issueNumber, runId));
  }

  /**
   * Read an issue's domain stream `<repo>#<issue>` in append order — the **permanent**
   * timeline tier the run-detail viewer (issue #111) renders as a clickable spine. Unlike
   * the prunable transcript, these events survive forever, so a pruned run still has its
   * story. Synchronous (the shared `better-sqlite3` connection); `[]` before any append.
   */
  readIssueStream(repo: string, issueNumber: number): RecordedStreamEvent[] {
    return this.readStreamEvents(issueStreamId(repo, issueNumber));
  }

  /**
   * Read any stream's events in append order with both ordering positions — the generic
   * read backing {@link readIssueStream} (and reusable for any single-stream viewer read).
   * The `globalPosition` is shared across every stream family, so a consumer can interleave
   * a stream's events with another's (e.g. timeline ↔ transcript) into one chronology.
   */
  readStreamEvents(streamId: string): RecordedStreamEvent[] {
    if (!this.emtMessagesExists()) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT message_type AS type, message_data AS data, stream_position, global_position
           FROM ${messagesTable.name}
          WHERE stream_id = ? AND is_archived = 0
          ORDER BY stream_position ASC, global_position ASC`,
      )
      .all(streamId) as { type: string; data: string; stream_position: number; global_position: number }[];
    return rows.map((row) => ({
      type: row.type,
      data: JSON.parse(row.data) as unknown,
      streamPosition: Number(row.stream_position),
      globalPosition: Number(row.global_position),
    }));
  }

  /** {@link readTranscript} by raw stream id (the live-stream/viewer read path, later slices). */
  readTranscriptStream(streamId: string): RecordedTranscriptEvent[] {
    if (!this.emtMessagesExists()) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT message_type AS type, message_data AS data, stream_position, global_position
           FROM ${messagesTable.name}
          WHERE stream_id = ? AND is_archived = 0
          ORDER BY stream_position ASC, global_position ASC`,
      )
      .all(streamId) as { type: string; data: string; stream_position: number; global_position: number }[];
    return rows.map((row) => ({
      type: row.type as TranscriptEventType,
      data: JSON.parse(row.data) as RecordedTranscriptEvent["data"],
      streamPosition: Number(row.stream_position),
      globalPosition: Number(row.global_position),
    }));
  }

  /**
   * Summarise every un-pruned transcript stream (those that still hold verbose
   * {@link TranscriptMessage}s), optionally scoped to one repo — the input the retention
   * planner consumes. A stream already reduced to its marker has no verbose messages, so
   * it never reappears here (and is never re-pruned). Synchronous; `[]` before any append.
   */
  transcriptSummaries(repo?: string): TranscriptStreamSummary[] {
    if (!this.emtMessagesExists()) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT stream_id,
                MAX(json_extract(message_data, '$.at')) AS newest_at,
                SUM(LENGTH(message_data))               AS byte_size,
                COUNT(*)                                AS message_count
           FROM ${messagesTable.name}
          WHERE is_archived = 0 AND message_type = ? AND stream_id LIKE 'transcript:%'
          GROUP BY stream_id`,
      )
      .all(TRANSCRIPT_MESSAGE_TYPE) as {
      stream_id: string;
      newest_at: string | null;
      byte_size: number | null;
      message_count: number;
    }[];
    const summaries: TranscriptStreamSummary[] = [];
    for (const row of rows) {
      const ref = parseTranscriptStreamId(row.stream_id);
      if (!ref || (repo !== undefined && ref.repo !== repo)) {
        continue;
      }
      summaries.push({
        streamId: row.stream_id,
        repo: ref.repo,
        issueNumber: ref.issueNumber,
        runId: ref.runId,
        newestAt: row.newest_at,
        byteSize: Number(row.byte_size ?? 0),
        messageCount: Number(row.message_count),
      });
    }
    return summaries;
  }

  /**
   * Prune verbose transcripts past the retention {@link TranscriptRetentionBudget}
   * (oldest-first), optionally scoped to one repo. For each pruned stream the
   * {@link TranscriptPruned} marker is appended **before** the verbose messages are
   * deleted, so a crash mid-prune can never leave a silently-empty stream. The domain
   * timeline (the issue stream) is untouched. Returns the executed plan.
   */
  async pruneTranscripts(
    budget: TranscriptRetentionBudget,
    now: Date,
    repo?: string,
  ): Promise<TranscriptPruneResult> {
    const plans = planTranscriptRetention(this.transcriptSummaries(repo), budget, now);
    const at = now.toISOString();
    for (const plan of plans) {
      const ref = parseTranscriptStreamId(plan.streamId);
      if (!ref) {
        continue;
      }
      const { n } = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${messagesTable.name}
            WHERE stream_id = ? AND message_type = ? AND is_archived = 0`,
        )
        .get(plan.streamId, TRANSCRIPT_MESSAGE_TYPE) as { n: number };
      await this.appendRaw<TranscriptEvent>(plan.streamId, [
        { type: "TranscriptPruned", data: { runId: ref.runId, at, prunedMessageCount: n, reason: plan.reason } },
      ]);
      this.db
        .prepare(`DELETE FROM ${messagesTable.name} WHERE stream_id = ? AND message_type = ?`)
        .run(plan.streamId, TRANSCRIPT_MESSAGE_TYPE);
    }
    return { pruned: plans };
  }

  /** Whether Emmett's lazily-created message table exists yet (reads before any append). */
  private emtMessagesExists(): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(messagesTable.name) !== undefined
    );
  }
}
