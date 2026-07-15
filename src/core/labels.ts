/**
 * The label vocabulary (CONTEXT: eligibility gate, mode, daemon-anomaly). The
 * bare GitHub label names the daemon reads and writes, plus {@link readMode},
 * which translates the `mode:*` label into the runtime {@link Mode}.
 *
 * This is pure vocabulary — no policy. Admission decides *what the labels mean*
 * for pickup ({@link ./admission}); the HITL layer (`hitl/labels.ts`), the
 * executor, and rehydrate all import the names from here so the strings live in
 * exactly one place.
 */

import type { BacklogPausedState, ComplexityTier, Mode } from "../store/types";

export const LABEL_READY = "ready-for-agent";
export const LABEL_AFK = "afk";
export const LABEL_HITL = "hitl";
export const LABEL_MODE_TDD = "mode:tdd";
export const LABEL_MODE_INFRA = "mode:infra";
export const LABEL_MODE_UI = "mode:ui";

/**
 * Complexity-tier labels (issue #278) — operator-applied, lower = more demanding
 * (the `priority:p0` convention): `1` = hard/architectural, `2` = standard, `3` =
 * routine/mechanical. Selects the per-tier agent profile (`agent.tiers`) for impl
 * runs. Deliberately NOT part of the eligibility gate: an unlabeled issue runs on
 * the global profile — never a stall (no repeat of the no-mode backlog stall).
 */
export const LABEL_COMPLEXITY_1 = "complexity:1";
export const LABEL_COMPLEXITY_2 = "complexity:2";
export const LABEL_COMPLEXITY_3 = "complexity:3";

/**
 * Human-attention label states (DESIGN §9): an agent that pauses or self-stops
 * swaps `ready-for-agent` for one of these. While present the issue is NOT
 * eligible as a fresh impl — eligibility is decided from GitHub labels alone
 * (DESIGN §1, ADR-0003), never from SQLite presence. `awaiting-answer` and
 * `review-maxed` are re-armed by the `ralph-answer` CLI; `agent-stuck` is terminal.
 * `hitl/labels.ts` re-exports the names for the HITL call sites.
 */
export const LABEL_AWAITING_ANSWER = "awaiting-answer";
export const LABEL_REVIEW_MAXED = "review-maxed";
export const LABEL_AGENT_STUCK = "agent-stuck";
/**
 * Daemon-side anomaly (issue #28): the reconciler could not even *claim* an issue
 * after repeated attempts (a git/gh fault, not an agent getting stuck on the
 * task). Surfaced for a human instead of retrying forever and starving the
 * scheduler; it excludes the issue from admission until someone clears the cause
 * and re-labels `ready-for-agent`.
 */
export const LABEL_DAEMON_ANOMALY = "daemon-anomaly";
/**
 * Automated in-flight state (not a human pause): the run passed review and is
 * queued for the single-concurrency integration (resolve + merge) flow. The
 * durable GitHub marker that lets a cold-store restart rebuild the queue and tell
 * an `awaiting-merge` run apart from an in-flight review run (which is otherwise
 * observationally identical). Cleared when integration terminalizes.
 */
export const LABEL_AWAITING_MERGE = "awaiting-merge";
/**
 * Automated in-flight state (not a human pause): the run is parked on the
 * pre-review CI gate, off the build pool (ADR-0022 stage 1). It yielded its build
 * slot; the reconciler's CI poller reads its checks each tick and re-admits it into
 * review once they settle. The durable GitHub marker that lets a cold-store restart
 * rebuild the parked wait via `rehydrate` (otherwise an in-flight review run and a
 * CI-parked one are observationally identical). Cleared when the run leaves the
 * parked state (advances into review, or is discarded).
 */
export const LABEL_AWAITING_CI = "awaiting-ci";

/**
 * The paused/stuck states the backlog read model groups for operator attention (issue
 * #20). Typed as {@link BacklogPausedState} so this list is the single source of
 * the paused-state vocabulary: the backlog projection and {@link pausedStateOf}
 * can never drift from it (a label here that is not a valid state, or vice
 * versa, fails to compile).
 */
