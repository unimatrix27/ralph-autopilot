/**
 * The per-issue **decider** (ADR-0023/0024): the pure `decide`/`evolve`/`initialState`
 * trio that turns operator/agent intents into {@link IssueEvent}s and folds those
 * events into the issue's **actual state**. Both functions are pure (no IO), in the
 * grain of this repo's other pure cores (`admit`, `classifyIssueState`) — so they are
 * exhaustively unit-testable and portable off Emmett (ADR-0023 exit hatch).
 *
 * `evolve` is also the fold the inline projection materialises (see
 * {@link import("./projection").foldIssueState}); status and fix-attempt counts are
 * *derived* here, never stored as facts (ADR-0024).
 */

import type { Command } from "@event-driven-io/emmett";
import type { Mode, Phase, PhaseRoute, QuestionKind, RunStatus } from "../types";
import type { IssueEvent, RunOutcome } from "./event-types";

/**
 * The lifecycle of an issue's current run, derived from lifecycle events. It *is* the
 * label state machine ({@link import("../types").RunStatus}) plus `none` for an issue
 * that has no run yet — derived from `RunStatus` so the two can never silently diverge.
 */
export type IssueLifecycle = RunStatus | "none";

/** The actual state of one issue, folded from its event stream. */
export interface IssueState {
  /** Lifecycle status, derived from lifecycle events (never stored as a fact). */
  status: IssueLifecycle;
  /** The current run's correlation tag, or null before any run (ADR-0022). */
  runId: string | null;
  /** The PR number once opened, or null. */
  prNumber: number | null;
  /** Fix attempts per review phase — the count *is* the number of `FixAttempted` (ADR-0024). */
  fixAttempts: Record<Phase, number>;
  /** A surfaced anomaly reason (ADR-0016), or null. */
  anomaly: string | null;
  /** Whether the current run reached a terminal `RunEnded`. */
  ended: boolean;
  /**
   * The route the current run's **latest** phase container was dispatched on (ADR-0037 P3.1,
   * issue #164), or null before any dispatch records one. Latest-dispatch-wins: a re-dispatch
   * (notably a resume) overwrites it — one container holds one route for its whole life, so
   * this is the **live** route of the running phase. A fresh run span (`RunStarted`) clears it.
   */
  route: PhaseRoute | null;
}

/** The empty state of an issue with no events yet. */
export const initialIssueState = (): IssueState => ({
  status: "none",
  runId: null,
  prNumber: null,
  fixAttempts: { 0: 0, 1: 0, 2: 0 },
  anomaly: null,
  ended: false,
  route: null,
});

/**
 * Fold one event into the issue's state. Pure and total. Unknown event types leave
 * state unchanged — the **tolerant reader** mandated by ADR-0026, so a log containing
 * a newer (additively-minted) event type still folds on an older binary.
 */
