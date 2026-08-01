/**
 * The **executor-backed master pipeline port** (ADR-0041): how a resolved master hands its run
 * back to the ordinary pipeline.
 *
 * Every arm here maps onto an entry point the daemon already owns. That is a constraint, not a
 * convenience: the master's whole safety story is that repaired work re-enters the *normal*
 * CI/review/merge path (ADR-0014 keeps the merge harness-owned). A port that could reach past
 * those entry points would be a second, unreviewed pipeline — which is exactly what "no CI
 * bypass, no direct merge" forbids. So:
 *
 *   - **continue / redispatch** → {@link Executor.resume}: resume-not-restart on the preserved
 *     WIP branch, with the master's brief injected exactly where an operator's answer goes. The
 *     two arms differ in what the brief *says*, not in what the harness does — a fresh tier-1
 *     worker on a preserved branch and a repaired branch handed back are the same mechanism, and
 *     pretending otherwise would mean two code paths to keep in step.
 *   - **retry `ci` / `review`** → {@link Executor.recoverReview}: re-run the phase, gate and all.
 *     Re-running a gate is the opposite of bypassing it.
 *   - **retry `merge`** → {@link Executor.integrate}: the single-concurrency, CI-gated,
 *     rebase-aware merge (ADR-0017/0014). The master asks for it; the harness still decides.
 *   - **retry `reconcile`** → nothing. The engine already returned the run to `running`, so the
 *     next tick's orphan pass re-derives it from GitHub. "Do it again from what is actually
 *     there" is a real answer, and it is the one that needs no new code.
 */

import type { Executor } from "../executor/executor";
import type { GitHubClient } from "../github/types";
import type { Logger } from "../log/logger";
import type { MasterResolution } from "../store/types";
import type { RalphAnswer } from "../hitl/answer";
import type { ResumePayload } from "../store/types";
import type { EscalationQuestion } from "../review/escalation";
import type { MasterPipelinePort } from "./engine";
import { parseReviewPhaseKey } from "./harness-escalation";

export interface ExecutorMasterPipelineDeps {
  executor: Executor;
  github: GitHubClient;
  logger: Logger;
}

/**
 * Render the master's brief as the {@link EscalationQuestion} the resume path injects. The resume
 * machinery is built around a question+answer pair, and a master's brief IS an answer — an
 * authoritative one — so it rides the same channel rather than growing a parallel one. The
 * question half states who decided and why, so the resumed worker can see that it is being told,
 * not asked.
 */
export function masterBriefQuestion(input: {
  resolution: MasterResolution;
  conclusion: string;
}): EscalationQuestion {
  const redispatch = input.resolution === "redispatch-tier-1";
  return {
    headline: redispatch
      ? "A master escalation re-dispatched this work with a brief"
      : "A master escalation resolved this run and handed it back",
    feature: "Master escalation (ADR-0041)",
    whereWeStand: [
      "A fresh highest-tier master session investigated this run independently and reached its own",
      "conclusion. Its conclusion is authoritative for this run — treat the guidance below as a",
      "decision already made, not as a suggestion to weigh.",
      "",
      "Master's conclusion:",
      input.conclusion,
    ].join("\n"),
    decision: redispatch
      ? "Implement the issue on the preserved WIP branch, following the master's brief."
      : "Continue the interrupted work, following the master's guidance.",
    stakes:
      "This run already consumed one of its two master interventions. Diverging from the brief " +
      "spends the remaining one on the same ground.",
    recommendation: "Follow the brief. If it turns out to be wrong, escalate rather than improvising.",
  };
}

/** Build the executor-backed {@link MasterPipelinePort}. */
export function createExecutorMasterPipeline(deps: ExecutorMasterPipelineDeps): MasterPipelinePort {
  return {
    async continueRun({ run, issue, resolution, brief, conclusion, phase }): Promise<void> {
      const question = masterBriefQuestion({ resolution, conclusion });
      const answer: RalphAnswer = { kind: "free-text", text: brief };
      // `phase`-presence is the resume dispatch axis (#9): a `review-N` request re-enters the
      // review loop at exactly that phase with the brief injected as fix guidance, while an
      // `impl`/`resume` request drives the implementation session. Carrying it is what makes
      // "repair and resume the EXACT phase" (ADR-0042) true rather than aspirational — without
      // it a maxed-out phase-2 review would restart the implementation and discard the review tail.
      const reviewPhase = parseReviewPhaseKey(phase);
      const context: ResumePayload = { question, ...(reviewPhase !== null ? { phase: reviewPhase } : {}) };
      deps.logger.info("master.continue", { issue: issue.number, resolution, phase });
      await deps.executor.resume({ issue, mode: run.mode, run, answer, context });
    },

    async retry({ run, issue, action, brief }): Promise<void> {
      deps.logger.info("master.retry-pipeline", { issue: issue.number, action });
      if (action === "reconcile") {
        // Nothing to drive: the run is back to `running`, so the next tick's orphan pass
        // re-derives it from GitHub — the daemon's own "look again" primitive.
        return;
      }
      const pr = run.branch ? await deps.github.findPullRequestForBranch(run.branch) : null;
      if (!pr || pr.state !== "OPEN") {
        // No PR to re-gate. Leaving the run `running` hands it to the orphan pass, which
        // terminalizes or re-drives it — never a silent drop.
        deps.logger.warn("master.retry-no-pr", { issue: issue.number, action, brief: brief.slice(0, 120) });
        return;
      }
      if (action === "merge") {
        await deps.executor.integrate(run, issue, pr);
        return;
      }
      // `ci` and `review` both re-enter the review loop at its start — which begins with the
      // CI gate. Re-running the gate is not bypassing it.
      await deps.executor.recoverReview(run, issue, pr);
    },
  };
}
