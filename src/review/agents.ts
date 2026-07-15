/**
 * The two agent roles of the review loop (DESIGN §4), as interfaces the
 * orchestrator depends on — concrete SDK sessions in production, fakes in tests.
 *
 * - The **review agent** runs the target's `AGENTS.md ## Review guidelines` over
 *   the diff *and ingests the PR comments already present*, emitting a single
 *   deduped, severity-ranked {@link Worklist}. Consolidation is folded in here;
 *   there is no separate "decide what to implement" agent (ADR-0005).
 * - The **fix agent** consumes that worklist, applies the `P0`/`P1` items, keeps
 *   build+test green, and pushes — or, on a finding implying a risky structural
 *   change, calls **escalate** rather than applying it blind.
 */

import type { Issue, PrComment } from "../github/types";
import type { Logger } from "../log/logger";
import type { Mode, Phase } from "../store/types";
import type { EscalationQuestion } from "./escalation";
import type { Worklist } from "./worklist";
import type { TranscriptSink } from "../executor/transcript-sink";

/**
 * Points a review-phase fix at the rolling `ralph-review` comment for `phase` on
 * `prNumber` — the authoritative review→fix handoff lives on the PR (issue #47).
 */
export interface ReviewCommentRef {
  prNumber: number;
  phase: Phase;
}

/** What a review agent is handed for one review pass. */
export interface ReviewContext {
  issue: Issue;
  /** The issue's implementation mode — selects whether the tests lens applies. */
  mode: Mode;
  /**
   * The run this review pass belongs to — the correlation tag the container adapter records its
   * resolved route under at dispatch (ADR-0037 P3.1, issue #164). Optional so a routing-agnostic
   * runner / a unit test may omit it (no route is then recorded); the review loop always sets it.
   */
  runId?: number;
  /**
   * The review pass this context drives. Review only ever runs at phase 1 (normal) or 2 (thermo)
   * — phase 0 is the CI gate, which has no review agent — so this is narrower than {@link Phase},
   * letting the recorded phase label derive via {@link phaseLabel}({@link reviewPhase}) without a cast.
   */
  phase: 1 | 2;
  prNumber: number;
  branch: string;
  worktreePath: string;
  /** Automated PR comments already present, to ingest into the worklist. */
  prComments: PrComment[];
  logger: Logger;
  abortSignal?: AbortSignal;
  /** Transcript capture sink for this review session (ADR-0030); absent → no capture. */
  transcriptSink?: TranscriptSink;
}

/** Runs one review pass for a phase and returns the consolidated worklist. */
export interface ReviewAgentRunner {
  review(ctx: ReviewContext): Promise<Worklist>;
}

