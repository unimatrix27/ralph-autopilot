/**
 * The **master escalation engine** (ADR-0041, DESIGN §13): one queued master triage request
 * in, exactly one durable outcome out.
 *
 * The engine is where the binding decisions of ADR-0041 stop being prose:
 *
 *  - **Route or refuse.** A missing / non-tools-capable tier-1 profile is surfaced as a named
 *    configuration attention state and consumes **no** budget. There is no cheaper master.
 *  - **Budget before session.** The attempt number, the repeated-signature verdict, and the
 *    forbidden resolutions are computed before the model is asked anything, shown to it, and
 *    then **re-checked against its answer** — a master that proposes a spent recovery does not
 *    get to run it.
 *  - **Restart-exact.** `MasterInterventionStarted` is appended before the session and consumes
 *    the pending request; a daemon that dies mid-session re-adopts that same numbered attempt
 *    instead of spending a second one or running two sessions for one request.
 *  - **Decisions are ledger writes, not prose.** A new key is appended through ADR-0040; a key
 *    that already has an active record is a *contradiction* and is routed to `ask-human`.
 *  - **`ask_human` is the only door to a human.** Nothing else in this path posts a
 *    `ralph-question` or reaches `awaiting-answer`.
 */

import type { GitHubClient, Issue, IssueRef } from "../github/types";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import type { MasterResolution, Run } from "../store/types";
import type { RoutingSource, RouteWorld } from "../providers/resolve";
import type { ContainerRoute } from "../container/assignment";
import { recordDispatchedRoute } from "../container/route-recording";
import { buildHierarchyMap } from "../hierarchy/map";
import { appendDecision, readDecisionLedger } from "../ledger/ledger";
import { syncDecisionIndex } from "../ledger/index-comment";
import type { DecisionRecord } from "../ledger/decision";
import { formatRalphQuestion, type EscalationQuestion } from "../review/escalation";
import {
  evaluateMasterBudget,
  readoptedAttemptBudget,
  resolutionAllowed,
  type MasterBudgetVerdict,
} from "./budget";
import {
  assembleMasterContext,
  hasActiveDecisionFor,
  type MasterContext,
  type MasterContextDeps,
  type MasterHumanAnswer,
} from "./context";
import { foldMasterHistory, type MasterHistory, type PendingMasterRequest } from "./history";
import { buildMasterPrompt, MASTER_SYSTEM_APPEND } from "./prompt";
import type { MasterDecisionDraft, MasterOutcome, MasterSessionResult } from "./outcome";
import { parseMasterRequestComment, type MasterRequestPayload } from "./request";
import { describeMasterRouteDefect, resolveMasterRoute, type MasterRouteResolution } from "./route";

/** The phase label a master session records its route under. */
export const MASTER_PHASE_LABEL = "master";

/** Everything one master session needs; the runner turns it into a live agent session. */
export interface MasterSessionInput {
  context: MasterContext;
  prompt: string;
  systemAppend: string;
  route: ContainerRoute | null;
  branch: string;
  worktreePath: string | null;
  runId: number;
  issue: Issue;
  logger: Logger;
  abortSignal?: AbortSignal;
}

/**
 * What a master session returns. `limited` is a **defer, not a fault** (ADR-0023 usage-limit
 * guard): the pending request stays pending and the next tick re-dispatches on a rotated
 * account, exactly as every other agent lane behaves under a usage cap.
 */
export type MasterSessionOutcome =
  | { kind: "outcome"; result: MasterSessionResult }
  | { kind: "limited"; detail?: string }
  | { kind: "failed"; detail: string };

/** Runs one fresh master session to completion. Faked in the unit suite. */
export interface MasterAgentRunner {
  run(input: MasterSessionInput): Promise<MasterSessionOutcome>;
}

/** How a resolved master hands the run back to the ordinary pipeline. */
export interface MasterPipelinePort {
  /**
   * Re-enter the interrupted phase on the preserved WIP branch with the master's brief
   * injected (resume-not-restart). Backs both `resolved-and-continue` (the master repaired or
   * supplied authoritative guidance) and `redispatch-tier-1` (a fresh tier-1 worker).
   */
  continueRun(input: {
    run: Run;
    issue: Issue;
    resolution: Extract<MasterResolution, "resolved-and-continue" | "redispatch-tier-1">;
    brief: string;
    conclusion: string;
  }): Promise<void>;
  /**
   * Re-run ONE typed harness gate. Re-running a gate is never bypassing it: the CI gate runs
   * CI again, the review gate reviews again. The port has no "treat as passed" mode by
   * construction.
   */
  retry(input: {
    run: Run;
    issue: Issue;
    action: "ci" | "review" | "merge" | "reconcile";
    brief: string;
  }): Promise<void>;
}

