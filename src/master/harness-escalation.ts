/**
 * The **harness → master hand-off** (ADR-0042, DESIGN §13a): the triage cutover.
 *
 * ADR-0041 routed the two *worker* exits (`escalate`, `stuck`) through a tier-1 master.
 * Everything else the daemon itself detected still manufactured its own human-attention
 * state: a maxed-out review phase posted a heal-card and parked `review-maxed`; a CI gate
 * that never greened did the same; a wedged session, a failed merge preparation and an
 * issue-level reconciler anomaly each terminalized or labelled on their own authority. Every
 * one of those is a *diagnosable issue-scoped fault* — exactly the class a stronger model
 * with the whole hierarchy and the decision ledger in front of it can usually resolve — and
 * every one of them spent operator attention, the system's scarcest resource, to say so.
 *
 * This module is the single door those sources now go through. It is deliberately the same
 * shape as {@link import("./request").MasterTriageRequester} (which keeps the worker-origin
 * path, including its WIP checkpoint) minus the one thing a harness-origin request must not
 * do: there is no agent session to checkpoint, because the branch is already pushed.
 *
 * Three properties are load-bearing:
 *
 *  1. **The source fact is preserved, not replaced.** `ReviewMaxed`, `RunStuck` and
 *     `AnomalyDetected` keep their exact schema and meaning (ADR-0024/0026) and stay in the
 *     stream as history; `MasterTriageRequested` is appended in the **same commit**, so the
 *     latest projection is `master-triage` and no reader can ever observe the intermediate
 *     human-facing state — not a live consumer, not a crash between two writes.
 *  2. **Exactly one request per (phase, signature).** A tick that re-detects the same
 *     anomaly, or a retried gate that fails identically, appends nothing: the fold already
 *     carries a pending request or an open intervention for it. Idempotence lives here
 *     rather than at each call site, because there are now nine call sites.
 *  3. **It never posts a human question.** `ask_human` remains the master's alone. This
 *     module's whole output is a queue entry and its evidence.
 */

import { needsTierOnePromotion, promoteToTierOnePatch, readTier } from "../core/labels";
import type { GitHubClient, Issue } from "../github/types";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import type {
  ComplexityTier,
  MasterLane,
  MasterRequestSource,
  Phase,
  Run,
} from "../store/types";
import { foldMasterHistory } from "./history";
import { formatMasterRequestComment, type MasterWorkerEvidence } from "./request";
import { normalizeFailureSignature } from "./signature";

/**
 * A pre-cutover fact the transition must preserve as history. Empty for sources that never
 * had one (a CI/rebase/merge/hosted-review failure was never modelled as a fact of its own).
 */
export type PreservedSourceFact =
  | { kind: "review-maxed"; phase: Phase }
  | { kind: "run-stuck"; reason: string }
  | { kind: "anomaly"; reason: string };

/** One harness-origin escalation request. */
export interface HarnessEscalationInput {
  issueNumber: number;
  runId: number;
  /** The failure source — the identity half of the normalized signature. */
  source: MasterRequestSource;
  /** The interrupted lane (`review`, `ci`, `merge`, `reconcile`, …). */
  lane: MasterLane;
  /** The run-phase key the two-per-phase budget counts against (`review-1`, `ci`, `merge`, …). */
  phase: string;
  /** What the harness saw, what it already retried, and what it recommends looking at. */
  evidence: MasterWorkerEvidence;
  /** The branch the WIP lives on, when there is one. */
  branch?: string | null;
  prNumber?: number | null;
  /** The live issue, when the caller holds it — needed to compute the tier-1 promotion. */
  issue?: Issue | null;
  /** Facts to preserve in the same commit as the request. */
  sourceFacts?: readonly PreservedSourceFact[];
  logger?: Logger;
}

/** What one harness escalation did. */
export type HarnessEscalationResult =
  | {
      kind: "queued";
      signature: string;
      promotedFrom: ComplexityTier | null;
      commentId: number | null;
    }
  /** Already queued (or already being adjudicated) for this exact (phase, signature). */
  | { kind: "already-queued"; signature: string };

export interface HarnessMasterEscalationDeps {
  store: ScopedStore;
  github: GitHubClient;
  logger: Logger;
}

/**
 * The port the review loop, the executor and the reconciler escalate through. An interface
 * rather than a concrete class at the call sites, so each of those modules can be unit-tested
 * against a recording fake without standing up a store + GitHub pair.
 */
export interface MasterEscalationPort {
  escalate(input: HarnessEscalationInput): Promise<HarnessEscalationResult>;
}

/** Build the durable evidence for a harness-detected failure. */
export function harnessEvidence(input: {
  headline: string;
  detail: string;
  /** What the harness already retried deterministically before giving up. */
  attemptedFixes?: string;
  /** What the master should look at — a pointer, never a conclusion. */
  recommendation?: string;
  uncertainty?: string;
}): MasterWorkerEvidence {
  return {
    headline: input.headline,
    recommendation:
      input.recommendation ??
      "The harness detected this mechanically and has no view of the cause; treat the evidence " +
        "below as a symptom to diagnose, not as a diagnosis.",
    ...(input.attemptedFixes !== undefined ? { attemptedFixes: input.attemptedFixes } : {}),
    ...(input.uncertainty !== undefined ? { uncertainty: input.uncertainty } : {}),
    detail: input.detail,
  };
}