/** What a fix agent is handed for one fix attempt. */
export interface FixContext {
  issue: Issue;
  /** The issue's implementation mode — `infra` drops the test gate (DESIGN §3). */
  mode: Mode;
  /**
   * The run this fix attempt belongs to — the correlation tag the container adapter records its
   * resolved route under at dispatch (ADR-0037 P3.1, issue #164). Optional so a routing-agnostic
   * runner / a unit test may omit it (no route is then recorded); the review loop always sets it.
   */
  runId?: number;
  phase: Phase;
  /**
   * The worklist to resolve — its gating items are the work. For a review-phase fix
   * this is a **cache** of what the loop posted to the PR; the authoritative copy is
   * the {@link reviewComment} (issue #47). For a CI-gate/conflict fix it is the
   * inline worklist itself.
   */
  worklist: Worklist;
  /**
   * Set for a review-phase fix: the authoritative findings live in the rolling
   * `ralph-review` comment for this phase on this PR. The fix agent reads that
   * comment (plus any new bot/human comments) and resolves its gating items —
   * GitHub is the source of truth, not the in-process {@link worklist}. Absent for a
   * CI-gate/conflict fix, whose worklist is inline.
   */
  reviewComment?: ReviewCommentRef;
  branch: string;
  worktreePath: string;
  /**
   * The base branch the PR targets (the rebase target). Always set by the review loop; the
   * rebase-conflict prompt needs it to tell the fix agent what to rebase onto. Optional only so
   * a routing-agnostic fixture may omit it.
   */
  baseBranch?: string;
  /**
   * Phase 2 fixes must be **behaviour-preserving** (structural/thermo only); a
   * fix agent must not change observable behaviour when this is set (DESIGN §4).
   */
  behaviourPreserving: boolean;
  /**
   * The worklist is a rebase-conflict worklist: a sibling PR merged into base mid-review and
   * the two touch the same code. Under the container model the fix agent runs in a fresh clone
   * of the PR branch where NO rebase is in progress — it must START one (`git rebase
   * origin/<base>`), resolve the conflicts (`git add` + `git rebase --continue`), and report
   * `fixed` WITHOUT pushing (the runner force-pushes the resolved history — force-push is
   * blocked in agent sessions, DESIGN §8). Drives a distinct prompt; never set together with
   * `behaviourPreserving`. Named for what it IS (a rebase-conflict fix), NOT "rebase in progress":
   * no rebase is in progress in the container's fresh clone — the agent starts one (#273).
   */
  rebaseConflict?: boolean;
  /**
   * Operator guidance injected when a review-origin pause resumes this phase
   * (issue #9): the operator answered the heal-card / escalation, and the fix agent
   * applies that ruling as it resolves the worklist. Scoped to the re-entered phase
   * (later phases get a normal, unguided fix); absent on a first-pass fix attempt.
   */
  guidance?: string;
  logger: Logger;
  abortSignal?: AbortSignal;
  /** Transcript capture sink for this fix session (ADR-0030); absent → no capture. */
  transcriptSink?: TranscriptSink;
}

/**
 * A fix attempt's outcome. Exactly two — `fixed` (the gating items were resolved,
 * build+test stayed green, the branch was pushed) or `escalate` (a risky
 * structural change the agent refused to apply blind). There is deliberately no
 * "partially fixed" / "deferred" outcome — the no-deferral rule (CONTEXT).
 */
export type FixOutcome =
  | { kind: "fixed" }
  | { kind: "escalate"; question: EscalationQuestion };

/** Runs one fix attempt against a worklist. */
export interface FixAgentRunner {
  fix(ctx: FixContext): Promise<FixOutcome>;
}

/**
 * Thrown by a runner when an agent's final message cannot be parsed/validated as the
 * required structured output even after the bounded re-prompt budget — the review
 * loop catches it and maxes the phase out gracefully (review-maxed + heal-card)
 * rather than crashing into `agent-stuck` with a closed PR. The class now lives with
 * the structured-session substrate it is thrown from (shared with the auto-mode
 * classifier); re-exported here so the review layer keeps its import path.
 */
export { AgentOutputParseError } from "../executor/structured-session";

/**
 * Thrown by a runner when it could **not produce a result at all** because of an
 * **infrastructure fault** — a dropped pipe, a killed container, a `docker run` that
 * never started — rather than an agent contract violation (issue #220). A part of the
 * runner *contract* (so the review loop stays execution-model-agnostic — it catches
 * this, not a container-specific type). Distinct from {@link AgentOutputParseError}: the
 * review loop **retries** a `RunnerInfraError` a bounded number of times
 * (`maxContainerRetries`) before terminalizing, and surfaces it on an *honest* infra
 * heal-card — never the parse-failure ("did not return parseable JSON") card. `detail`
 * carries the real reason (e.g. the docker exit code / stderr tail) for that card.
 */
export class RunnerInfraError extends Error {
  constructor(
    readonly role: "review" | "fix",
    readonly detail: string,
  ) {
    super(`${role} runner produced no result (infra fault): ${detail}`);
    this.name = "RunnerInfraError";
  }
}
