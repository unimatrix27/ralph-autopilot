/**
 * `ContainerAgentRunner` — the daemon-side adapter that makes a container run a drop-in
 * {@link AgentRunner} (ADR-0038 / issue #185, AC5; the "Option X" routing). The composition root
 * injects this as the executor's `agentRunner` for **every** target (the in-process path is
 * retired, #227); everything downstream of the session — PR-read-back, escalate/stuck handling,
 * the review loop — is the executor's existing code path, **byte-for-byte unchanged**. The agent
 * inside the container commits/pushes/opens its PR itself (prompt-driven), so the run's work
 * product lands on GitHub independent of the pipe; the daemon reads it back through its normal
 * reconcile.
 *
 * Per `run`: build the impl {@link Assignment} (prompt + branch + base) and a per-run token,
 * dispatch through {@link ContainerExecution}, fold the streamed telemetry into the run's
 * transcript store (daemon = sole writer, ADR-0030), and map the terminal {@link ResultFrame}
 * to an {@link AgentRunResult}. On `escalated` (#187) the runner already posted the comment +
 * pushed WIP runner-direct, so this only indexes the open question (the `awaiting-answer` label
 * swaps next tick); on `stuck` it relays the self-stop report. On a **resume** (#188) the prompt
 * is the resume prompt and the operator's answer rides on the assignment so the container clones
 * the WIP branch (not base) — resume-not-restart, no SDK-session rehydration.
 */
import type { Assignment, ContainerDispatch, RunToken } from "./assignment";
import { ContainerExecution, type DockerRunner } from "./container-execution";
import type { ResultFrame } from "./protocol";
import { createTelemetrySink, type TranscriptRunRecorder } from "./record-telemetry";
import { foldRateLimitTelemetry, type RecordRateLimitSignal } from "./record-rate-limit";
import type { AgentRunContext, AgentRunResult, AgentRunner } from "../executor/agent";
import type { StuckReport } from "../executor/stuck-tool";
import { buildImplPrompt, buildResumePrompt } from "../executor/prompts";
import { readTier } from "../core/labels";
import { resolveDispatchRoute, type RouteWorld, type RoutingSource } from "../providers/resolve";
import { tierProfile } from "../providers/select";
import { phaseLabel } from "../review/phase";
import { recordDispatchedRoute, type RouteRecordingStore } from "./route-recording";
import type { TargetConfig } from "../config/schema";
import type { OpenQuestion, OpenQuestionInput } from "../store/types";

/**
 * The narrow store port the adapter needs to record a runner-direct escalation (#187): index the
 * already-posted question so the daemon swaps `ready-for-agent → awaiting-answer` next tick off
 * the projected run status. {@link import("../store/store").ScopedStore} satisfies it structurally
 * (alongside {@link TranscriptRunRecorder}); faked in tests by the real store on a memory DB.
 */
export interface ContainerRunStore extends TranscriptRunRecorder, RouteRecordingStore {
  /** Append the `Escalated` fact for the (already-posted) question; returns the indexed row. */
  addQuestion(input: Omit<OpenQuestionInput, "repo">): Promise<OpenQuestion>;
}

/** Construction deps for {@link ContainerAgentRunner} (all known at the composition root). */
export interface ContainerAgentRunnerDeps {
  /** The `docker run` port — faked in tests, shells `docker` in production. */
  docker: DockerRunner;
  /** The run/transcript store the daemon (sole writer) folds container telemetry into. */
  store: ContainerRunStore;
  /** The resolved target config — supplies the impl prompt's mode instructions + repo. */
  config: TargetConfig;
  /** The branch the eventual PR targets (the same base the worktree manager + review loop use). */
  baseBranch: string;
  /**
   * The live routing source + the daemon-wide headroom port the impl route is resolved through
   * (ADR-0037 / issue #220), consumed by the shared {@link resolveDispatchRoute} per run. Both
   * present → every run resolves a fresh `{ provider, model, account }` (a `{ wait: "no-provider" }`
   * defers the run via `limited`); either absent (a routing-agnostic setup / tests) → no route is
   * resolved and the box-default creds mount. See {@link resolveDispatchRoute} for the shared shape.
   */
  routing?: RoutingSource;
  routeWorld?: RouteWorld;
  /**
   * Fold a container-reported per-account rate-limit signal back into the daemon's usage meter over
   * the best-effort pipe (ADR-0037/0038, issue #228): the in-container session sees the 429 first and
   * relays it, and this keeps the dispatched account's headroom — what the *next* `resolveRoute`
   * reads — current. Best-effort: absent (tests / a routing-agnostic setup) or a dropped frame just
   * leaves the meter staler, never a lost run.
   */
  recordRateLimit?: RecordRateLimitSignal;
  /**
   * Mints the per-run token pushed into the container at dispatch. Opaque in this slice (it
   * proves the dispatch path carries it); a later slice scopes the runner's access with it.
   */
  makeToken?: (assignment: Assignment) => RunToken;
  /**
   * The daemon's graceful-drain signal (issue #35). Threaded only through the impl/resume runner —
   * the *start* of build work — so a drain refuses fresh container dispatch while in-flight runs
   * (whose review/fix containers run through separate adapters) complete. Absent → no drain gate
   * (e.g. tests).
   */
  drainSignal?: AbortSignal;
}

