import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { runMigrations } from "./migrations";
import { EventLog, type IssueAggregate, type RecordedTranscriptEvent, type TranscriptPruneResult } from "./event-log";
import { LogBroadcaster } from "./log-broadcast";
import type { IssueEvent, RunOutcome } from "./events/event-types";
import type { IssueProjectionRow } from "./events/projection";
import type { TranscriptEvent, TranscriptRetentionBudget } from "./events/transcript";
import type {
  AgentInput,
  AgentRecord,
  DaemonSnapshot,
  Mode,
  OpenQuestion,
  OpenQuestionInput,
  Phase,
  PhaseRoute,
  PushSubscription,
  PushSubscriptionInput,
  RestorePausedStatusInput,
  ResumeContext,
  ResumePayload,
  Run,
  RunInput,
  RunLogEntry,
  RunLogInput,
  RunStatus,
} from "./types";

/** In-memory database sentinel accepted by better-sqlite3. */
export const MEMORY_DB = ":memory:";

interface RunRow {
  id: number;
  repo: string;
  issue_number: number;
  mode: string;
  tier: number | null;
  branch: string | null;
  worktree_path: string | null;
  pr_number: number | null;
  /** The GitHub issue title, captured at dispatch (issue #13); null for pre-migration rows. */
  issue_title: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: number;
  run_id: number;
  worktree_path: string;
  branch: string;
  phase: string | null;
  started_at: string;
  phase_started_at: string | null;
  ended_at: string | null;
}

interface RunLogRow {
  id: number;
  repo: string | null;
  run_id: number | null;
  issue_number: number | null;
  level: string;
  event: string;
  data: string | null;
  ts: string;
}

interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}

/**
 * Typed read/write access to the runtime-state database. Construct with
 * {@link openStore}, which also applies migrations. The store is transactional
 * and survives reboots; if lost, state is re-derived from GitHub.
 */
export class Store {
  readonly db: Database;
  private readonly now: () => string;
  /**
   * The append-only event log behind the store (ADR-0021/0023), sharing this store's
   * `better-sqlite3` connection. Scaffolded by issue #77 and exercised by its own
   * tests; no state cluster is cut over onto it yet (ADR-0025), so existing callers
   * are unchanged. The per-repo {@link ScopedStore} exposes repo-scoped issue-event
   * helpers over it.
   */
  readonly events: EventLog;

  /**
   * The in-process live broadcast channel (ADR-0029, issue #109): the event log's
   * after-commit emitter publishes here, and durable live tails subscribe to coalesced
   * wake-ups. Wake-only delivery keeps slow edge consumers from back-pressuring the
   * append path or growing an in-memory event buffer. Idle (no subscribers) until an
   * edge attaches, so a daemon with those edges off carries it for free. The web layer
   * reaches it only through a read-only port (ADR-0029 isolation), never by reaching
   * into the store.
   */
  readonly liveLog: LogBroadcaster;

  constructor(db: Database, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
    this.liveLog = new LogBroadcaster();
    this.events = new EventLog(db, now);
    // Fan every committed append out to the live channel the moment it commits.
    this.events.onCommit = (events) => this.liveLog.publish(events);
  }

  close(): void {
    this.db.close();
  }

  // ---- runs --------------------------------------------------------------

  /**
   * The run's **event-sourced** lifecycle status. With the strangler cleanup (issue #83) the
   * legacy `runs.status` column is gone: the status is *only* ever the fold of the issue
   * stream's status events (the ADR-0024 table), materialised in the inline projection. A
   * stream that carries no status-defining fact yet folds to `none` — that happens only in
   * the synchronous window of `claim`, between `upsertRun` creating the row and its
   * `RunStarted` append landing (the run-id is consumed there, never the status), so it
   * reads as `running`, the status that append is about to pin. Every other run row has a
   * status fact (pickup→`RunStarted`, hand-offs→`ReviewPassed`/`CiAwaited`, terminals→
   * `Merged`/`ReviewMaxed`/`RunStuck`, and a cold-store rehydrate re-appends them), so the
   * default is never load-bearing for a settled run.
   */
  private effectiveStatus(row: RunRow): RunStatus {
    const status = this.events.readIssueProjection(row.repo, row.issue_number)?.status;
    return status && status !== "none" ? (status as RunStatus) : "running";
  }

