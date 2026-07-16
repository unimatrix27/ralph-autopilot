/** Runtime-state row shapes held in SQLite. Rebuildable from GitHub. */

import type { EscalationQuestion } from "../review/escalation";
import type { ProviderName } from "../config/schema";

/** Implementation mode stamped on an issue at triage. */
export type Mode = "tdd" | "infra" | "ui";

/**
 * The complexity tier stamped on an issue via a `complexity:1|2|3` label (issue #278).
 * Lower = more demanding, following the `priority:p0` convention: `1` = hard/architectural,
 * `2` = standard, `3` = routine/mechanical. Selects the per-tier agent profile
 * (`agent.tiers` — routes, effort, wall-clock) for the issue's impl runs; `null` (no label)
 * means the global agent profile, never an admission stall — unlike `mode:*`, the tier is
 * NOT part of the eligibility gate.
 */
export type ComplexityTier = 1 | 2 | 3;

/**
 * The concrete route a phase's container was dispatched on (ADR-0037 P3.1, issue #164) — the
 * read-model projection of a {@link import("../container/assignment").ContainerRoute}. The
 * daemon resolves it pre-dispatch (#220) and records it as the `RouteResolved` business fact,
 * so the fleet view shows the **live** phase's route and the run-detail timeline shows it
 * **per past phase**. One route per container lifetime — it changes only **between** containers
 * (a resume's re-dispatch overwrites it). Carries the account's **id** only, never its
 * credential, so it is safe to serialise to the read API / browser contract (ADR-0031).
 */
export interface PhaseRoute {
  /** The provider kind the phase ran on (`claude` / `openai` / `zai`). */
  provider: ProviderName;
  /** The per-type model override, or absent for the provider's default model. */
  model?: string;
  /** The selected account's id (never its credential). */
  account: string;
}

/** Lifecycle status of a run, mirroring the label state machine. */
export type RunStatus =
  | "running"
  | "awaiting-answer"
  | "agent-stuck"
  | "review-maxed"
  // Parked on the pre-review CI gate, off the build pool (ADR-0022 stage 1). The
  // run yielded its build slot; the reconciler's CI poller reads its checks each
  // tick and re-admits it into review when they settle. Non-terminal — it holds
  // the issue (not in RE_ADMITTABLE_STATUSES) — but consumes no build budget while
  // it waits, exactly like `awaiting-merge`.
  | "awaiting-ci"
  // Review passed; the run is queued for the single-concurrency integration
  // (resolve + merge) flow. Non-terminal — it holds the issue (not in
  // RE_ADMITTABLE_STATUSES), and the build slot is freed once review hands off.
  | "awaiting-merge"
  | "merged"
  // Effect-neutral terminal (issue #81): an issue that concluded out-of-band — a human
  // closed it while the daemon was down, so the orphan-discard never merged. Terminal for
  // completeness and re-admittable like `merged`, but triggers NO daemon-set label and is
  // read truthfully (not mislabelled `merged`). Projected from `RunEnded { outcome: "closed" }`.
  | "closed";

/**
 * A PAUSED run status — the resumable subset a deferred resume restores (issue #101).
 * A run only ever pauses at `awaiting-answer` (an impl/fix-agent `escalate`) or
 * `review-maxed` (a heal-card); these are the two statuses
 * {@link import("../hitl/resume").findResumableRuns} re-picks. Spelled once here and
 * reused (rehydrate's reconstruction, resume's PAUSED list, the restore-paused-status
 * input) so the "paused status" concept never drifts.
 */
export type PausedStatus = Extract<RunStatus, "awaiting-answer" | "review-maxed">;

/**
 * A pipeline phase: 0 = CI gate (await CI before review, issue #41), 1 = normal
 * review, 2 = behaviour-conserving thermo. Phase 0 also covers the merge-time CI
 * re-await and rebase-conflict resolution (both part of the harness merge gate).
 */
export type Phase = 0 | 1 | 2;

/**
 * The input to {@link import("./store").ScopedStore.restorePausedStatus}: re-fold a
 * deferred resume's prior {@link PausedStatus} onto the issue stream (issue #101).
 * Discriminated on `status` so each arm carries only its own fields — `phase` belongs to
 * the `review-maxed` (`ReviewMaxed`) fold, plus the answered heal-card `commentId` so the
 * restore can stay non-notifying; the `awaiting-answer` (`Escalated`) fold needs the question
 * `headline` + `commentId` to re-open-and-answer it without re-surfacing an already-answered
 * question. A status outside this union is unrepresentable, so the store's restore can
 * switch exhaustively and fail loud on a forged value.
 */
