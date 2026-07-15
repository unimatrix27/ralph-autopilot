/**
 * The domain-event vocabulary of the daemon's actual-state event log
 * (ADR-0021/0024). Events are **past-tense business facts** — `RunStarted`,
 * `Escalated`, `FixAttempted`, `Merged` — never generic CRUD events; there is no
 * `StatusChanged`/`Updated` (ADR-0024). Run status and fix-attempt counts are
 * *derived* in projections, never stored as facts.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ADDITIVE-ONLY EVOLUTION RULE — BINDING (ADR-0026)                          │
 * │                                                                           │
 * │ Events are immutable JSON facts that must stay replayable for the life of │
 * │ the log. This is the definition site the rule governs, so at THIS site:   │
 * │                                                                           │
 * │  • NEVER mutate or remove a field on an existing event type. An event     │
 * │    written months ago must still fold the same way today.                 │
 * │  • Only ADD *optional* fields to an existing type (tolerant reader), or   │
 * │  • MINT A NEW TYPE for a breaking change (e.g. `RunStartedV2`) — never     │
 * │    repurpose an existing one.                                             │
 * │  • No upcaster framework: the log is reconstructible from GitHub          │
 * │    (ADR-0021/0003), so a breaking change can rebuild rather than upcast.   │
 * │    The first breaking change that must preserve history is the trigger to │
 * │    add a minimal upcaster — not before.                                   │
 * │                                                                           │
 * │ Readers (`evolve`, projections) must TOLERATE unknown event types and     │
 * │ unknown extra fields — see {@link import("./decider").evolve}'s default.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import type { Event } from "@event-driven-io/emmett";
import type { Mode, Phase, PhaseRoute, QuestionKind } from "../types";

/**
 * How a run ended — the terminal disposition recorded by `RunEnded` (issue #80). A run
 * span closes as `merged` (the PR merged), `closed` (the issue concluded out-of-band — a
 * human closed it without a ralph merge), `abandoned` (a re-pickup superseded the span,
 * or a transient drop re-admits the issue), or `stuck` (a bounded-out `agent-stuck`
 * terminal). `closed` was added additively (ADR-0026); `stuck` is retained.
 */
export type RunOutcome = "merged" | "stuck" | "abandoned" | "closed";

// ── Issue-stream events (`<repo>#<issue>`) ───────────────────────────────────
// A run is a `RunStarted … RunEnded` span; `runId` is a correlation tag carried on
// every event of that run, not a durable identity (ADR-0022).

/**
 * A run was claimed for an issue (impl began) — opens a run span (issue #80). A re-pickup
 * is `RunStarted` again (appended history, no destructive delete, ADR-0022). `branch` is
 * the durable WIP git ref the span runs on; `worktreePath` is the local checkout it used
 * *at span start* — recorded as span history, distinct from the daemon's **live** worktree
 * tracking (PIDs, the currently-attached path) which stays in memory, never the stream.
 * Both are optional only to honour the additive-only rule (ADR-0026) — a pickup sets them.
 */
export type RunStarted = Event<
  "RunStarted",
  { runId: string; mode: Mode; branch?: string | null; worktreePath?: string | null }
>;
/** The run opened its pull request. */
export type PrOpened = Event<"PrOpened", { runId: string; prNumber: number }>;
/**
 * The run paused for a human decision (escalate or heal-card). `headline` is the
 * one-line question text the open-question projection (slice 3, issue #79) surfaces
 * in the HITL queue; `commentId` keys the resume to *this* question (#10). `headline`
 * is optional only to honour the additive-only rule (ADR-0026) — every emitter sets it.
 */
export type Escalated = Event<
  "Escalated",
  { runId: string; kind: QuestionKind; commentId: number | null; headline?: string; phase?: Phase }
>;
/** A human answered the outstanding question (the run can resume next tick). */
export type QuestionAnswered = Event<"QuestionAnswered", { runId: string; commentId: number | null }>;
/** A paused run resumed from its checkpoint with the answer injected. */
export type Resumed = Event<"Resumed", { runId: string }>;
/** One review→fix cycle ran in a phase. The fix count *is* the count of these. */
export type FixAttempted = Event<"FixAttempted", { runId: string; phase: Phase }>;
/**
 * A review phase was (re-)entered, opening a fresh fix-attempt span (ADR-0025). The
 * per-phase fix count is the number of {@link FixAttempted} *since the latest of these
 * for that phase* — so re-entering a phase starts a fresh count **by construction**,
 * with no destructive delete (the prior span's events stay in the log). Phase 0 is the
 * CI gate (the fix-attempt machinery treats it as a phase). This event is what the old
 * destructive fix-attempt reset became; the store appends it via `recordReviewPhaseEntered`.
 */
export type ReviewPhaseEntered = Event<"ReviewPhaseEntered", { runId: string; phase: Phase }>;
/**
 * A review phase returned no gating findings. A *milestone within* the running span — it
 * does NOT pin the integration hand-off status (issue #81): the integration fast-path
 * skips re-review when a rebase's net diff is unchanged, so "the final phase passed" is
 * not a reliable signal that the run is queued for merge. The explicit {@link ReviewPassed}
 * fact is the fast-path-safe hand-off; status stays `running` on this event.
 */