export const BACKLOG_PAUSED_STATES: readonly BacklogPausedState[] = [
  LABEL_AWAITING_ANSWER,
  LABEL_REVIEW_MAXED,
  LABEL_AGENT_STUCK,
  LABEL_DAEMON_ANOMALY,
];

/**
 * Labels that exclude an issue from admission regardless of `ready-for-agent`:
 * every human-attention paused/stuck state ({@link BACKLOG_PAUSED_STATES}), plus
 * the two automated in-flight states (not human pauses) — `awaiting-merge` (queued
 * for the single-concurrency integration flow) and `awaiting-ci` (parked off the
 * build pool on the pre-review CI gate, ADR-0022). Both must likewise never be
 * re-admitted as a fresh impl while they wait (defence-in-depth; the run status
 * holds them too).
 */
export const PAUSED_LABELS: readonly string[] = [
  ...BACKLOG_PAUSED_STATES,
  LABEL_AWAITING_MERGE,
  LABEL_AWAITING_CI,
];

/** Whether a label takes an issue out of admission (any {@link PAUSED_LABELS}). */
export function isPausedLabel(label: string): boolean {
  return PAUSED_LABELS.includes(label);
}

/**
 * The paused/stuck state an issue's labels declare, or `null` if none. Scans in
 * {@link BACKLOG_PAUSED_STATES} order so the tie-break is the vocabulary's
 * precedence (not the issue's label order) when an issue carries more than one
 * paused label.
 */
export function pausedStateOf(labels: string[]): BacklogPausedState | null {
  for (const state of BACKLOG_PAUSED_STATES) {
    if (labels.includes(state)) {
      return state;
    }
  }
  return null;
}

/** Milestone-log issues are excluded; their labels start with `[log]`. */
export const LOG_LABEL_PREFIX = "[log]";

/**
 * Read the implementation mode from an issue's labels, if present. Scans in fixed
 * vocabulary order (tdd → infra → ui) so a duplicate-labelled issue resolves by that
 * precedence, not by the issue's label order — the {@link pausedStateOf} convention.
 */
export function readMode(labels: string[]): Mode | null {
  if (labels.includes(LABEL_MODE_TDD)) {
    return "tdd";
  }
  if (labels.includes(LABEL_MODE_INFRA)) {
    return "infra";
  }
  if (labels.includes(LABEL_MODE_UI)) {
    return "ui";
  }
  return null;
}

/** The GitHub label for a runtime implementation mode, the inverse of {@link readMode}. */
export function modeLabelFor(mode: Mode): string {
  switch (mode) {
    case "tdd":
      return LABEL_MODE_TDD;
    case "infra":
      return LABEL_MODE_INFRA;
    case "ui":
      return LABEL_MODE_UI;
  }
}

/**
 * Read the complexity tier from an issue's labels, if present (issue #278). Scans in
 * `complexity:1 → 2 → 3` order so the tie-break is the vocabulary's precedence — the
 * most demanding tier wins when an issue carries more than one (the {@link readMode} /
 * {@link pausedStateOf} convention; duplicate labels are operator sloppiness, never a
 * `daemon-anomaly`). `null` = unlabeled → the global agent profile applies.
 */
export function readTier(labels: string[]): ComplexityTier | null {
  if (labels.includes(LABEL_COMPLEXITY_1)) {
    return 1;
  }
  if (labels.includes(LABEL_COMPLEXITY_2)) {
    return 2;
  }
  if (labels.includes(LABEL_COMPLEXITY_3)) {
    return 3;
  }
  return null;
}

/** The GitHub label for a complexity tier, the inverse of {@link readTier}. */
export function tierLabelFor(tier: ComplexityTier): string {
  return tier === 1 ? LABEL_COMPLEXITY_1 : tier === 2 ? LABEL_COMPLEXITY_2 : LABEL_COMPLEXITY_3;
}