export interface MasterEngineDeps {
  store: ScopedStore;
  github: GitHubClient;
  agent: MasterAgentRunner;
  pipeline: MasterPipelinePort;
  logger: Logger;
  targetRepo: string;
  baseBranch: string;
  /** Live routing + account pool; absent → the engine cannot route and says so. */
  routing?: RoutingSource;
  routeWorld?: RouteWorld;
  /** Extra context ports (WIP worktree read, run-log tail, fix counts). */
  context?: Omit<MasterContextDeps, "github">;
  now?: () => Date;
}

/** What one `runMasterIntervention` call did — the reconciler logs it, tests assert it. */
export type MasterInterventionResult =
  | { kind: "resolved"; attempt: number; resolution: MasterResolution }
  | { kind: "deferred"; reason: "no-provider" | "usage-limited" | "session-failed"; detail?: string }
  | { kind: "unconfigured"; detail: string }
  | { kind: "budget-exhausted"; spent: number }
  | { kind: "no-request" };

/** A synthesized card for a state a human must see but no master could adjudicate. */
function budgetExhaustedQuestion(phase: string, spent: number, prior: string[]): EscalationQuestion {
  return {
    headline: `Master escalation exhausted its budget in phase \`${phase}\``,
    feature: "Master escalation (ADR-0041)",
    whereWeStand: [
      `Two master interventions have already run in this phase and the run is still blocked.`,
      "A third cannot launch — that ceiling exists so a strong model cannot loop forever on one failure.",
      "",
      "What the masters chose:",
      ...prior.map((p) => `- ${p}`),
    ].join("\n"),
    decision: "How should this run be resolved?",
    options: [
      "Provide guidance and re-enable the run (heal) so a fresh attempt has it injected",
      "Re-scope the issue (edit it and re-label `ready-for-agent`)",
      "Close the issue",
    ],
    stakes: `Spent ${spent} master interventions without resolving the run. The issue is parked on \`agent-stuck\`; nothing advances it until a human acts.`,
    recommendation:
      "Read the masters' rationales above. If they converged on one blocker, resolve that and re-enable the run; " +
      "if the issue is mis-scoped, re-scope it rather than re-running the same adjudication.",
  };
}

/** The card posted when the master proposed a resolution the loop budget forbids. */
function forbiddenRepeatQuestion(phase: string, resolution: MasterResolution, conclusion: string): EscalationQuestion {
  return {
    headline: `Master proposed a recovery already spent on this failure`,
    feature: "Master escalation (ADR-0041)",
    whereWeStand: [
      `The same normalized failure signature has already been adjudicated in phase \`${phase}\`, and the master`,
      `chose \`${resolution}\` again — a recovery that has already been tried and did not work. The harness`,
      "refused to run it, because repeating a spent recovery is how an autonomous loop becomes an infinite one.",
      "",
      "The master's conclusion was:",
      conclusion,
    ].join("\n"),
    decision: "How should this repeated failure be resolved?",
    options: [
      "Provide guidance that changes the approach, then re-enable the run",
      "Re-scope the issue so the repeated failure is no longer in scope",
      "Close the issue",
    ],
    stakes:
      "The autonomous path has converged on a recovery that does not work. Without a change of approach the run " +
      "will keep reaching the same dead end, consuming budget for nothing.",
    recommendation:
      "Give the run a materially different approach to try, rather than re-authorising the same one.",
  };
}

/**
 * Rebuild a pending request from GitHub when the event stream has none — the cold-store
 * path. GitHub is the source of truth for desired state and the `ralph-master-request`
 * comment carries the whole payload, so a lost store re-derives the queue rather than
 * dropping the escalation.
 */
