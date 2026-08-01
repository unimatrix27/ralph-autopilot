/**
 * The **worker → master hand-off** (ADR-0041, DESIGN §13). A worker's `escalate` no longer
 * manufactures a human question and its `stuck` no longer manufactures a terminal: both
 * checkpoint their WIP and enqueue a **master triage request**. The worker then exits and
 * frees its ordinary slot; nothing is reserved and nothing is handed over.
 *
 * Three things become durable here, in this order, because each is useless without the one
 * before it:
 *
 *  1. **The WIP.** Commit + push the branch and open (or reuse) a draft PR, exactly as the
 *     legacy escalate path did — the master's first move is usually to read the diff, and a
 *     master adjudicating an issue whose work evaporated is adjudicating nothing.
 *  2. **The promotion.** One atomic label patch to `complexity:1`, permanent for the issue.
 *     Everything downstream — the master's own route, and every later impl/resume/review/fix
 *     session — reads the tier from the live labels, so promoting *before* the request is
 *     visible is what makes the tier-1 profile govern the master session itself.
 *  3. **The request.** A fenced `ralph-master-request` comment (so the queue and its evidence
 *     survive a lost store — GitHub is the source of truth) and the `MasterTriageRequested`
 *     fact (so the run projects to `master-triage` and the reconciler's outbox applies the
 *     label). Both idempotent-friendly; the fact is what the queue reads.
 *
 * What this path deliberately does NOT do: post a `ralph-question`, index an open question,
 * add `awaiting-answer`, or record `RunStuck`. Those are the master's to choose later —
 * `ask_human` is the only tool that creates a human question, and only the master holds it.
 */

import { parseFencedPayload, renderFencedPayload, sanitizeForFence } from "../core/fenced-payload";
import { needsTierOnePromotion, promoteToTierOnePatch, readTier } from "../core/labels";
import { buildLaunchMarker } from "../github/marker";
import type { GitHubClient, Issue } from "../github/types";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import { isMasterRequestSource } from "../store/types";
import type { ComplexityTier, MasterLane, MasterRequestSource, Mode } from "../store/types";
import type { WorktreeManager } from "../executor/worktree";
import type { EscalationQuestion } from "../review/escalation";
import type { StuckReport } from "../executor/stuck-tool";
import { normalizeFailureSignature } from "./signature";

/** The fenced tag carrying a durable master-triage request on the issue thread. */
export const RALPH_MASTER_REQUEST_FENCE = "ralph-master-request";

/**
 * The worker's structured evidence — what it saw, what it tried, what it is unsure of, and
 * what it recommends. The recommendation is carried **prominently and labelled as a
 * recommendation**, never as a conclusion: the master must reach (and state) its own.
 */
export interface MasterWorkerEvidence {
  /** One-line statement of what stopped the worker. */
  headline: string;
  /** The worker's recommended course of action — primary evidence, never an answer. */
  recommendation: string;
  /** What the worker already tried (and what happened). */
  attemptedFixes?: string;
  /** What the worker is uncertain about — where it wants a stronger reader to look. */
  uncertainty?: string;
  /** The failure text the normalized signature is computed from. */
  detail: string;
  /** The full escalation question, when the source was `escalate`. */
  question?: EscalationQuestion;
  /** The self-stop report, when the source was `stuck`. */
  stuck?: StuckReport;
}

/** The durable payload of a `ralph-master-request` comment. */
export interface MasterRequestPayload {
  source: MasterRequestSource;
  lane: MasterLane;
  phase: string;
  issueNumber: number;
  runId: number;
  branch: string;
  signature: string;
  evidence: MasterWorkerEvidence;
}

/** Everything the requester needs about the worker session being handed up. */
export interface MasterRequestContext {
  issue: Issue;
  mode: Mode;
  runId: number;
  branch: string;
  worktreePath: string;
  logger: Logger;
}

export interface MasterTriageRequesterDeps {
  store: ScopedStore;
  github: GitHubClient;
  worktrees: WorktreeManager;
}

/** The result of enqueuing a master triage request. */
export interface MasterRequestResult {
  /** The draft PR the WIP was checkpointed onto, or null when none could be opened. */
  prNumber: number | null;
  /** The normalized failure signature the loop budget will compare against. */
  signature: string;
  /** The tier the issue carried before promotion (null when unlabeled). */
  promotedFrom: ComplexityTier | null;
}

/** Render the human-readable + machine-parseable master-request comment. */
export function formatMasterRequestComment(payload: MasterRequestPayload): string {
  const e = payload.evidence;
  const lines = [
    `### Master escalation requested (\`${payload.source}\`)`,
    "",
    `**What stopped the worker:** ${sanitizeForFence(e.headline)}`,
    "",
    `**Worker's recommendation (evidence, not a decision):** ${sanitizeForFence(e.recommendation)}`,
  ];
  if (e.attemptedFixes) {
    lines.push("", `**Already tried:** ${sanitizeForFence(e.attemptedFixes)}`);
  }
  if (e.uncertainty) {
    lines.push("", `**Worker's uncertainty:** ${sanitizeForFence(e.uncertainty)}`);
  }
  lines.push(
    "",
    "The work is checkpointed on the issue branch and the issue is queued for a fresh " +
      "highest-tier master session. **No human action is needed** — the master will resolve it, " +
      "or ask you a specific question if it cannot.",
    "",
    renderFencedPayload(RALPH_MASTER_REQUEST_FENCE, payload),
  );
  return lines.join("\n");
}