/** A placeholder per-run token — opaque until a later slice scopes the runner's GitHub/LLM access. */
function defaultToken(assignment: Assignment): RunToken {
  return { value: `ralph-run-${assignment.issueNumber}-${assignment.branch}` };
}

export class ContainerAgentRunner implements AgentRunner {
  constructor(private readonly deps: ContainerAgentRunnerDeps) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const { issue, mode, branch } = ctx;
    // The issue's complexity tier (issue #278), read from the LIVE labels at dispatch — the
    // per-tier agent profile's selector. `null` (unlabeled) = the global profile, never a stall.
    const tier = readTier(issue.labels);
    // Resolve the route pre-dispatch (ADR-0037 / issue #220): one account + one model for the
    // container's whole life (no mid-run rotation, no pool inside the container — ADR-0038). Read
    // the LIVE routing per run so a runtime overlay takes effect on the next dispatch. The tier
    // threads the per-tier impl routing key: a configured `agent.tiers[tier].routes` replaces the
    // impl preference list whole (#278).
    const route = resolveDispatchRoute(this.deps, "impl", undefined, tier);
    if (route && "wait" in route) {
      // no-provider: every capability-allowed pool is gated/exhausted (the capability gate inside
      // resolveRoute also lands here — a capability-invalid (impl, provider) is never dispatched).
      // Do NOT dispatch: return `limited` so the executor defers (restores `ready-for-agent`, drops
      // the run), and admission re-resolves next tick (#163) — never an error, never agent-stuck.
      ctx.logger.warn("container.no-provider", { issue: issue.number, type: "impl" });
      return { ok: false, escalated: false, stuck: null, limited: true };
    }

    // Resume-not-restart in a container (#188): on a resume the prompt is the resume prompt
    // (continue the WIP branch with the operator's Q&A injected, DESIGN §6) and the answer
    // rides on the assignment — the in-container cloner reads its presence to clone the WIP
    // branch (where the prior work is committed) instead of base. No SDK-session rehydration:
    // a fresh container hosts a fresh session, same as a first run (ADR-0008 / ADR-0038).
    const prompt = ctx.resume
      ? buildResumePrompt(issue, mode, branch, this.deps.config, ctx.resume)
      : buildImplPrompt(issue, mode, branch, this.deps.config, ctx.stuckHeal);
    // The tier's session-budget deltas (issue #278), resolved DAEMON-side from the same live
    // routing the route came from (falling back to the loaded config when routing is unwired)
    // so the runner applies, never re-derives. Only set fields ride the dispatch — an empty
    // profile is omitted, keeping the payload byte-identical for untiered issues.
    const profile = tierProfile(this.deps.routing?.().agent ?? this.deps.config.agent, tier);
    const sessionProfile =
      profile && (profile.effort !== undefined || profile.wallClockSeconds !== undefined)
        ? {
            ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
            ...(profile.wallClockSeconds !== undefined ? { wallClockSeconds: profile.wallClockSeconds } : {}),
          }
        : undefined;
    const assignment: Assignment = {
      issueNumber: issue.number,
      mode,
      branch,
      base: this.deps.baseBranch,
      prompt,
      ...(ctx.resume ? { answer: ctx.resume.answer.text } : {}),
      ...(sessionProfile ? { profile: sessionProfile } : {}),
    };
    const dispatch: ContainerDispatch = {
      assignment,
      token: (this.deps.makeToken ?? defaultToken)(assignment),
      // The resolved route makes dispatch self-contained: the docker runner mounts the selected
      // account + injects provider/model from it, and #164 records it (ADR-0037).
      ...(route ? { route } : {}),
    };

    // Record the impl phase's route at dispatch (ADR-0037 P3.1, issue #164): the daemon already
    // knows what it resolved, so it folds the route onto the read-model with no telemetry pipe.
    // Best-effort — a route-less (box-default) dispatch records nothing; recording never gates run.
    await recordDispatchedRoute({
      store: this.deps.store,
      runId: ctx.runId,
      issueNumber: issue.number,
      phase: phaseLabel({ kind: "impl" }),
      route: route ?? null,
      logger: ctx.logger,
    });