async function recoverRequestFromGitHub(
  github: GitHubClient,
  issueNumber: number,
): Promise<MasterRequestPayload | null> {
  const comments = await github.listIssueComments(issueNumber);
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const payload = parseMasterRequestComment(comments[i]!.body);
    if (payload) {
      return payload;
    }
  }
  return null;
}

/** Lift a folded pending request to the full durable payload, recovering evidence if needed. */
async function resolveRequestPayload(
  github: GitHubClient,
  issueNumber: number,
  pending: PendingMasterRequest | null,
  branch: string,
  runId: number,
): Promise<MasterRequestPayload | null> {
  const recovered = await recoverRequestFromGitHub(github, issueNumber);
  if (recovered) {
    return recovered;
  }
  if (!pending) {
    return null;
  }
  // The fact exists but its comment is gone (deleted by a human, or a partial write): fall
  // back to the fact's own fields rather than dropping the escalation.
  return {
    source: pending.source,
    lane: pending.lane,
    phase: pending.phase,
    issueNumber,
    runId,
    branch,
    signature: pending.signature,
    evidence: {
      headline: pending.headline,
      recommendation: pending.recommendation ?? "(the worker's recommendation was not recoverable)",
      detail: pending.headline,
    },
  };
}

export class MasterEngine {
  private readonly now: () => Date;