export function evolve(state: IssueState, event: IssueEvent): IssueState {
  switch (event.type) {
    case "RunStarted":
      // A (re-)pickup starts a fresh run: reset run-scoped state, keep any standing
      // anomaly until explicitly cleared.
      return {
        status: "running",
        runId: event.data.runId,
        prNumber: null,
        fixAttempts: { 0: 0, 1: 0, 2: 0 },
        anomaly: state.anomaly,
        ended: false,
        // A fresh span has no recorded route until its first container dispatches (ADR-0037).
        route: null,
      };
    case "PrOpened":
      return { ...state, prNumber: event.data.prNumber };
    case "Escalated":
      return { ...state, status: "awaiting-answer" };
    case "QuestionAnswered":
      // The answer is recorded; the run stays paused until it resumes.
      return state;
    case "Resumed":
      return { ...state, status: "running" };
    case "FixAttempted": {
      const phase = event.data.phase;
      return {
        ...state,
        fixAttempts: { ...state.fixAttempts, [phase]: state.fixAttempts[phase] + 1 },
      };
    }
    case "ReviewPhaseEntered":
      // Re-entering a phase opens a fresh fix-attempt span: zero *that* phase's count
      // (a non-destructive reset — the prior span's `FixAttempted` events stay in the
      // log, the fold just starts counting again from here). Other phases untouched.
      return {
        ...state,
        fixAttempts: { ...state.fixAttempts, [event.data.phase]: 0 },
      };
    case "ReviewPhasePassed":
      // A milestone within the running span, never the hand-off (issue #81): the
      // integration fast-path may skip the final phase's re-review, so awaiting-merge is
      // projected from the explicit `ReviewPassed` fact, not from passing a phase. Status
      // stays as-is (running through review).
      return state;
    case "ReviewPassed":
      // The fast-path-safe review→integration hand-off (issue #81): the run is queued for
      // the single-concurrency merge flow.
      return { ...state, status: "awaiting-merge" };
    case "CiAwaited":
      // Parked off the build pool on the pre-review CI gate (ADR-0022 stage 1, issue #81).
      return { ...state, status: "awaiting-ci" };
    case "RouteResolved":
      // Record the route the latest phase container was dispatched on (ADR-0037 P3.1, issue
      // #164). Latest-dispatch-wins (a resume's re-dispatch overwrites it). The event always
      // carries a route — a route-less (box-default) dispatch emits no `RouteResolved` at all,
      // so `route` stays null by the absence of the fact, not a half-empty one. Status is
      // untouched — this is a visibility fact, not a lifecycle transition.
      return { ...state, route: event.data.route };
    case "ReviewMaxed":
      return { ...state, status: "review-maxed" };
    case "RunStuck":
      return { ...state, status: "agent-stuck" };
    case "Merged":
      return { ...state, status: "merged", prNumber: event.data.prNumber };
    case "RunEnded":
      // The terminal marker the completeness projection reads. It carries no new status
      // value — `merged`/`stuck`/`abandoned` are already pinned by `Merged`/`RunStuck`/the
      // re-pickup's `RunStarted`. The one sanctioned exception (issue #81): the
      // closed-issue orphan-discard (an issue concluded out-of-band) has no other status
      // event, so `closed` projects an effect-neutral terminal — terminal for completeness,
      // no daemon-set label (like `merged`), but read truthfully rather than as `merged`.
      return event.data.outcome === "closed"
        ? { ...state, status: "closed", ended: true }
        : { ...state, ended: true };
    case "AnomalyDetected":
      return { ...state, anomaly: event.data.reason };
    case "AnomalyCleared":
      return { ...state, anomaly: null };
    default:
      // Tolerant reader (ADR-0026): an unrecognised event type is ignored, not an error.
      return state;
  }
}

/** Raised when a command is illegal for the current state (a domain rule violation). */
export class IssueCommandError extends Error {
  override readonly name = "IssueCommandError";
}

// ── Commands — the intents callers issue; `decide` maps them to events ────────

/** Claim a run for an issue (impl begins). Allowed even on a prior run (re-pickup). */
export type StartRun = Command<
  "StartRun",
  { runId: string; mode: Mode; branch?: string | null; worktreePath?: string | null }
>;
export type OpenPr = Command<"OpenPr", { runId: string; prNumber: number }>;
export type Escalate = Command<
  "Escalate",
  { runId: string; kind: QuestionKind; commentId: number | null; headline?: string; phase?: Phase }
>;
export type AnswerQuestion = Command<"AnswerQuestion", { runId: string; commentId: number | null }>;
export type Resume = Command<"Resume", { runId: string }>;
export type RecordFixAttempt = Command<"RecordFixAttempt", { runId: string; phase: Phase }>;
export type EnterReviewPhase = Command<"EnterReviewPhase", { runId: string; phase: Phase }>;
export type RecordRoute = Command<"RecordRoute", { runId: string; phase: string; route: PhaseRoute }>;
export type PassReviewPhase = Command<"PassReviewPhase", { runId: string; phase: Phase }>;
export type MaxReview = Command<"MaxReview", { runId: string; phase: Phase }>;
export type MarkStuck = Command<"MarkStuck", { runId: string; reason: string }>;
export type RecordMerge = Command<"RecordMerge", { runId: string; prNumber: number }>;
export type EndRun = Command<"EndRun", { runId: string; outcome: RunOutcome }>;
export type DetectAnomaly = Command<"DetectAnomaly", { reason: string }>;
export type ClearAnomaly = Command<"ClearAnomaly", Record<string, never>>;