/** Parse a `ralph-master-request` comment back, or null when the body carries none. */
export function parseMasterRequestComment(body: string): MasterRequestPayload | null {
  return parseFencedPayload(body, RALPH_MASTER_REQUEST_FENCE, (value) => {
    const v = value as Partial<MasterRequestPayload>;
    if (
      typeof v.phase !== "string" ||
      typeof v.signature !== "string" ||
      typeof v.issueNumber !== "number" ||
      // Every source in the vocabulary parses, worker- and harness-origin alike (ADR-0042).
      // A pre-cutover comment only ever carries `escalate`/`stuck`, which are still members,
      // so old durable evidence keeps parsing unchanged.
      !isMasterRequestSource(v.source) ||
      typeof v.evidence !== "object" ||
      v.evidence === null
    ) {
      throw new Error("malformed ralph-master-request payload");
    }
    return v as MasterRequestPayload;
  });
}

/** The draft PR title/body used to make a handed-up worker's WIP durable. */
export function buildMasterTriageDraftPr(input: {
  issueNumber: number;
  branch: string;
  headline: string;
  title: string;
}): { title: string; body: string } {
  return {
    title: `[master-triage] ${input.title}`,
    body: [
      `Work-in-progress for #${input.issueNumber}, checkpointed for **master escalation**.`,
      "",
      `> ${input.headline}`,
      "",
      "This PR is a durable checkpoint, not a proposal: a fresh highest-tier master session is",
      "adjudicating the run. It re-enters the ordinary CI/review/merge pipeline once resolved.",
      "",
      buildLaunchMarker({ issueNumber: input.issueNumber, branch: input.branch }),
    ].join("\n"),
  };
}

/**
 * Enqueue a master triage request for a worker that called `escalate` or `stuck`.
 *
 * Ordering note: the promotion is applied **before** the request fact so that by the time
 * anything reads the queue, the issue already reads `complexity:1` — the master's own route
 * is derived from that tier, so a request visible ahead of its promotion could dispatch a
 * master on the wrong profile.
 */
export class MasterTriageRequester {
  constructor(private readonly deps: MasterTriageRequesterDeps) {}

  async request(
    ctx: MasterRequestContext,
    input: { source: MasterRequestSource; lane: MasterLane; phase: string; evidence: MasterWorkerEvidence },
  ): Promise<MasterRequestResult> {
    const { store, github, worktrees } = this.deps;
    const { issue, runId, branch } = ctx;
    const signature = normalizeFailureSignature({
      source: input.source,
      phase: input.phase,
      detail: input.evidence.detail,
    });

    // 1. Make the WIP durable before the slot frees — the master reads this diff.
    await worktrees.checkpointWip(ctx.worktreePath, branch);
    const pr = await github.ensureDraftPullRequest(
      branch,
      buildMasterTriageDraftPr({
        issueNumber: issue.number,
        branch,
        headline: input.evidence.headline,
        title: issue.title,
      }),
    );

    // 2. Promote to tier 1, atomically and permanently. Idempotent: a re-escalation of an
    //    already-promoted issue writes no label and appends no second promotion fact.
    const promotedFrom = readTier(issue.labels);
    if (needsTierOnePromotion(issue.labels)) {
      await github.applyLabelPatch(issue.number, promoteToTierOnePatch(issue.labels));
      await store.recordComplexityPromoted({
        issueNumber: issue.number,
        tier: 1,
        from: promotedFrom,
      });
      ctx.logger.info("master.promoted", { issue: issue.number, from: promotedFrom, to: 1 });
    }

    store.upsertRun({
      issueNumber: issue.number,
      mode: ctx.mode,
      tier: 1,
      branch,
      worktreePath: ctx.worktreePath,
      prNumber: pr.number,
      issueTitle: issue.title,
    });

    // 3. Durable evidence on GitHub (survives a lost store) …
    await github.postComment(
      issue.number,
      formatMasterRequestComment({
        source: input.source,
        lane: input.lane,
        phase: input.phase,
        issueNumber: issue.number,
        runId,
        branch,
        signature,
        evidence: input.evidence,
      }),
    );

    // … then the fact the run status (and therefore the `master-triage` label) projects from.
    await store.recordMasterTriageRequested({
      issueNumber: issue.number,
      runId,
      source: input.source,
      phase: input.phase,
      lane: input.lane,
      signature,
      headline: input.evidence.headline,
      recommendation: input.evidence.recommendation,
      prNumber: pr.number,
    });

    store.appendLog({
      runId,
      issueNumber: issue.number,
      level: "info",
      event: "master-triage-requested",
      data: { source: input.source, phase: input.phase, lane: input.lane, signature, prNumber: pr.number },
    });
    ctx.logger.info("master.triage-requested", {
      issue: issue.number,
      source: input.source,
      phase: input.phase,
      prNumber: pr.number,
    });

    return { prNumber: pr.number, signature, promotedFrom };
  }
}

/** Build the worker evidence for an `escalate`-sourced request from its question. */
export function evidenceFromEscalation(question: EscalationQuestion): MasterWorkerEvidence {
  return {
    headline: question.headline,
    recommendation: question.recommendation,
    attemptedFixes: question.whereWeStand,
    uncertainty: question.decision,
    detail: [question.headline, question.decision, question.whereWeStand].join(" — "),
    question,
  };
}

/** Build the worker evidence for a `stuck`-sourced request from its self-stop report. */
export function evidenceFromStuck(report: StuckReport): MasterWorkerEvidence {
  return {
    headline: `Worker bounded out: ${report.category}`,
    recommendation:
      "The worker exhausted its execution budget and made no recommendation beyond stopping; " +
      "treat its reason as evidence about where the work is blocked, not as a conclusion.",
    attemptedFixes: report.reason,
    detail: `${report.category}: ${report.reason}`,
    stuck: report,
  };
}