export type RestorePausedStatusInput =
  | { runId: number; status: "review-maxed"; phase: Phase; commentId: number | null }
  | { runId: number; status: "awaiting-answer"; headline: string; commentId: number | null };

/** State of a question in the open-question index. */
export type QuestionStatus = "open" | "answered";

/** Kind of question surfaced to a human. */
export type QuestionKind = "escalate" | "heal-card";

export interface Run {
  id: number;
  /** The target repo slug this run belongs to (issue numbers are not unique across repos). */
  repo: string;
  issueNumber: number;
  mode: Mode;
  /**
   * The issue's complexity tier at pickup (issue #278), or `null` when unlabeled. Row
   * bookkeeping like `branch` — dispatch re-reads the live labels; this records what the
   * run was launched under.
   */
  tier: ComplexityTier | null;
  status: RunStatus;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  /**
   * The GitHub issue title, captured at dispatch (issue #13) so the fleet/run views can head
   * a run with *which* issue it is without a read-time GitHub call. `null` for rows predating
   * the column — every consumer degrades to the `repo #issue` reference.
   */
  issueTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fields accepted when creating or upserting a run. The lifecycle **status is
 * event-sourced** (issue #83), never a row field — callers append the status fact
 * (`recordRunStarted`, `recordReviewPassed`, …) rather than passing it here.
 */
export interface RunInput {
  /** The target repo slug. Injected automatically by {@link import("./store").ScopedStore}. */
  repo: string;
  issueNumber: number;
  mode: Mode;
  /** The issue's complexity tier (issue #278); absent/`null` = unlabeled. */
  tier?: ComplexityTier | null;
  branch?: string | null;
  worktreePath?: string | null;
  prNumber?: number | null;
  /**
   * The GitHub issue title, passed at dispatch (issue #13). Absent/`null` leaves any
   * previously-persisted title untouched (the store COALESCEs it), so a later upsert that
   * does not know the title never clobbers it.
   */
  issueTitle?: string | null;
}

/**
 * The checkpoint payload a paused run carries (event-sourced as JSON over the latest run
 * span — the `es_resume_context` projection, issue #80). A pause resumes in exactly one of
 * two ways, and
 * `phase`-presence IS that single behavioural axis — the resume dispatch (issue #9)
 * branches on it alone:
 *   - no phase (impl-agent `escalate`) → resume the impl/fix session, answer injected;
 *   - a phase (review-loop `escalate`, or any `review-maxed` heal) → re-enter the
 *     review loop ({@link import("../review/review-loop").ReviewLoop.runReview}) at
 *     that phase with the answer injected as fix guidance, ending at `awaiting-merge`.
 *
 * Provenance (maxout vs escalate) is not carried here — it lives in
 * {@link OpenQuestion.kind} ('heal-card' | 'escalate') and is fully recoverable from
 * `kind` + phase-presence.
 */
export interface ResumePayload {
  /** The question the operator must answer, injected on resume (as impl context or fix guidance). */
  question: EscalationQuestion;
  /**
   * The review phase, set when the pause came from the review loop (a fix-agent
   * `escalate` or a `review-maxed` heal). Its presence is the dispatch axis: a phase
   * re-enters the review loop there; its absence resumes the impl session (#9).
   */
  phase?: Phase;
  /** The comment id keying this resume to its question, so a stale prior answer is not injected (issue #10). */
  commentId?: number;
}

export interface ResumeContext {
  runId: number;
  branch: string | null;
  /** The typed checkpoint payload (impl-agent escalate, review-loop escalate, or review-maxed heal). */
  context: ResumePayload;
  updatedAt: string;
}

export interface OpenQuestion {
  id: number;
  /** The target repo slug this question belongs to. */
  repo: string;
  issueNumber: number;
  runId: number | null;
  kind: QuestionKind;
  headline: string;
  commentId: number | null;
  status: QuestionStatus;
  createdAt: string;
  answeredAt: string | null;
}

export interface OpenQuestionInput {
  /** The target repo slug. Injected automatically by {@link import("./store").ScopedStore}. */
  repo: string;
  issueNumber: number;
  runId?: number | null;
  kind: QuestionKind;
  headline: string;
  commentId?: number | null;
}

export interface AgentRecord {
  id: number;
  runId: number;
  worktreePath: string;
  branch: string;
  phase: string | null;
  startedAt: string;
  /**
   * When the *current* phase's session started. One agent row spans
   * impl→review→fix (the phase label is flipped in place), so `startedAt` covers
   * the whole run; this is re-stamped on each phase change so live views can show
   * elapsed time for the fresh SDK session (issue #20). Null for rows
   * written before this column existed — callers fall back to `startedAt`.
   */
  phaseStartedAt: string | null;
  endedAt: string | null;
}

export interface AgentInput {
  runId: number;
  worktreePath: string;
  branch: string;
  phase?: string | null;
}

export interface RunLogEntry {
  id: number;
  /** The target repo slug, or null for daemon-global log entries written before a run is scoped. */
  repo: string | null;
  runId: number | null;
  issueNumber: number | null;
  level: string;
  event: string;
  data: Record<string, unknown> | null;
  ts: string;
}

export interface RunLogInput {
  /** The target repo slug. Injected automatically by {@link import("./store").ScopedStore}; null for global entries. */
  repo?: string | null;
  runId?: number | null;
  issueNumber?: number | null;
  level: string;
  event: string;
  data?: Record<string, unknown> | null;
}

// ---- daemon backlog snapshot (issue #20) ---------------------------------
//
// The per-tick projection of the whole pipeline the daemon persists to SQLite
// (one `daemon_snapshot` row) for read models to consume. Plain data, no
// GitHub types — the projection stays SQLite-only and read-only (ADR-0007).

/**
 * A paused/stuck lifecycle state surfaced in the backlog — the human-attention
 * labels the web control plane groups for operators (mirrors `core/labels`
 * BACKLOG_PAUSED_STATES, the human-attention subset of admission's PAUSED_LABELS):
 * `awaiting-answer` / `review-maxed` resume via `ralph-answer`; `agent-stuck` is
 * terminal; `daemon-anomaly` is a stuck claim the daemon could not even start
 * (issue #28). All four surface so a stuck issue never silently leaves the view.
 */
export type BacklogPausedState = "awaiting-answer" | "review-maxed" | "agent-stuck" | "daemon-anomaly";

/**
 * One `## Blocked by` reference and whether it is satisfied (closed + merged).
 * `ref` is a same-repo issue number, or the verbatim `owner/repo#n` of a
 * cross-repo reference the gate cannot evaluate — always unsatisfied, so the
 * issue fails closed and the read model shows why (issue #8).
 */
export interface BacklogBlockerRef {
  ref: number | string;
  satisfied: boolean;
}

/**
 * The colour the web control plane tints an eligible row, bucketed from the issue's rank in the
 * operator's `priorityLabels` list (issue #20): red (most urgent) → blue (least).
 * The daemon computes it (it holds `priorityLabels`) so the viewer stays
 * SQLite-only — one priority model, the configured rank, not a second guess.
 */
export type BacklogPriorityColor = "red" | "yellow" | "blue";

// These base shapes are repo-less: they are the persisted per-repo snapshot, whose
// row already carries `targetRepo`. The aggregate web reader tags each item with its
// source repo when it flattens every repo's snapshot into one global list — that
// repo-required shape is modelled by `RuntimeBacklog` in `projection/snapshot` (issue #108).

/** An eligible issue, in the exact order the scheduler would pick it. */
export interface BacklogEligible {
  issueNumber: number;
  title: string;
  /** The highest-priority label present (the scheduling tie-break), as a display tag. */
  priority: string | null;
  /** Row colour, bucketed from the label's rank in `priorityLabels`; null when none. */
  priorityColor: BacklogPriorityColor | null;
}

/** A blocked issue: its unmet `## Blocked by` refs, with per-ref satisfaction. */
export interface BacklogBlocked {
  issueNumber: number;
  title: string;
  blockers: BacklogBlockerRef[];
}

/** A paused or stuck issue (awaiting-answer / review-maxed / agent-stuck / daemon-anomaly). */
export interface BacklogPaused {
  issueNumber: number;
  title: string;
  state: BacklogPausedState;
}

/**
 * An operator-held issue: `ready-for-agent` + `hitl`, and no human-attention paused label.
 * This is the visible counterpart to the Tier-1 `pause` action, so the web control plane
 * can offer `unpause` instead of letting a manually held issue disappear from every section.
 */
export interface BacklogManualHold {
  issueNumber: number;
  title: string;
}

/**
 * A **moding-pass candidate** (CONTEXT: moding pass): an open issue an operator
 * marked `ready-for-agent` + `afk` whose *only* unmet eligibility-gate condition is
 * the missing `mode:*` label — every other condition, including that all its
 * `## Blocked by` deps are satisfied, already holds. The backlog projection establishes
 * this by re-running the auto-mode pass's own synthetic-mode gate, so a blocked-and-unmoded
 * issue is classified as **blocked**, not listed here as imminently auto-modeable (issue
 * #113). Surfaced so a backlog whose triage forgot to stamp a mode is visible, not
 * silently stalled (the auto-mode pass fills exactly this gap; see {@link selectModingCandidates}).
 */
export interface BacklogModingCandidate {
  issueNumber: number;
  title: string;
}

/**
 * An issue waiting on **no provider** (ADR-0037, CONTEXT: no-provider): it passed the
 * eligibility gate and is in pick-order, but no allowed provider in its `impl` preference list
 * has an account with headroom this tick, so it is **not launched and not escalated** — it keeps
 * `ready-for-agent` and is re-resolved next tick (a wait, not a stuck). Surfaced distinctly from
 * an eligible "queued for a slot" issue so the operator sees *why* it is parked. `resetsAt` is the
 * approximate instant a gated provider pool is expected to regain headroom (the "resets ~HH:MM"
 * ETA), or null when no reset is known — it degrades gracefully.
 */
export interface BacklogNoProvider {
  issueNumber: number;
  title: string;
  /** ISO-8601 instant a provider pool is expected to regain headroom, or null when unknown. */
  resetsAt: string | null;
}

/** The last tick error surfaced as the header's daemon-health indicator. */
export interface DaemonError {
  event: string;
  at: string;
}

/**
 * The classified backlog the daemon produces and persists each tick. The single
 * source of truth for the shape: the reconciler's `buildBacklog` returns it, it
 * rides flat inside {@link DaemonSnapshot} (which extends it), and the web read
 * model consumes it. Adding a category means editing only this declaration.
 */
export interface BacklogView {
  /** Eligible issues in scheduler pick-order (what runs next). */
  eligible: BacklogEligible[];
  /** Blocked issues with their unmet `## Blocked by` refs. */
  blocked: BacklogBlocked[];
  /** Paused/stuck issues (awaiting-answer / review-maxed / agent-stuck / daemon-anomaly). */
  paused: BacklogPaused[];
  /** Operator-held ready issues (`hitl`) that can be returned with `unpause`. */
  manualHolds: BacklogManualHold[];
  /** Issues ready+afk but missing a `mode:*` label (the auto-mode pass's candidates). */
  modingCandidates: BacklogModingCandidate[];
  /**
   * Eligible issues parked because no allowed provider has headroom this tick (ADR-0037
   * no-provider wait) — surfaced distinctly from `eligible` "queued for a slot". Empty in a
   * routing-agnostic setup (the no-provider path is inert).
   */
  noProvider: BacklogNoProvider[];
}

/**
 * The whole-pipeline snapshot the daemon writes each reconcile tick (issue #20).
 * Holds the backlog (eligible in pick-order, blocked + reasons, paused/stuck —
 * via {@link BacklogView}) plus the daemon-health fields the web control plane shows.
 */
export interface DaemonSnapshot extends BacklogView {
  /** When this snapshot (the last reconcile tick) was produced. */
  generatedAt: string;
  targetRepo: string;
  /** Concurrency cap (`maxConcurrentAgents`). */
  cap: number;
  reconcileIntervalSeconds: number;
  /** When the daemon process started, for the uptime readout. */
  daemonStartedAt: string;
  /** The most recent reconcile error, cleared once a tick completes cleanly. */
  lastError: DaemonError | null;
}

/**
 * One persisted web-push subscription (issue #119): a push-service `endpoint` URL plus the
 * browser-generated ECDH public key (`p256dh`) and auth secret (`auth`) the daemon needs to
 * encrypt payloads to that device (RFC 8291). All three come verbatim from the browser's
 * `PushSubscription`. The subscription is NOT rebuildable from GitHub (it is per-device), so
 * unlike run state it is durable runtime state that genuinely lives in SQLite.
 */
export interface PushSubscription {
  /** The push-service URL the daemon POSTs encrypted payloads to. */
  endpoint: string;
  /** Base64url of the subscription's P-256 ECDH public key (uncompressed, 65 octets). */
  p256dh: string;
  /** Base64url of the subscription's 16-octet auth secret. */
  auth: string;
}

/** Input for {@link Store.upsertPushSubscription} — the browser's `PushSubscription` JSON. */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}