export type ReviewPhasePassed = Event<"ReviewPhasePassed", { runId: string; phase: Phase }>;
/**
 * The review→integration hand-off: review is done and the run is queued for the
 * single-concurrency integration (resolve + merge) flow (ADR-0017). This is the fact
 * `awaiting-merge` is projected from (issue #81). It is **fast-path-safe** — emitted at
 * the hand-off regardless of whether the final review phase re-ran — unlike
 * {@link ReviewPhasePassed}, which the integration fast-path may skip.
 */
export type ReviewPassed = Event<"ReviewPassed", { runId: string }>;
/**
 * The run parked off the build pool on the pre-review CI gate (ADR-0022 stage 1). This is
 * the fact `awaiting-ci` is projected from (issue #81): the build flow handed off to the
 * reconciler's off-slot CI poller, which re-admits the run into review once its checks
 * settle. Non-terminal — it holds the issue but consumes no build budget while it waits.
 */
export type CiAwaited = Event<"CiAwaited", { runId: string }>;
/**
 * The daemon dispatched a phase's container on a resolved route (ADR-0037 P3.1, issue #164).
 * A past-tense business fact emitted **at dispatch** (not a CRUD field): the daemon resolves
 * the route pre-dispatch (#220) and already knows what it dispatched, so no telemetry round-trip
 * is needed. `phase` is the dispatched phase's label (`impl` / `review-1` / `fix-1` / …, the
 * `setAgentPhase` vocabulary). The {@link PhaseRoute} carries the account **id** only — never a
 * credential — so the projection is read-API-safe. One container holds one route for its whole
 * life (no mid-run rotation, ADR-0038), so the route is fixed per dispatch; a **resume** is a
 * fresh dispatch that emits another `RouteResolved`, and the latest one wins (the projection
 * overwrites that run's recorded route). `phase`/`route` are **required**: this is a brand-new
 * event type, so there is no historical `RouteResolved` data to stay replayable against — the
 * additive-only rule (ADR-0026) governs *future* additions to an existing type, not the initial
 * shape of a new one. The sole emitter (`recordDispatchedRoute`) records a `RouteResolved` only
 * when it has both, so a route-less dispatch emits **no** event rather than a half-empty one.
 */
export type RouteResolved = Event<"RouteResolved", { runId: string; phase: string; route: PhaseRoute }>;
/** A phase exhausted its three fix attempts still blocked (`review-maxed`). */
export type ReviewMaxed = Event<"ReviewMaxed", { runId: string; phase: Phase }>;
/** The agent self-stopped on the bounded-effort budget (`agent-stuck`). */
export type RunStuck = Event<"RunStuck", { runId: string; reason: string }>;
/** The PR merged and the issue closed. */
export type Merged = Event<"Merged", { runId: string; prNumber: number }>;
/** The run reached a terminal disposition (closes the `RunStarted` span). */
export type RunEnded = Event<"RunEnded", { runId: string; outcome: RunOutcome }>;
/** The completeness pass flagged this issue as an anomaly/island (ADR-0016). */
export type AnomalyDetected = Event<"AnomalyDetected", { reason: string }>;
/** A previously-flagged anomaly cleared. */
export type AnomalyCleared = Event<"AnomalyCleared", Record<string, never>>;

/** The discriminated union of every issue-stream event (ADR-0024 starter vocabulary). */
export type IssueEvent =
  | RunStarted
  | PrOpened
  | Escalated
  | QuestionAnswered
  | Resumed
  | FixAttempted
  | ReviewPhaseEntered
  | ReviewPhasePassed
  | ReviewPassed
  | CiAwaited
  | RouteResolved
  | ReviewMaxed
  | RunStuck
  | Merged
  | RunEnded
  | AnomalyDetected
  | AnomalyCleared;

/** Every issue-event `type` discriminant. */
export type IssueEventType = IssueEvent["type"];

/**
 * The canonical list of issue-event types — the projection's `canHandle` set. Derived
 * exhaustively from an {@link IssueEventType}-keyed record so the list cannot silently
 * drift from the union: `satisfies Record<IssueEventType, true>` makes omitting a newly
 * minted type a **compile error** here (rather than letting it fall out of the inline
 * projection's fold while `evolve` still folds it). Additive — never remove an entry,
 * since the log keeps events of every minted type.
 */
export const ISSUE_EVENT_TYPES = Object.keys({
  RunStarted: true,
  PrOpened: true,
  Escalated: true,
  QuestionAnswered: true,
  Resumed: true,
  FixAttempted: true,
  ReviewPhaseEntered: true,
  ReviewPhasePassed: true,
  ReviewPassed: true,
  CiAwaited: true,
  RouteResolved: true,
  ReviewMaxed: true,
  RunStuck: true,
  Merged: true,
  RunEnded: true,
  AnomalyDetected: true,
  AnomalyCleared: true,
} satisfies Record<IssueEventType, true>) as IssueEventType[];