  /** Decode a run row, overlaying its event-sourced {@link effectiveStatus} (issue #81). */
  private mapRun(row: RunRow): Run {
    return {
      id: row.id,
      repo: row.repo,
      issueNumber: row.issue_number,
      mode: row.mode as Run["mode"],
      tier: (row.tier ?? null) as Run["tier"],
      status: this.effectiveStatus(row),
      branch: row.branch,
      worktreePath: row.worktree_path,
      prNumber: row.pr_number,
      issueTitle: row.issue_title ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Insert a run, or update the existing run for the (repo, issue). The row holds only
   * the run's non-derived bookkeeping (mode, branch, worktree, PR, timestamps); the
   * lifecycle **status is event-sourced** and never written here (issue #83) — callers
   * append the status fact (`recordRunStarted`, `recordReviewPassed`, …) separately.
   */
  upsertRun(input: RunInput): Run {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO runs (repo, issue_number, mode, tier, branch, worktree_path, pr_number, issue_title, created_at, updated_at)
         VALUES (@repo, @issue_number, @mode, @tier, @branch, @worktree_path, @pr_number, @issue_title, @ts, @ts)
         ON CONFLICT(repo, issue_number) DO UPDATE SET
           mode = excluded.mode,
           tier = excluded.tier,
           branch = excluded.branch,
           worktree_path = excluded.worktree_path,
           pr_number = excluded.pr_number,
           -- The title is plumbed once at dispatch and is durable for run history (issue #13):
           -- a later upsert that does not re-pass it (e.g. recording the PR) must NOT clobber
           -- it to null, so keep the existing value when the incoming one is absent.
           issue_title = COALESCE(excluded.issue_title, runs.issue_title),
           updated_at = excluded.updated_at`,
      )
      .run({
        repo: input.repo,
        issue_number: input.issueNumber,
        mode: input.mode,
        tier: input.tier ?? null,
        branch: input.branch ?? null,
        worktree_path: input.worktreePath ?? null,
        pr_number: input.prNumber ?? null,
        issue_title: input.issueTitle ?? null,
        ts,
      });
    const run = this.getRunByIssue(input.repo, input.issueNumber);
    if (!run) {
      throw new Error(`upsertRun failed for ${input.repo}#${input.issueNumber}`);
    }
    return run;
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare<[number], RunRow>("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? this.mapRun(row) : undefined;
  }

  getRunByIssue(repo: string, issueNumber: number): Run | undefined {
    const row = this.db
      .prepare<[string, number], RunRow>("SELECT * FROM runs WHERE repo = ? AND issue_number = ?")
      .get(repo, issueNumber);
    return row ? this.mapRun(row) : undefined;
  }

  /**
   * Delete the run for a (repo, issue) (cascades to its `agents` rows). Used to roll back
   * a claim that fails after the run row is created, so the issue is not wedged by a
   * permanent `running` row. A no-op if no run exists for the issue. The run's
   * event-sourced state (fix attempts, status, resume context) lives in the append-only
   * issue stream and is intentionally not deleted — it is rebuildable, and a rolled-back
   * claim has recorded none of it. The resume-context read-model row is dropped here
   * (mirroring the old FK cascade) so a re-pickup never folds a superseded span's
   * checkpoint before its own `RunStarted` clear lands; the stream's events stay (no
   * destructive delete).
   */
  deleteRunByIssue(repo: string, issueNumber: number): void {
    this.db.prepare("DELETE FROM runs WHERE repo = ? AND issue_number = ?").run(repo, issueNumber);
    this.events.clearResumeContext(repo, issueNumber);
  }

  /** Runs for one target repo, in issue order. */
  listRuns(repo: string): Run[] {
    return this.db
      .prepare<[string], RunRow>("SELECT * FROM runs WHERE repo = ? ORDER BY issue_number")
      .all(repo)
      .map((row) => this.mapRun(row));
  }

  /** Every run across all targets, in (repo, issue) order — the global read-model input. */
  listAllRuns(): Run[] {
    return this.db
      .prepare<[], RunRow>("SELECT * FROM runs ORDER BY repo, issue_number")
      .all()
      .map((row) => this.mapRun(row));
  }

  // ---- status / review facts (event-sourced, ADR-0024/0025) -------------
  //
  // The run's lifecycle status is **derived, never stored** (issue #81/#83): each
  // transition is its own past-tense fact on the issue stream (the ADR-0024 table — there
  // is no generic `StatusChanged`), and the status read-back ({@link getRun} /
  // {@link getRunByIssue} / {@link listRunsByStatus}) folds it from the inline projection.
  // The strangler cleanup (issue #83) deleted the `setRunStatus`/`increment-`/`resetFix-`
  // mutation shims; these `record*` methods are the event-native API the call sites use to
  // append the matching fact. Like the run-span methods they raw-append (no `decide`
  // run-required guard) and key by the issue stream; `runId` is the correlation tag carried
  // on every event of the run (ADR-0022), distinct from the issue stream key.

  /** Append a single fact to an issue's stream (the one-event `record*` write path). */
  private appendIssueEvent(repo: string, issueNumber: number, event: IssueEvent): Promise<bigint> {
    return this.events.appendToIssue(repo, issueNumber, [event]);
  }

  private questionEvent(input: OpenQuestionInput): IssueEvent {
    return {
      type: "Escalated",
      data: {
        runId: input.runId != null ? String(input.runId) : "",
        kind: input.kind,
        headline: input.headline,
        commentId: input.commentId ?? null,
      },
    };
  }

  /** Append `ReviewPassed` — the fast-path-safe review→integration hand-off (`awaiting-merge`). */
  async recordReviewPassed(repo: string, issueNumber: number, input: { runId: number }): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "ReviewPassed",
      data: { runId: String(input.runId) },
    });
  }

  /** Append `CiAwaited` — the run parked off the build pool on the pre-review CI gate (`awaiting-ci`). */
  async recordCiAwaited(repo: string, issueNumber: number, input: { runId: number }): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "CiAwaited",
      data: { runId: String(input.runId) },
    });
  }

  /** Append `ReviewMaxed` — a phase exhausted its fix attempts still blocked (`review-maxed`). */
  async recordReviewMaxed(
    repo: string,
    issueNumber: number,
    input: { runId: number; phase: Phase },
  ): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "ReviewMaxed",
      data: { runId: String(input.runId), phase: input.phase },
    });
  }

  /**
   * Append a heal-card `Escalated` and the matching `ReviewMaxed` status fact in one
   * commit. A review max-out is one operator attention event even though two facts
   * model it, so live consumers must see them as one batch.
   */
  async recordReviewMaxedQuestion(
    repo: string,
    issueNumber: number,
    input: { runId: number; phase: Phase; headline: string; commentId?: number | null },
  ): Promise<OpenQuestion> {
    await this.events.appendToIssue(repo, issueNumber, [
      this.questionEvent({
        repo,
        issueNumber,
        runId: input.runId,
        kind: "heal-card",
        headline: input.headline,
        commentId: input.commentId ?? null,
      }),
      {
        type: "ReviewMaxed",
        data: { runId: String(input.runId), phase: input.phase },
      },
    ]);
    const question = this.events.openQuestionForIssue(repo, issueNumber);
    if (!question) {
      throw new Error("recordReviewMaxedQuestion failed to read back the appended question");
    }
    return question;
  }

  /** Append `RunStuck` — the run bounded out on the effort budget (`agent-stuck`). */
  async recordRunStuck(
    repo: string,
    issueNumber: number,
    input: { runId: number; reason: string },
  ): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "RunStuck",
      data: { runId: String(input.runId), reason: input.reason },
    });
  }

  /**
   * Append `RunStuck` plus `AnomalyDetected` in one commit for claim parks: the run row
   * terminalizes, but the user-facing issue surface is `daemon-anomaly`.
   */
  async recordRunStuckWithAnomaly(
    repo: string,
    issueNumber: number,
    input: { runId: number; reason: string; anomalyReason: string },
  ): Promise<void> {
    await this.events.appendToIssue(repo, issueNumber, [
      {
        type: "RunStuck",
        data: { runId: String(input.runId), reason: input.reason },
      },
      {
        type: "AnomalyDetected",
        data: { reason: input.anomalyReason },
      },
    ]);
  }

  /** Append `AnomalyDetected` — the daemon surfaced a `daemon-anomaly` human-attention state. */
  async recordAnomalyDetected(repo: string, issueNumber: number, input: { reason: string }): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "AnomalyDetected",
      data: { reason: input.reason },
    });
  }

  /** Append `AnomalyCleared` — a previously surfaced daemon anomaly no longer applies. */
  async recordAnomalyCleared(repo: string, issueNumber: number): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "AnomalyCleared",
      data: {},
    });
  }

  /** Append `Merged` — the PR merged and the issue closed (`merged`). */
  async recordMerged(
    repo: string,
    issueNumber: number,
    input: { runId: number; prNumber: number },
  ): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "Merged",
      data: { runId: String(input.runId), prNumber: input.prNumber },
    });
  }

  /**
   * Re-fold a deferred resume's prior PAUSED status onto the issue stream (issue #101). A
   * resume that defers on a transient GitHub rate-limit already appended `Resumed`
   * (→ `running`); to put the run back in the resumable set it must re-append the lifecycle
   * fact that *derives* the status it paused at (issue #83 — the status column is gone). The
   * event-model compensation rule lives here, behind the store boundary, so the caller just
   * says "restore the paused status". The two PAUSED statuses findResumableRuns re-picks each
   * have one folding fact:
   *   - `review-maxed` (a heal-card) → `ReviewMaxed`. The fold keys status off the event type
   *     alone (its `phase` is informational), and a same-batch `QuestionAnswered` marks this
   *     as an already-answered compensation for live consumers.
   *   - `awaiting-answer` (an impl/fix-agent escalate) → `Escalated`, the *only* fact that
   *     folds to awaiting-answer. `Escalated` also opens a question in the open-questions
   *     projection, but the resume already answered this run's question — so re-answer the
   *     re-appended escalation in the same breath, restoring the status without re-surfacing an
   *     already-answered question. Re-resume next tick rides the durable resume context +
   *     answer comment, not an open question, so the re-closed question costs nothing.
   */
  async restorePausedStatus(repo: string, issueNumber: number, input: RestorePausedStatusInput): Promise<void> {
    switch (input.status) {
      case "review-maxed":
        await this.events.appendToIssue(repo, issueNumber, [
          {
            type: "ReviewMaxed",
            data: { runId: String(input.runId), phase: input.phase },
          },
          {
            type: "QuestionAnswered",
            data: {
              runId: String(input.runId),
              commentId: input.commentId,
            },
          },
        ]);
        return;
      case "awaiting-answer": {
        await this.events.appendToIssue(repo, issueNumber, [
          this.questionEvent({
            repo,
            issueNumber,
            runId: input.runId,
            kind: "escalate",
            headline: input.headline,
            commentId: input.commentId,
          }),
          {
            type: "QuestionAnswered",
            data: {
              runId: String(input.runId),
              commentId: input.commentId ?? null,
            },
          },
        ]);
        return;
      }
      default: {
        // `input` is narrowed to `never` — a status outside the paused union reached
        // here only via a forged cast. Fail loud rather than synthesize a phantom fact.
        const forged: never = input;
        throw new Error(`restorePausedStatus: not a paused status: ${JSON.stringify(forged)}`);
      }
    }
  }

  // ---- fix-attempt counters (event-sourced, ADR-0024/0025) --------------
  //
  // The per-phase fix-attempt counter is **derived, never stored** (issue #78): each
  // attempt is a `FixAttempted` event on the issue stream, and `getFixAttempts` reads the
  // inline projection's folded count. Re-entering a phase appends `ReviewPhaseEntered`,
  // a non-destructive reset — the prior span's `FixAttempted` events stay in the log, the
  // fold just starts that phase's count over.

  /** The issue stream key for a legacy run id, or `null` if the run row is gone. */
  private streamForRun(runId: number): { repo: string; issueNumber: number } | null {
    const run = this.getRun(runId);
    return run ? { repo: run.repo, issueNumber: run.issueNumber } : null;
  }

  /** The derived fix-attempt count for a phase: `FixAttempted` events in its current span. */
  getFixAttempts(runId: number, phase: Phase): number {
    const ref = this.streamForRun(runId);
    if (!ref) {
      return 0;
    }
    const projection = this.events.readIssueProjection(ref.repo, ref.issueNumber);
    return projection?.fixAttempts[phase] ?? 0;
  }

  /** Append one `FixAttempted` for the phase and return the new derived count. */
  async recordFixAttempt(
    repo: string,
    issueNumber: number,
    input: { runId: number; phase: Phase },
  ): Promise<number> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "FixAttempted",
      data: { runId: String(input.runId), phase: input.phase },
    });
    const projection = this.events.readIssueProjection(repo, issueNumber);
    return projection?.fixAttempts[input.phase] ?? 0;
  }

  /**
   * Open a fresh fix-attempt span for the phase by appending `ReviewPhaseEntered` —
   * a non-destructive reset (the prior span's events stay in the log; the projection
   * just starts the per-phase count over). Equivalent in effect to the old destructive
   * `DELETE`/zero, expressed as an event (ADR-0025).
   */
  async recordReviewPhaseEntered(
    repo: string,
    issueNumber: number,
    input: { runId: number; phase: Phase },
  ): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "ReviewPhaseEntered",
      data: { runId: String(input.runId), phase: input.phase },
    });
  }

  // ---- per-phase route (event-sourced, ADR-0037 P3.1 / issue #164) -------
  //
  // The daemon resolves a phase's route pre-dispatch (#220) and already knows what it
  // dispatched, so it records the route as a `RouteResolved` business fact at dispatch — no
  // telemetry round-trip. The projection folds the **latest** route onto the run (latest-wins:
  // a resume's re-dispatch overwrites it), so the fleet view's live route + `getRunRoute` read
  // one value. Like the other run-span facts this raw-appends, keyed by the issue stream.

  /**
   * Append a `RouteResolved` recording the route a phase's container was dispatched on. `phase`
   * is the dispatched phase's label (`impl` / `review-1` / `fix-1` / …); `route` carries the
   * account **id** only (never its credential). A route-less (box-default) dispatch is *not*
   * recorded as a half-empty fact — the caller (`recordDispatchedRoute`) skips the append
   * entirely — so the route is always present here.
   */
  async recordRouteResolved(
    repo: string,
    issueNumber: number,
    input: { runId: number; phase: string; route: PhaseRoute },
  ): Promise<void> {
    await this.appendIssueEvent(repo, issueNumber, {
      type: "RouteResolved",
      data: { runId: String(input.runId), phase: input.phase, route: input.route },
    });
  }

  /**
   * The route the run's latest phase container was dispatched on (ADR-0037 P3.1), or `null` when
   * none is recorded (no dispatch yet, a box-default dispatch, or the run row is gone). Reads the
   * inline projection's folded latest-wins route, mapping the legacy numeric `runId` to its issue
   * stream like {@link getFixAttempts}.
   */
  getRunRoute(runId: number): PhaseRoute | null {
    const ref = this.streamForRun(runId);
    if (!ref) {
      return null;
    }
    return this.events.readIssueProjection(ref.repo, ref.issueNumber)?.route ?? null;
  }

  // ---- run span (event-sourced lifecycle, ADR-0022/0024) ----------------
  //
  // A run is a `RunStarted … RunEnded` span within its issue stream (issue #80). Pickup
  // appends `RunStarted` (a re-pickup is appended history — a new span, no destructive
  // delete — abandoning any prior open span first), a resume appends `Resumed`, and a
  // terminal/abandon/close appends `RunEnded { outcome }`. These are the lifecycle facts
  // the resume-context and run-status projections fold. They raw-append (no `decide`
  // run-required guard), keyed by the issue stream.

  /**
   * Append `RunStarted`, opening a fresh run span on the issue stream. Abandons any prior
   * open span first (`RunEnded { abandoned }`) so a re-pickup is appended history, not a
   * destructive delete (ADR-0022); the `RunStarted` clears the span's resume context.
   *
   * Pointer: the abandon-prior-open-span rule deliberately lives here, not in
   * `decide(StartRun)` (which still returns a single RunStarted) — folding it into the
   * decider is a behaviour-neutral follow-up, out of scope for the storage cleanup.
   */
  async recordRunStarted(
    repo: string,
    issueNumber: number,
    input: { runId: number; mode: Mode; branch?: string | null; worktreePath?: string | null },
  ): Promise<void> {
    const events: IssueEvent[] = [];
    const prior = this.events.readIssueProjection(repo, issueNumber);
    if (prior && prior.status !== "none" && !prior.ended) {
      // Close the superseded span before opening the new one — the prior pickup was
      // abandoned (a re-admit, a transient drop, or a crash re-pickup).
      events.push({
        type: "RunEnded",
        data: { runId: prior.runId ?? String(input.runId), outcome: "abandoned" },
      });
    }
    events.push({
      type: "RunStarted",
      data: {
        runId: String(input.runId),
        mode: input.mode,
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
      },
    });
    await this.events.appendToIssue(repo, issueNumber, events);
  }

  /** Append `RunEnded { outcome }`, closing the issue's current run span. */
  async recordRunEnded(
    repo: string,
    issueNumber: number,
    input: { runId: number; outcome: RunOutcome },
  ): Promise<void> {
    await this.events.appendToIssue(repo, issueNumber, [
      { type: "RunEnded", data: { runId: String(input.runId), outcome: input.outcome } },
    ]);
  }

  /** Append `Resumed`, recording that a paused run resumed from its checkpoint. */
  async recordResumed(repo: string, issueNumber: number, input: { runId: number }): Promise<void> {
    await this.events.appendToIssue(repo, issueNumber, [
      { type: "Resumed", data: { runId: String(input.runId) } },
    ]);
  }

  // ---- resume context (event-sourced, ADR-0024/0025) --------------------
  //
  // The WIP checkpoint a paused run carries (DESIGN §6) is the slice-4 state cluster cut
  // over onto the event log (issue #80). It is a projection over the issue's latest run
  // span ({@link import("./events/resume-context-projection")}): a `RunStarted` resets it
  // (the span boundary, event-folded inline), and the checkpoint write below is the
  // synchronous **write** — kept synchronous (not an async append) so its callers
  // (`resume.ts`, `rehydrate.ts`, `escalation-checkpoint.ts`) read it back in the same
  // tick with their unchanged signatures. It maps the legacy numeric `runId` (a `runs.id`)
  // to the issue stream via its run row, like {@link getFixAttempts}.

  setResumeContext(runId: number, context: ResumePayload, branch: string | null = null): void {
    const ref = this.streamForRun(runId);
    if (!ref) {
      return; // no run row → nothing to checkpoint (a missing run cannot resume).
    }
    this.events.upsertResumeContext(ref.repo, ref.issueNumber, {
      runId,
      branch,
      context,
      updatedAt: this.now(),
    });
  }

  getResumeContext(runId: number): ResumeContext | undefined {
    const ref = this.streamForRun(runId);
    if (!ref) {
      return undefined;
    }
    const row = this.events.resumeContextForIssue(ref.repo, ref.issueNumber);
    if (!row) {
      return undefined;
    }
    // The payload was typed at the write boundary (issue #9) and parsed once in the
    // projection decode; thread it through verbatim as the single trust point.
    return { runId, branch: row.branch, context: row.context, updatedAt: row.updatedAt };
  }

  // ---- open-question index (event-sourced, ADR-0024/0025) ---------------
  //
  // The HITL open-question index (DESIGN §6) is the slice-3 state cluster cut over onto
  // the event log (issue #79). The index is **derived, never stored**: an escalation
  // appends `Escalated { kind, headline, commentId }` to the issue stream, an answer
  // appends `QuestionAnswered { commentId }`, and the open-question list is the inline
  // projection ({@link import("./events/open-questions-projection")}) folded from those.
  // `addQuestion`/`answerQuestion` are the event-native write API (they append the specific
  // `Escalated`/`QuestionAnswered` facts — not a generic CRUD mutation, so they survive the
  // strangler cleanup): reads stay synchronous off the materialised projection, writes go
  // through the async append.
  //
  // The non-idempotent side effects of an escalation — the `ralph-question` comment, the
  // draft PR, the resume context — stay inline at the decision point (escalation-checkpoint
  // / review-loop); only the index/state derivation is event-sourced. Like the run-span
  // methods, these raw-append (bypassing the `decide` run-required guard), keyed by the
  // issue stream.

  /** Append an `Escalated` for the question and return the derived open-question row. */
  async addQuestion(input: OpenQuestionInput): Promise<OpenQuestion> {
    await this.events.appendToIssue(input.repo, input.issueNumber, [this.questionEvent(input)]);
    const question = this.events.openQuestionForIssue(input.repo, input.issueNumber);
    if (!question) {
      throw new Error("addQuestion failed to read back the appended question");
    }
    return question;
  }

  getQuestion(id: number): OpenQuestion | undefined {
    return this.events.questionById(id) ?? undefined;
  }

  /** Open questions for one target repo, oldest first (the derived projection). */
  listOpenQuestions(repo: string): OpenQuestion[] {
    return this.events.openQuestionsByRepo(repo);
  }

  /** Open questions across every target, oldest first — the global HITL queue view. */
  listAllOpenQuestions(): OpenQuestion[] {
    return this.events.allOpenQuestions();
  }

  /**
   * Append a `QuestionAnswered` for the question, closing it in the projection. Keyed by
   * the question's `commentId` (the resume/`ralph-answer` correlation key, issue #10);
   * this is the answer-fact the open-question index folds (open → answered).
   */
  async answerQuestion(id: number): Promise<void> {
    const question = this.events.questionById(id);
    if (!question) {
      throw new Error(`answerQuestion: no question with id ${id}`);
    }
    const event: IssueEvent = {
      type: "QuestionAnswered",
      data: {
        runId: question.runId != null ? String(question.runId) : "",
        commentId: question.commentId,
      },
    };
    await this.events.appendToIssue(question.repo, question.issueNumber, [event]);
  }

  // ---- agent / worktree bookkeeping -------------------------------------

  addAgent(input: AgentInput): AgentRecord {
    const ts = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO agents (run_id, worktree_path, branch, phase, started_at, phase_started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.runId, input.worktreePath, input.branch, input.phase ?? null, ts, ts);
    const agent = this.getAgent(Number(res.lastInsertRowid));
    if (!agent) {
      throw new Error("addAgent failed to read back inserted row");
    }
    return agent;
  }

  getAgent(id: number): AgentRecord | undefined {
    const row = this.db
      .prepare<[number], AgentRow>("SELECT * FROM agents WHERE id = ?")
      .get(id);
    return row ? this.mapAgent(row) : undefined;
  }

  /**
   * Flip the agent's phase label and re-stamp the phase clock. Each phase is a
   * fresh SDK session reusing the one agent row, so `phase_started_at` advances
   * with the label while `started_at` keeps measuring the whole run (issue #20).
   */
  setAgentPhase(id: number, phase: string): void {
    const res = this.db
      .prepare("UPDATE agents SET phase = ?, phase_started_at = ? WHERE id = ?")
      .run(phase, this.now(), id);
    if (res.changes === 0) {
      throw new Error(`setAgentPhase: no agent with id ${id}`);
    }
  }

  endAgent(id: number): void {
    this.db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(this.now(), id);
  }

  /**
   * End every still-open agent record. Called once at daemon startup: after a
   * crash, `ended_at IS NULL` rows are stale — nothing is actually running on a
   * fresh process — so reconciliation closes them before re-deriving real state
   * (otherwise live views would show ghost agents).
   */
  endAllActiveAgents(): void {
    this.db.prepare("UPDATE agents SET ended_at = ? WHERE ended_at IS NULL").run(this.now());
  }

  listActiveAgents(): AgentRecord[] {
    return this.db
      .prepare<[], AgentRow>("SELECT * FROM agents WHERE ended_at IS NULL ORDER BY started_at")
      .all()
      .map((row) => this.mapAgent(row));
  }

  private mapAgent(row: AgentRow): AgentRecord {
    return {
      id: row.id,
      runId: row.run_id,
      worktreePath: row.worktree_path,
      branch: row.branch,
      phase: row.phase,
      startedAt: row.started_at,
      phaseStartedAt: row.phase_started_at,
      endedAt: row.ended_at,
    };
  }

  // ---- run log -----------------------------------------------------------

  appendLog(input: RunLogInput): RunLogEntry {
    const res = this.db
      .prepare(
        `INSERT INTO run_log (repo, run_id, issue_number, level, event, data, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.repo ?? null,
        input.runId ?? null,
        input.issueNumber ?? null,
        input.level,
        input.event,
        input.data ? JSON.stringify(input.data) : null,
        this.now(),
      );
    const entry = this.getLogEntry(Number(res.lastInsertRowid));
    if (!entry) {
      throw new Error("appendLog failed to read back inserted row");
    }
    return entry;
  }

  getLogEntry(id: number): RunLogEntry | undefined {
    const row = this.db
      .prepare<[number], RunLogRow>("SELECT * FROM run_log WHERE id = ?")
      .get(id);
    return row ? this.mapLog(row) : undefined;
  }

  /** Most recent log entries for a run, newest first. */
  tailLog(runId: number, limit = 100): RunLogEntry[] {
    return this.db
      .prepare<[number, number], RunLogRow>(
        "SELECT * FROM run_log WHERE run_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(runId, limit)
      .map((row) => this.mapLog(row));
  }

  /**
   * Most recent log entries across every run, newest first. Backs global recent
   * activity views rather than a single run.
   */
  recentLog(limit = 100): RunLogEntry[] {
    return this.db
      .prepare<[number], RunLogRow>("SELECT * FROM run_log ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => this.mapLog(row));
  }

  /**
   * Every run-log entry at or after an ISO-8601 instant, oldest first — the windowed
   * history the web analytics view folds into trends (issue #115). Unbounded by count
   * (the time bound is the cap); `ts` is the ISO string `appendLog` stamps, so a lexical
   * `>=` is a chronological `>=`.
   */
  logSince(sinceIso: string): RunLogEntry[] {
    return this.db
      .prepare<[string], RunLogRow>("SELECT * FROM run_log WHERE ts >= ? ORDER BY ts, id")
      .all(sinceIso)
      .map((row) => this.mapLog(row));
  }

  /**
   * The most recent `daemon-anomaly` log row for every (repo, issue) that has one —
   * the logged classification reason behind each surfaced island (issue #116). The
   * anomaly edge is logged ONCE (the label is the standing signal, issue #28), so its
   * reason can fall outside the bounded {@link recentLog} window after a busy spell;
   * this `MAX(id)`-per-(repo, issue) query recovers it regardless of log volume. Newest
   * island first. Backs the web Health view's anomaly list.
   */
  latestAnomalies(): RunLogEntry[] {
    return this.db
      .prepare<[], RunLogRow>(
        `SELECT * FROM run_log r
         WHERE r.event = 'daemon-anomaly'
           AND r.id = (
             SELECT MAX(id) FROM run_log
             WHERE event = 'daemon-anomaly' AND repo IS r.repo AND issue_number IS r.issue_number
           )
         ORDER BY r.id DESC`,
      )
      .all()
      .map((row) => this.mapLog(row));
  }

  /**
   * Each run's start anchor — the earliest `run_log` timestamp per run id — across all
   * time. Backs the analytics time-to-merge metric (issue #115): a run picked up before
   * the window can still merge inside it, and its time-to-merge needs the start, which a
   * windowed read would miss. One row per run; cheap regardless of the window.
   */
  runStartTimes(): { runId: number; startedAt: string }[] {
    return this.db
      .prepare<[], { run_id: number; started_at: string }>(
        "SELECT run_id, MIN(ts) AS started_at FROM run_log WHERE run_id IS NOT NULL GROUP BY run_id",
      )
      .all()
      .map((row) => ({ runId: row.run_id, startedAt: row.started_at }));
  }

  /**
   * Runs in a given lifecycle status for one target repo, oldest first (queue order).
   * Filters on the **event-sourced** {@link effectiveStatus} (issue #81), not the vestigial
   * column — so the off-slot queues (`awaiting-ci` / `awaiting-merge`) and read models see the
   * folded status. `updated_at, id` still orders the queue (the shim keeps `updated_at`
   * fresh on each status change), so FIFO is preserved.
   */
  listRunsByStatus(repo: string, status: RunStatus): Run[] {
    return this.db
      .prepare<[string], RunRow>("SELECT * FROM runs WHERE repo = ? ORDER BY updated_at, id")
      .all(repo)
      .map((row) => this.mapRun(row))
      .filter((run) => run.status === status);
  }

  // ---- daemon backlog snapshot (issue #20) ------------------------------

  /**
   * Persist the per-tick backlog/health snapshot for one target repo, overwriting
   * that repo's `daemon_snapshot` row. The daemon calls this every reconcile tick
   * per repo; read models consume them through {@link listBacklogSnapshots}, so
   * the whole multi-repo pipeline reaches the viewer with no GitHub dependency
   * (ADR-0007).
   */
  saveBacklogSnapshot(repo: string, snapshot: DaemonSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO daemon_snapshot (repo, payload) VALUES (?, ?)
         ON CONFLICT(repo) DO UPDATE SET payload = excluded.payload`,
      )
      .run(repo, JSON.stringify(snapshot));
  }

  /** The latest backlog/health snapshot for one repo, or `null` before its first tick. */
  getBacklogSnapshot(repo: string): DaemonSnapshot | null {
    const row = this.db
      .prepare<[string], { payload: string }>("SELECT payload FROM daemon_snapshot WHERE repo = ?")
      .get(repo);
    return row ? (JSON.parse(row.payload) as DaemonSnapshot) : null;
  }

  /** Every target's latest snapshot, repo-ordered — the global read model input. */
  listBacklogSnapshots(): DaemonSnapshot[] {
    return this.db
      .prepare<[], { payload: string }>("SELECT payload FROM daemon_snapshot ORDER BY repo")
      .all()
      .map((row) => JSON.parse(row.payload) as DaemonSnapshot);
  }

  private mapLog(row: RunLogRow): RunLogEntry {
    return {
      id: row.id,
      repo: row.repo,
      runId: row.run_id,
      issueNumber: row.issue_number,
      level: row.level,
      event: row.event,
      data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : null,
      ts: row.ts,
    };
  }

  // ---- web-push subscriptions (PWA web push, issue #119) -----------------
  //
  // Per-device push subscriptions the browser registers, persisted so a push survives a
  // daemon restart (unlike run state they are NOT rebuildable from GitHub — a subscription
  // lives until the device unsubscribes). The web control plane's `/api/webpush/subscribe`
  // writes here; the notification sink's web-push dispatcher reads here on each dispatch.

  /** Insert a subscription, or refresh its keys if the device re-subscribed to the same endpoint. */
  upsertPushSubscription(input: PushSubscriptionInput): PushSubscription {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at)
         VALUES (@endpoint, @p256dh, @auth, @ts, @ts)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           updated_at = excluded.updated_at`,
      )
      .run({ endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, ts });
    const row = this.db
      .prepare<[string], PushSubscriptionRow>("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(input.endpoint);
    if (!row) {
      throw new Error(`upsertPushSubscription failed for ${input.endpoint}`);
    }
    return this.mapPushSubscription(row);
  }

  /** Every persisted subscription — the fan-out set the web-push dispatcher POSTs to. */
  listPushSubscriptions(): PushSubscription[] {
    return this.db
      .prepare<[], PushSubscriptionRow>("SELECT * FROM push_subscriptions ORDER BY id")
      .all()
      .map((row) => this.mapPushSubscription(row));
  }

  /** One subscription by its push-service endpoint, or `undefined`. */
  getPushSubscription(endpoint: string): PushSubscription | undefined {
    const row = this.db
      .prepare<[string], PushSubscriptionRow>("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(endpoint);
    return row ? this.mapPushSubscription(row) : undefined;
  }

  /**
   * Delete a subscription by endpoint. Called when the device unsubscribes (UI) and when a
   * push to it is rejected 404/410 by the push service (the subscription has expired). A
   * no-op if it is already gone.
   */
  deletePushSubscription(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  private mapPushSubscription(row: PushSubscriptionRow): PushSubscription {
    return {
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
    };
  }

  /**
   * A view of this store scoped to one target repo (ADR-0020). The per-repo
   * components (executor, review loop, reconciler, rehydrate, resume) are handed a
   * {@link ScopedStore} rather than the raw store, so their issue-number-keyed
   * lookups are automatically qualified by repo and can never return another repo's
   * run for a colliding issue number — the load-bearing guarantee for the
   * completeness invariant under multiple repos.
   */
  forRepo(repo: string): ScopedStore {
    return new ScopedStore(this, repo);
  }
}

/** Input to a scoped writer, with `repo` dropped — the scope supplies it. */
type Unscoped<T extends { repo?: unknown }> = Omit<T, "repo">;

/**
 * A {@link Store} bound to one target repo. Issue-number-keyed methods drop their
 * `repo` argument (the scope injects it); id-keyed methods (runs by id, fix
 * attempts, resume context, agents, log tails — all keyed by globally-unique
 * autoincrement ids) delegate unchanged. This is the only store handed to the
 * per-repo components, so the type system itself prevents an unscoped issue lookup.
 */
export class ScopedStore {
  constructor(
    private readonly store: Store,
    /** The target repo slug this view is bound to. */
    readonly repo: string,
  ) {}

  // ---- issue-number-keyed (auto-scoped to this.repo) --------------------
  upsertRun(input: Unscoped<RunInput>): Run {
    return this.store.upsertRun({ ...input, repo: this.repo });
  }
  getRunByIssue(issueNumber: number): Run | undefined {
    return this.store.getRunByIssue(this.repo, issueNumber);
  }
  deleteRunByIssue(issueNumber: number): void {
    this.store.deleteRunByIssue(this.repo, issueNumber);
  }
  listRuns(): Run[] {
    return this.store.listRuns(this.repo);
  }
  listRunsByStatus(status: Run["status"]): Run[] {
    return this.store.listRunsByStatus(this.repo, status);
  }
  addQuestion(input: Unscoped<OpenQuestionInput>): Promise<OpenQuestion> {
    return this.store.addQuestion({ ...input, repo: this.repo });
  }
  listOpenQuestions(): OpenQuestion[] {
    return this.store.listOpenQuestions(this.repo);
  }
  appendLog(input: Unscoped<RunLogInput>): RunLogEntry {
    return this.store.appendLog({ ...input, repo: this.repo });
  }
  saveBacklogSnapshot(snapshot: DaemonSnapshot): void {
    this.store.saveBacklogSnapshot(this.repo, snapshot);
  }
  getBacklogSnapshot(): DaemonSnapshot | null {
    return this.store.getBacklogSnapshot(this.repo);
  }

  // ---- id-keyed (globally unique — delegated unchanged) -----------------
  getRun(id: number): Run | undefined {
    return this.store.getRun(id);
  }
  getFixAttempts(runId: number, phase: Phase): number {
    return this.store.getFixAttempts(runId, phase);
  }
  setResumeContext(runId: number, context: ResumePayload, branch: string | null = null): void {
    this.store.setResumeContext(runId, context, branch);
  }
  getResumeContext(runId: number): ResumeContext | undefined {
    return this.store.getResumeContext(runId);
  }
  // ---- run span + status/review facts (auto-scoped to this.repo) --------
  recordRunStarted(input: {
    runId: number;
    issueNumber: number;
    mode: Mode;
    branch?: string | null;
    worktreePath?: string | null;
  }): Promise<void> {
    return this.store.recordRunStarted(this.repo, input.issueNumber, input);
  }
  recordRunEnded(input: { runId: number; issueNumber: number; outcome: RunOutcome }): Promise<void> {
    return this.store.recordRunEnded(this.repo, input.issueNumber, input);
  }
  recordResumed(input: { runId: number; issueNumber: number }): Promise<void> {
    return this.store.recordResumed(this.repo, input.issueNumber, input);
  }
  recordReviewPassed(input: { runId: number; issueNumber: number }): Promise<void> {
    return this.store.recordReviewPassed(this.repo, input.issueNumber, input);
  }
  recordCiAwaited(input: { runId: number; issueNumber: number }): Promise<void> {
    return this.store.recordCiAwaited(this.repo, input.issueNumber, input);
  }
  recordReviewMaxed(input: { runId: number; issueNumber: number; phase: Phase }): Promise<void> {
    return this.store.recordReviewMaxed(this.repo, input.issueNumber, input);
  }
  recordReviewMaxedQuestion(input: {
    runId: number;
    issueNumber: number;
    phase: Phase;
    headline: string;
    commentId?: number | null;
  }): Promise<OpenQuestion> {
    return this.store.recordReviewMaxedQuestion(this.repo, input.issueNumber, input);
  }
  recordRunStuck(input: { runId: number; issueNumber: number; reason: string }): Promise<void> {
    return this.store.recordRunStuck(this.repo, input.issueNumber, input);
  }
  recordRunStuckWithAnomaly(input: {
    runId: number;
    issueNumber: number;
    reason: string;
    anomalyReason: string;
  }): Promise<void> {
    return this.store.recordRunStuckWithAnomaly(this.repo, input.issueNumber, input);
  }
  recordAnomalyDetected(input: { issueNumber: number; reason: string }): Promise<void> {
    return this.store.recordAnomalyDetected(this.repo, input.issueNumber, input);
  }
  recordAnomalyCleared(input: { issueNumber: number }): Promise<void> {
    return this.store.recordAnomalyCleared(this.repo, input.issueNumber);
  }
  recordMerged(input: { runId: number; issueNumber: number; prNumber: number }): Promise<void> {
    return this.store.recordMerged(this.repo, input.issueNumber, input);
  }
  restorePausedStatus(input: RestorePausedStatusInput & { issueNumber: number }): Promise<void> {
    return this.store.restorePausedStatus(this.repo, input.issueNumber, input);
  }
  recordFixAttempt(input: { runId: number; issueNumber: number; phase: Phase }): Promise<number> {
    return this.store.recordFixAttempt(this.repo, input.issueNumber, input);
  }
  recordReviewPhaseEntered(input: { runId: number; issueNumber: number; phase: Phase }): Promise<void> {
    return this.store.recordReviewPhaseEntered(this.repo, input.issueNumber, input);
  }
  recordRouteResolved(input: { runId: number; issueNumber: number; phase: string; route: PhaseRoute }): Promise<void> {
    return this.store.recordRouteResolved(this.repo, input.issueNumber, input);
  }
  getRunRoute(runId: number): PhaseRoute | null {
    return this.store.getRunRoute(runId);
  }
  getQuestion(id: number): OpenQuestion | undefined {
    return this.store.getQuestion(id);
  }
  answerQuestion(id: number): Promise<void> {
    return this.store.answerQuestion(id);
  }
  addAgent(input: AgentInput): AgentRecord {
    return this.store.addAgent(input);
  }
  getAgent(id: number): AgentRecord | undefined {
    return this.store.getAgent(id);
  }
  /**
   * Active agents across every repo (delegated global). The per-repo orphan-worktree
   * GC only matches these against THIS repo's tracked worktree paths, which are
   * disjoint from other repos' roots — so seeing all of them can only over-keep a
   * path under another root (a no-op here), never wrongly prune.
   */
  listActiveAgents(): AgentRecord[] {
    return this.store.listActiveAgents();
  }
  setAgentPhase(id: number, phase: string): void {
    this.store.setAgentPhase(id, phase);
  }
  endAgent(id: number): void {
    this.store.endAgent(id);
  }
  tailLog(runId: number, limit?: number): RunLogEntry[] {
    return this.store.tailLog(runId, limit);
  }
  getLogEntry(id: number): RunLogEntry | undefined {
    return this.store.getLogEntry(id);
  }

  // ---- event log (ADR-0021/0023, auto-scoped to this.repo) --------------
  /** The shared event log (system stream + raw access). Issue streams are repo-scoped below. */
  get events(): EventLog {
    return this.store.events;
  }
  /**
   * Append events to this repo's issue stream (`<repo>#<issue>`), folding the inline
   * projection in the same transaction. `expectedVersion` enforces the single-writer
   * expected-version guard (ADR-0022). Returns the stream version after the append.
   */
  appendIssueEvents(
    issueNumber: number,
    events: IssueEvent[],
    expectedVersion?: bigint,
  ): Promise<bigint> {
    return this.store.events.appendToIssue(this.repo, issueNumber, events, expectedVersion);
  }
  /** Fold this repo's issue stream into its actual state (read-your-write on the log). */
  aggregateIssue(issueNumber: number): Promise<IssueAggregate> {
    return this.store.events.aggregateIssue(this.repo, issueNumber);
  }
  /** Read the materialised projection row for this repo's issue, or null if no events. */
  readIssueProjection(issueNumber: number): IssueProjectionRow | null {
    return this.store.events.readIssueProjection(this.repo, issueNumber);
  }

  // ---- per-run transcripts (ADR-0030, auto-scoped to this.repo) ----------
  /** Append captured transcript events to this repo's per-run stream (raw — never the domain log). */
  appendToTranscript(issueNumber: number, runId: string, events: TranscriptEvent[]): Promise<void> {
    return this.store.events.appendToTranscript(this.repo, issueNumber, runId, events);
  }
  /** Read one run's captured transcript in append order (the viewer/live-stream read path). */
  readTranscript(issueNumber: number, runId: string): RecordedTranscriptEvent[] {
    return this.store.events.readTranscript(this.repo, issueNumber, runId);
  }
  /** Prune this repo's verbose transcripts past the retention budget (oldest-first; ADR-0030). */
  pruneTranscripts(budget: TranscriptRetentionBudget, now: Date): Promise<TranscriptPruneResult> {
    return this.store.events.pruneTranscripts(budget, now, this.repo);
  }

  // ---- delegated global helpers (lifecycle + cross-repo reads) -----------
  /** The most recent log entries across every run, newest first (global). */
  recentLog(limit?: number): RunLogEntry[] {
    return this.store.recentLog(limit);
  }
  /** End every still-open agent record (global startup reconciliation). */
  endAllActiveAgents(): void {
    this.store.endAllActiveAgents();
  }
  /** Close the underlying database. */
  close(): void {
    this.store.close();
  }
  /** Escape hatch to the unscoped store (e.g. cross-repo reads in web/API helpers). */
  get raw(): Store {
    return this.store;
  }
}

export interface OpenStoreOptions {
  /** Injected clock for deterministic tests. */
  now?: () => string;
}

/**
 * Open (creating parent dirs as needed) the SQLite database, apply migrations
 * idempotently, and return a typed {@link Store}. Pass {@link MEMORY_DB} for an
 * ephemeral in-memory database.
 */
export function openStore(path: string, options: OpenStoreOptions = {}): Store {
  if (path !== MEMORY_DB) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // A separate process can open this same DB file (the web control plane reads
  // in-process, but an operator's tail tool or a self-update hand-off might);
  // WAL checkpoint/lock contention from it can make a daemon write throw
  // SQLITE_BUSY immediately. Set the timeout explicitly rather than relying on
  // better-sqlite3's default so a write retries for up to 5s before failing.
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return new Store(db, options.now);
}