    // Telemetry → store, keyed by the run's correlation tag. The sink serialises appends so
    // the back-to-back lifecycle + transcript frames never race on stream creation.
    const sink =
      ctx.runId != null
        ? createTelemetrySink(this.deps.store, { issueNumber: issue.number, runId: String(ctx.runId) })
        : null;
    const execution = new ContainerExecution({
      docker: this.deps.docker,
      // A `rate-limit` body folds into the dispatched account's meter (#228); everything else is a
      // transcript/lifecycle frame for the run's transcript store. Both best-effort (ADR-0030/0038).
      onTelemetry: (frame, dispatch) => {
        if (!foldRateLimitTelemetry(frame, dispatch, this.deps.recordRateLimit)) {
          sink?.record(frame);
        }
      },
    });

    const result = await execution.dispatch(dispatch, {
      abortSignal: ctx.abortSignal,
      drainSignal: this.deps.drainSignal,
    });
    await sink?.flush();
    return this.mapResult(result, ctx);
  }

  /**
   * Map a container's terminal {@link ResultFrame} to the {@link AgentRunResult} the executor's
   * unchanged disposition logic reads (#185, #187). Total over {@link ResultFrame.outcome}:
   *
   *   - `pr-opened` — impl success; the executor reads the PR back from GitHub (source of truth);
   *   - `escalated` — the runner already posted the `ralph-question` + pushed WIP (runner-direct).
   *     The daemon indexes that already-posted question here (no re-post) so the `awaiting-answer`
   *     label swaps next tick; the executor pauses the run. If the relayed payload is missing (a
   *     dropped frame), the escalation is still on GitHub — the completeness pass reconciles it;
   *   - `stuck` — the agent self-stopped; relay the report so the executor labels `agent-stuck`;
   *   - `failed` — a non-success terminal with no work product.
   */
  private async mapResult(result: ResultFrame, ctx: AgentRunContext): Promise<AgentRunResult> {
    switch (result.outcome) {
      case "pr-opened":
        return { ok: true, escalated: false, stuck: null };
      case "escalated":
        await this.recordEscalation(result, ctx);
        return { ok: false, escalated: true, stuck: null };
      case "stuck": {
        if (!result.stuck) {
          // A `stuck` terminal with no relayed payload is a dropped/malformed frame: log it so the
          // synthesised `futility` self-stop below is observable, not silently reported to the
          // operator as a real `futility` (mirrors `recordEscalation`'s `escalation-unrecorded`).
          ctx.logger.warn("container.stuck-unrecorded", { issue: ctx.issue.number, detail: result.detail });
        }
        const stuck: StuckReport = result.stuck
          ? { category: result.stuck.category, reason: result.stuck.reason }
          : { category: "futility", reason: result.detail ?? "agent self-stopped" };
        return { ok: false, escalated: false, stuck };
      }
      case "failed":
        return { ok: false, escalated: false, stuck: null };
      case "reviewed":
      case "fixed":
      case "fix-escalate":
        // Review/fix terminals (#189) belong to the review-loop's container adapters, never an
        // impl dispatch. If one ever arrives here it is a misrouted frame — treat it as a failed
        // run (no PR work product) rather than silently reporting success.
        ctx.logger.warn("container.unexpected-review-fix-terminal", {
          issue: ctx.issue.number,
          outcome: result.outcome,
        });
        return { ok: false, escalated: false, stuck: null };
    }
  }

  /**
   * Index a runner-direct escalation in the daemon store: append the `Escalated` fact for the
   * already-posted comment so the run projects to `awaiting-answer` and the reconciler swaps the
   * label next tick. The comment + WIP already landed on GitHub inside the container, so this is
   * pure daemon-side bookkeeping — never a re-post. Resume context is wired in the next slice (#188).
   */
  private async recordEscalation(result: ResultFrame, ctx: AgentRunContext): Promise<void> {
    if (!result.escalation || ctx.runId == null) {
      // No relayed payload (a dropped frame) or no run to key: the escalation is still on GitHub;
      // the completeness pass reconciles the label rather than this best-effort fast path.
      ctx.logger.warn("container.escalation-unrecorded", { issue: ctx.issue.number });
      return;
    }
    await this.deps.store.addQuestion({
      issueNumber: ctx.issue.number,
      runId: ctx.runId,
      kind: "escalate",
      headline: result.escalation.headline,
      commentId: result.escalation.commentId,
    });
    ctx.logger.info("container.escalated", {
      issue: ctx.issue.number,
      commentId: result.escalation.commentId,
      prNumber: result.escalation.prNumber,
    });
  }
}