/** Every issue command. */
export type IssueCommand =
  | StartRun
  | OpenPr
  | Escalate
  | AnswerQuestion
  | Resume
  | RecordFixAttempt
  | EnterReviewPhase
  | RecordRoute
  | PassReviewPhase
  | MaxReview
  | MarkStuck
  | RecordMerge
  | EndRun
  | DetectAnomaly
  | ClearAnomaly;

/** Guard: the action presupposes an active run, i.e. at least one `RunStarted`. */
function requireRun(state: IssueState, action: string): void {
  if (state.status === "none") {
    throw new IssueCommandError(`cannot ${action}: no run has started for this issue`);
  }
}

/**
 * Decide which event(s) a command produces, given current state. Pure. Throws
 * {@link IssueCommandError} on an illegal transition (the one invariant enforced here:
 * run-scoped actions require a started run). `DetectAnomaly`/`ClearAnomaly` and an
 * incoming `AnswerQuestion` are valid with or without a run (an anomaly or a late
 * answer can land on an issue the daemon never claimed).
 */
export function decide(command: IssueCommand, state: IssueState): IssueEvent | IssueEvent[] {
  switch (command.type) {
    case "StartRun":
      // Pointer: returns a *single* RunStarted. The abandon-prior-open-span rule (emit
      // RunEnded{abandoned} before RunStarted when a span is open) deliberately lives in
      // the `recordRunStarted` store shim, not here, until the run-status cutover slice
      // folds it in (ADR-0025 sequences `runs.status` LAST).
      return { type: "RunStarted", data: command.data };
    case "OpenPr":
      requireRun(state, "open a PR");
      return { type: "PrOpened", data: command.data };
    case "Escalate":
      requireRun(state, "escalate");
      return { type: "Escalated", data: command.data };
    case "AnswerQuestion":
      return { type: "QuestionAnswered", data: command.data };
    case "Resume":
      requireRun(state, "resume");
      return { type: "Resumed", data: command.data };
    case "RecordFixAttempt":
      requireRun(state, "record a fix attempt");
      return { type: "FixAttempted", data: command.data };
    case "EnterReviewPhase":
      requireRun(state, "enter a review phase");
      return { type: "ReviewPhaseEntered", data: command.data };
    case "RecordRoute":
      requireRun(state, "record a route");
      return { type: "RouteResolved", data: command.data };
    case "PassReviewPhase":
      requireRun(state, "pass a review phase");
      return { type: "ReviewPhasePassed", data: command.data };
    case "MaxReview":
      requireRun(state, "max out review");
      return { type: "ReviewMaxed", data: command.data };
    case "MarkStuck":
      requireRun(state, "mark the run stuck");
      return { type: "RunStuck", data: command.data };
    case "RecordMerge":
      requireRun(state, "record a merge");
      return { type: "Merged", data: command.data };
    case "EndRun":
      requireRun(state, "end the run");
      return { type: "RunEnded", data: command.data };
    case "DetectAnomaly":
      return { type: "AnomalyDetected", data: command.data };
    case "ClearAnomaly":
      return { type: "AnomalyCleared", data: {} };
    default:
      return assertNeverCommand(command);
  }
}

function assertNeverCommand(command: never): never {
  throw new IssueCommandError(`unknown command: ${JSON.stringify(command)}`);
}

/** The issue decider as the `{ decide, evolve, initialState }` triple (ADR-0023). */
export const issueDecider = {
  decide,
  evolve,
  initialState: initialIssueState,
};