export class HarnessMasterEscalation implements MasterEscalationPort {
  constructor(private readonly deps: HarnessMasterEscalationDeps) {}

  async escalate(input: HarnessEscalationInput): Promise<HarnessEscalationResult> {
    const { store, github } = this.deps;
    const logger = input.logger ?? this.deps.logger;
    const signature = normalizeFailureSignature({
      source: input.source,
      phase: input.phase,
      detail: input.evidence.detail,
    });

    // Idempotence first: the reconciler re-detects a standing anomaly every tick, and a
    // retried gate can fail identically. Either would otherwise append a second request for
    // one failure, which the queue would then service twice.
    const history = foldMasterHistory(store.readIssueStream(input.issueNumber));
    const duplicate =
      (history.pending && history.pending.phase === input.phase && history.pending.signature === signature) ||
      (history.inProgress &&
        history.inProgress.phase === input.phase &&
        history.inProgress.signature === signature);
    if (duplicate) {
      logger.info("master.harness-request-deduped", {
        issue: input.issueNumber,
        source: input.source,
        phase: input.phase,
      });
      return { kind: "already-queued", signature };
    }

    // Promote to tier 1 BEFORE the request is visible: everything downstream — the master's
    // own route and every later lane — reads the tier from the live labels (ADR-0041 §7/§9).
    const promotedFrom = await this.promote(input.issueNumber, input.issue ?? null, logger);

    // Durable evidence on GitHub, so a lost store re-derives the queue from the issue thread.
    const branch = input.branch ?? null;
    let commentId: number | null = null;
    try {
      const posted = await github.postComment(
        input.issueNumber,
        formatMasterRequestComment({
          source: input.source,
          lane: input.lane,
          phase: input.phase,
          issueNumber: input.issueNumber,
          runId: input.runId,
          branch: branch ?? "",
          signature,
          evidence: input.evidence,
        }),
      );
      commentId = posted.id;
    } catch (err) {
      // A failed comment must not lose the escalation: the fact below is what the queue
      // reads, and the engine falls back to the fact's own fields when no comment exists.
      logger.warn("master.harness-request-comment-failed", {
        issue: input.issueNumber,
        error: String(err),
      });
    }

    // The source fact(s) + the request, in ONE commit: the projection lands on
    // `master-triage` and the preserved fact never surfaces as its own pause.
    await store.recordHarnessMasterTriage({
      issueNumber: input.issueNumber,
      runId: input.runId,
      source: input.source,
      phase: input.phase,
      lane: input.lane,
      signature,
      headline: input.evidence.headline,
      recommendation: input.evidence.recommendation,
      ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      ...(input.sourceFacts && input.sourceFacts.length > 0 ? { sourceFacts: input.sourceFacts } : {}),
    });

    store.appendLog({
      runId: input.runId,
      issueNumber: input.issueNumber,
      level: "warn",
      event: "master-triage-requested",
      data: { source: input.source, phase: input.phase, lane: input.lane, signature },
    });
    logger.info("master.harness-triage-requested", {
      issue: input.issueNumber,
      source: input.source,
      lane: input.lane,
      phase: input.phase,
    });
    return { kind: "queued", signature, promotedFrom, commentId };
  }

  /**
   * Apply the permanent tier-1 promotion, idempotently. When the caller does not hold the
   * issue (a reconciler anomaly pass often does not) it is read once; a read failure must not
   * lose the escalation, so it degrades to "no promotion this time" and the next request
   * re-attempts it.
   */
  private async promote(
    issueNumber: number,
    known: Issue | null,
    logger: Logger,
  ): Promise<ComplexityTier | null> {
    const { store, github } = this.deps;
    let issue = known;
    if (!issue) {
      try {
        issue = await github.getIssue(issueNumber);
      } catch (err) {
        logger.warn("master.promote-read-failed", { issue: issueNumber, error: String(err) });
        return null;
      }
    }
    if (!issue) {
      return null;
    }
    const from = readTier(issue.labels);
    if (!needsTierOnePromotion(issue.labels)) {
      return from;
    }
    await github.applyLabelPatch(issueNumber, promoteToTierOnePatch(issue.labels));
    await store.recordComplexityPromoted({ issueNumber, tier: 1, from });
    logger.info("master.promoted", { issue: issueNumber, from, to: 1 });
    return from;
  }
}

/** The `phase` key a review-loop phase escalates under — the budget's counting unit. */
export function reviewPhaseKey(phase: Phase): string {
  return `review-${phase}`;
}

/**
 * The inverse of {@link reviewPhaseKey}: recover the review phase a master request came from,
 * or null when the request came from a non-review lane. This is what lets a master's
 * `resolved-and-continue` re-enter the **exact** phase that was interrupted rather than
 * restarting the implementation — the resume-not-restart guarantee, now decided by the master
 * instead of by an operator's heal.
 */
export function parseReviewPhaseKey(phase: string): Phase | null {
  const match = /^review-([012])$/.exec(phase);
  return match ? (Number(match[1]) as Phase) : null;
}

/**
 * Resolve the `(runId, branch, prNumber)` a harness escalation needs from a run row. Kept
 * here so the nine call sites do not each re-derive the same three fields (and disagree
 * about the null handling).
 */
export function runEscalationTarget(run: Run): {
  runId: number;
  branch: string | null;
  prNumber: number | null;
} {
  return { runId: run.id, branch: run.branch, prNumber: run.prNumber };
}