  constructor(private readonly deps: MasterEngineDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Adjudicate one queued master escalation for `run`. Idempotent per pending request: a
   * second call with no pending request and no open attempt is a `no-request` no-op, so a
   * double tick can never launch two sessions for one escalation.
   */
  async runIntervention(
    run: Run,
    issue: Issue,
    options: { answer?: MasterHumanAnswer } = {},
  ): Promise<MasterInterventionResult> {
    const { store, github, logger } = this.deps;
    const issueNumber = run.issueNumber;
    const history = foldMasterHistory(store.readIssueStream(issueNumber));
    // A human answer re-opens the CHECKPOINTED master (ADR-0041): the same numbered attempt
    // continues with the answer injected, spending no fresh budget. Answering the second
    // intervention's question would otherwise land straight on the two-per-phase ceiling and
    // throw the operator's answer away.
    const resumedAttempt =
      options.answer && history.awaitingHuman
        ? history.interventions.find(
            (i) => i.attempt === history.awaitingHuman!.attempt && i.phase === history.awaitingHuman!.phase,
          ) ?? null
        : null;
    const open = resumedAttempt ?? history.inProgress;

    if (!history.pending && !open) {
      return { kind: "no-request" };
    }

    const branch = run.branch ?? `ralph/${issueNumber}`;
    const request = await resolveRequestPayload(github, issueNumber, history.pending, branch, run.id);
    if (!request) {
      logger.warn("master.request-unrecoverable", { issue: issueNumber });
      return { kind: "no-request" };
    }

    // A crash between `MasterInterventionStarted` and its outcome re-adopts THAT attempt.
    const phase = open?.phase ?? request.phase;
    const signature = open?.signature ?? request.signature;
    // Re-adopting an open attempt spends no fresh budget but inherits every constraint a fresh
    // attempt at that number would carry — including a repeated signature the crash interrupted
    // (see `readoptedAttemptBudget`). A human-resumed attempt additionally may not ask again.
    const budget: MasterBudgetVerdict = open
      ? readoptedAttemptBudget(history, open, resumedAttempt !== null)
      : evaluateMasterBudget({ history, phase, signature });

    if (!budget.allowed) {
      await this.terminalizeBudgetExhausted(run, issueNumber, phase, budget.spent, history);
      return { kind: "budget-exhausted", spent: budget.spent };
    }

    // Route or refuse — BEFORE any budget is spent, so a misconfigured deployment never
    // silently burns the two interventions the issue gets.
    const routed = this.resolveRoute();
    if (routed.kind === "unconfigured") {
      await this.surfaceRouteDefect(run, issueNumber, routed.detail);
      return { kind: "unconfigured", detail: routed.detail };
    }
    if (routed.kind === "wait") {
      logger.info("master.no-provider", { issue: issueNumber });
      return { kind: "deferred", reason: "no-provider" };
    }
    const route: ContainerRoute = routed.route;

    const context = await assembleMasterContext(
      { github, ...(this.deps.context ?? {}) },
      {
        repo: this.deps.targetRepo,
        issueNumber,
        runId: run.id,
        phase,
        attempt: budget.attempt,
        branch,
        base: this.deps.baseBranch,
        worktreePath: run.worktreePath,
        prNumber: run.prNumber,
        request,
        priorInterventions: history.interventions,
        budget,
        answer: options.answer ?? null,
      },
    );

    // Consume the pending request and open the attempt span BEFORE the session, so a restart
    // mid-session re-adopts this attempt rather than dispatching a duplicate. A human-answer
    // resumption re-appends the SAME (phase, attempt), which the fold folds as a re-open
    // rather than a second intervention.
    if (!open || resumedAttempt) {
      await store.recordMasterInterventionStarted({
        issueNumber,
        runId: run.id,
        attempt: budget.attempt,
        phase,
        signature,
      });
    }
    await recordDispatchedRoute({
      store,
      runId: run.id,
      issueNumber,
      phase: MASTER_PHASE_LABEL,
      route,
      logger,
    });
    store.appendLog({
      runId: run.id,
      issueNumber,
      level: "info",
      event: "master-intervention-started",
      data: { attempt: budget.attempt, phase, signature, provider: route.provider, model: route.model },
    });

    const session = await this.deps.agent.run({
      context,
      prompt: buildMasterPrompt(context),
      systemAppend: MASTER_SYSTEM_APPEND,
      route,
      branch,
      worktreePath: run.worktreePath,
      runId: run.id,
      issue,
      logger,
    });

    if (session.kind === "limited") {
      // Defer, not fault: leave the attempt open so the next tick re-adopts it on a rotated
      // account. No budget is lost to a usage window.
      logger.warn("master.usage-limited", { issue: issueNumber, attempt: budget.attempt });
      return { kind: "deferred", reason: "usage-limited", ...(session.detail ? { detail: session.detail } : {}) };
    }
    if (session.kind === "failed") {
      logger.error("master.session-failed", { issue: issueNumber, attempt: budget.attempt, detail: session.detail });
      return { kind: "deferred", reason: "session-failed", detail: session.detail };
    }

    return this.applyOutcome(run, issue, context, budget.attempt, phase, session.result);
  }

  /**
   * The master route's current status, exposed so the completeness pass can tell a queued
   * escalation the daemon is *working on* apart from one it can never dispatch. A missing /
   * non-tools-capable tier 1 is a configuration defect no tick fixes, so it must surface as a
   * `daemon-anomaly` rather than reading as in-flight forever.
   */
  routeStatus(): MasterRouteResolution {
    return this.resolveRoute();
  }

  /** Resolve the master route (fail-closed) or report that routing is not wired at all. */
  private resolveRoute(): MasterRouteResolution {
    const { routing, routeWorld } = this.deps;
    if (!routing || !routeWorld) {
      return {
        kind: "unconfigured",
        defect: "missing-tier-1-profile",
        detail: describeMasterRouteDefect("missing-tier-1-profile"),
      };
    }
    return resolveMasterRoute(routing(), this.deps.targetRepo, routeWorld);
  }

  /**
   * Apply the master's chosen outcome. The budget re-check happens here, on the *answer*, so
   * the rule holds against a master that ignored its instructions.
   */
  private async applyOutcome(
    run: Run,
    issue: Issue,
    context: MasterContext,
    attempt: number,
    phase: string,
    result: MasterSessionResult,
  ): Promise<MasterInterventionResult> {
    const { store, logger } = this.deps;
    const issueNumber = run.issueNumber;
    let outcome = result.outcome;

    if (!resolutionAllowed(context.budget, outcome.resolution)) {
      logger.warn("master.forbidden-repeat", { issue: issueNumber, attempt, resolution: outcome.resolution });
      outcome = {
        resolution: "ask-human",
        conclusion: outcome.conclusion,
        rationale:
          `The harness refused \`${outcome.resolution}\`: it is a recovery already spent on this exact ` +
          "normalized failure signature. Escalating to a human instead of repeating it.",
        question: forbiddenRepeatQuestion(phase, outcome.resolution, outcome.conclusion),
      };
    }

    // Publish decisions BEFORE recording the resolution: a decision that turns out to
    // contradict standing authority converts the whole outcome to `ask-human`, and the
    // recorded resolution must be the one actually executed.
    const published = await this.publishDecisions(run, context, result.decisions);
    if (published.contradiction) {
      outcome = {
        resolution: "ask-human",
        conclusion: outcome.conclusion,
        rationale:
          `The master's decision on \`${published.contradiction.key}\` would contradict a binding decision ` +
          "already active on this issue's ancestor path. Superseding standing design authority is a human call.",
        question: published.contradiction.question,
      };
    }

    await store.recordMasterInterventionResolved({
      issueNumber,
      runId: run.id,
      attempt,
      phase,
      resolution: outcome.resolution,
      rationale: outcome.rationale,
    });
    store.appendLog({
      runId: run.id,
      issueNumber,
      level: "info",
      event: "master-resolution",
      data: { attempt, phase, resolution: outcome.resolution, conclusion: outcome.conclusion },
    });

    await this.executeResolution(run, issue, attempt, phase, outcome);
    logger.info("master.resolved", { issue: issueNumber, attempt, resolution: outcome.resolution });
    return { kind: "resolved", attempt, resolution: outcome.resolution };
  }

  /** Carry out the chosen resolution. Exhaustive by construction — five arms, no default. */
  private async executeResolution(
    run: Run,
    issue: Issue,
    attempt: number,
    phase: string,
    outcome: MasterOutcome,
  ): Promise<void> {
    switch (outcome.resolution) {
      case "resolved-and-continue":
        // Leave `master-triage` *before* handing back, so the transition is atomic with the
        // decision: if the continuation then fails, the run is a plain `running` orphan the
        // sweep re-drives, never a queued escalation that re-dispatches a second master.
        await this.leaveQueue(run);
        await this.deps.pipeline.continueRun({
          run,
          issue,
          resolution: "resolved-and-continue",
          brief: outcome.guidance,
          conclusion: outcome.conclusion,
        });
        return;
      case "redispatch-tier-1":
        await this.leaveQueue(run);
        await this.deps.pipeline.continueRun({
          run,
          issue,
          resolution: "redispatch-tier-1",
          brief: outcome.brief,
          conclusion: outcome.conclusion,
        });
        return;
      case "retry-pipeline":
        await this.leaveQueue(run);
        await this.deps.pipeline.retry({
          run,
          issue,
          action: outcome.action,
          brief: `${outcome.conclusion}\n\n${outcome.rationale}`,
        });
        return;
      case "ask-human":
        await this.askHuman(run, attempt, phase, outcome.question);
        return;
      case "terminal-stuck":
        await this.terminalStuck(run, attempt, outcome.reason, outcome.conclusion);
        return;
    }
  }

  /**
   * Take the run off the master queue for an autonomous resolution: `Resumed` projects it back
   * to `running`, which is what makes the ordinary pipeline own it again. The two final-
   * adjudication arms deliberately do NOT call this — they project their own terminal
   * (`awaiting-answer` / `agent-stuck`).
   */
  private async leaveQueue(run: Run): Promise<void> {
    await this.deps.store.recordResumed({ runId: run.id, issueNumber: run.issueNumber });
  }

  /**
   * The **only** path in this slice that creates a `ralph-question`. Posts the structured
   * comment, indexes the open question with master provenance, and checkpoints the master's
   * own resume context — so an answer resumes the MASTER, not the original worker.
   */
  private async askHuman(run: Run, attempt: number, phase: string, question: EscalationQuestion): Promise<void> {
    const { store, github } = this.deps;
    const { id } = await github.postComment(run.issueNumber, formatRalphQuestion(question));
    await store.recordMasterHumanQuestion({
      issueNumber: run.issueNumber,
      runId: run.id,
      attempt,
      phase,
      headline: question.headline,
      commentId: id,
    });
    // No `phase` key on the payload: phase-presence is the review-loop resume axis (#9), and a
    // master resume is neither an impl nor a review-loop resume — it re-enters master
    // adjudication, which the `master-triage` request the answer re-arms will drive.
    store.setResumeContext(run.id, { question, commentId: id }, run.branch);
    store.appendLog({
      runId: run.id,
      issueNumber: run.issueNumber,
      level: "info",
      event: "master-ask-human",
      data: { attempt, phase, headline: question.headline, commentId: id },
    });
  }

  /** The master's terminal: a self-explaining card plus `MasterStuck` (→ `agent-stuck`). */
  private async terminalStuck(run: Run, attempt: number, reason: string, conclusion: string): Promise<void> {
    const { store, github } = this.deps;
    await github.postComment(
      run.issueNumber,
      formatRalphQuestion({
        headline: "Master concluded this run cannot be completed",
        feature: "Master escalation (ADR-0041)",
        whereWeStand: [
          "A fresh highest-tier master session investigated this run independently and concluded that neither",
          "another autonomous action nor a human decision would resolve it.",
          "",
          "Master's conclusion:",
          conclusion,
          "",
          "Why it is terminal:",
          reason,
        ].join("\n"),
        decision: "How should this issue be disposed of?",
        options: [
          "Re-scope the issue (edit it and re-label `ready-for-agent`)",
          "Provide guidance and re-enable the run (heal)",
          "Close the issue",
        ],
        stakes:
          "No pull request will merge from this run. The issue is parked on `agent-stuck`, and the daemon will " +
          "not pick it up again on its own.",
        recommendation:
          "Read the master's conclusion. If it names a missing prerequisite, resolve that first; otherwise " +
          "re-scope or close.",
      }),
    );
    await store.recordMasterStuck({ issueNumber: run.issueNumber, runId: run.id, attempt, reason });
    store.appendLog({
      runId: run.id,
      issueNumber: run.issueNumber,
      level: "warn",
      event: "master-stuck",
      data: { attempt, reason },
    });
  }

  /** The harness terminal when a third intervention cannot launch. */
  private async terminalizeBudgetExhausted(
    run: Run,
    issueNumber: number,
    phase: string,
    spent: number,
    history: MasterHistory,
  ): Promise<void> {
    const { store, github, logger } = this.deps;
    const prior = history.interventions
      .filter((i) => i.phase === phase)
      .map((i) => `attempt ${i.attempt}: \`${i.resolution ?? "(undecided)"}\`${i.rationale ? ` — ${i.rationale}` : ""}`);
    await github.postComment(
      issueNumber,
      formatRalphQuestion(budgetExhaustedQuestion(phase, spent, prior)),
    );
    await store.recordMasterStuck({
      issueNumber,
      runId: run.id,
      attempt: spent,
      reason: `master intervention budget exhausted in phase ${phase} (${spent} of ${spent})`,
    });
    logger.warn("master.budget-exhausted", { issue: issueNumber, phase, spent });
    store.appendLog({
      runId: run.id,
      issueNumber,
      level: "warn",
      event: "master-budget-exhausted",
      data: { phase, spent },
    });
  }

  /**
   * Surface a tier-1 configuration defect as an actionable attention state. Deliberately a
   * `daemon-anomaly` (the daemon cannot act) rather than `agent-stuck` (the agent gave up):
   * no agent ever ran, and the fix is in `config.yaml`, not in the issue.
   */
  private async surfaceRouteDefect(run: Run, issueNumber: number, detail: string): Promise<void> {
    const { store, logger } = this.deps;
    logger.error("master.route-unconfigured", { issue: issueNumber, detail });
    await store.recordAnomalyDetected({ issueNumber, reason: `master-route-unconfigured: ${detail}` });
    store.appendLog({
      runId: run.id,
      issueNumber,
      level: "error",
      event: "master-route-unconfigured",
      data: { detail },
    });
  }

  /**
   * Append the master's scoped decisions through the ADR-0040 ledger. A draft whose key is
   * already claimed by an active record — or which names an explicit `supersedes` — is a
   * *contradiction*: it is not written, and the whole outcome converts to `ask-human`.
   */
  private async publishDecisions(
    run: Run,
    context: MasterContext,
    drafts: MasterDecisionDraft[],
  ): Promise<{ contradiction?: { key: string; question: EscalationQuestion } }> {
    const { store, github, logger } = this.deps;
    if (drafts.length === 0) {
      return {};
    }
    const map = context.hierarchy ?? (await buildHierarchyMap(github, context.ref));
    let published = false;

    for (const draft of drafts) {
      const contradicts = draft.supersedes !== undefined || hasActiveDecisionFor(context, draft.key);
      if (contradicts) {
        return {
          contradiction: {
            key: draft.key,
            question: {
              headline: `Master wants to change the binding decision \`${draft.key}\``,
              feature: "Decision ledger (ADR-0040/0041)",
              whereWeStand: [
                `A binding decision for \`${draft.key}\` is already active on this issue's ancestor path.`,
                "The master concluded the work needs a different call:",
                "",
                draft.decision,
                "",
                "Its rationale:",
                draft.rationale,
              ].join("\n"),
              decision: `Should the standing decision on \`${draft.key}\` be superseded?`,
              options: [
                "Approve the change — the master will supersede the standing decision and continue",
                "Keep the standing decision — the master will find a way to honour it",
                "Re-scope the issue so the conflict does not arise",
              ],
              stakes:
                "Superseding standing design authority changes what every future session on this subtree is " +
                "bound by. That is a one-way door no agent may open on its own.",
              recommendation:
                "Read the master's rationale against the standing decision's. If the original constraint no " +
                "longer holds, approve; otherwise keep it and let the master work within it.",
            },
          },
        };
      }

      // Deterministic id: the same intervention re-publishing the same key produces a
      // byte-identical record, which the ADR-0040 fold collapses — so a restart cannot
      // plant a duplicate decision comment.
      const decisionId = `master-${context.ref.repo}#${context.ref.number}-r${run.id}-a${context.attempt}-${draft.key}`;
      if (context.priorInterventions.length >= 0 && this.alreadyPublished(context, decisionId)) {
        continue;
      }
      const record: DecisionRecord = {
        id: decisionId,
        key: draft.key,
        scope: draft.scope,
        storageNode: this.storageNodeFor(context.ref, draft),
        decision: draft.decision,
        rationale: draft.rationale,
        constraints: draft.constraints,
        rejectedAlternatives: draft.rejectedAlternatives,
        affectedNodes: [context.ref],
        affectedPaths: [],
        evidence: draft.evidence,
        origin: {
          repo: context.ref.repo,
          issue: context.ref.number,
          runId: run.id,
          phase: context.phase,
          headSha: context.workspace?.headSha ?? "unknown",
        },
        authoredBy: { model: "master" },
        recordedAt: this.now().toISOString(),
      };
      const appended = await appendDecision(github, {
        map,
        ...(draft.subtreeRoot ? { subtreeRoot: draft.subtreeRoot } : {}),
        record,
      });
      if (appended.kind === "rejected") {
        logger.warn("master.decision-rejected", {
          issue: context.ref.number,
          key: draft.key,
          reason: appended.reason,
          detail: appended.detail,
        });
        continue;
      }
      await store.recordDecisionPublished({
        issueNumber: run.issueNumber,
        runId: run.id,
        decisionId,
        key: draft.key,
        scope: draft.scope,
        node: `${appended.node.repo}#${appended.node.number}`,
        commentId: appended.commentId,
      });
      logger.info("master.decision-published", { issue: context.ref.number, key: draft.key, id: decisionId });
      published = true;
    }
    if (published) {
      // Regenerate the derived `ralph-decision-index` on the absolute root (ADR-0040): a view,
      // not authority — byte-identical on an unchanged ledger (so a replay writes nothing) and
      // edited in place, so a restart can never plant a second one. Best-effort: a failed index
      // sync must never invalidate a decision that is already canonical on its own comment.
      try {
        const fold = await readDecisionLedger(github, map);
        const synced = await syncDecisionIndex(github, map, fold);
        logger.info("master.decision-index", { issue: context.ref.number, ...synced });
      } catch (err) {
        logger.warn("master.decision-index-failed", { issue: context.ref.number, error: String(err) });
      }
    }
    return {};
  }

  /** Whether this exact decision id was already published (restart-replay dedupe). */
  private alreadyPublished(context: MasterContext, decisionId: string): boolean {
    return foldMasterHistory(this.deps.store.readIssueStream(context.ref.number)).publishedDecisionIds.includes(
      decisionId,
    );
  }

  /** Where a draft's record lands. `subtree` names its root; everything else keys on the origin. */
  private storageNodeFor(origin: IssueRef, draft: MasterDecisionDraft): IssueRef {
    return draft.scope === "subtree" && draft.subtreeRoot
      ? { repo: draft.subtreeRoot.repo, number: draft.subtreeRoot.number }
      : origin;
  }
}
