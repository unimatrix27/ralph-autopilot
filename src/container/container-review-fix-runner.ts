/**
 * The daemon-side adapters that make a container a drop-in {@link ReviewAgentRunner} /
 * {@link FixAgentRunner} (ADR-0038 / issue #189). The composition root injects these into the
 * {@link import("../review/review-loop").ReviewLoop} for a `container` target; everything the
 * review loop owns — the CI gate, the gating + phase machine, and the rebase-aware squash-merge
 * (ADR-0014) — is **byte-for-byte unchanged**. The only difference is that the review pass and
 * each fix attempt run in a fresh, isolated container instead of in-process.
 *
 * Per call the adapter:
 *
 *   - builds the **same** review/fix prompt the in-process path builds ({@link buildReviewPrompt} /
 *     {@link buildFixPrompt}) — the worklist/verdict contract is identical because the structured
 *     contract runs inside the container and the daemon reads back the parsed result;
 *   - pushes it into a container as an {@link Assignment} with `kind: "review"`/`"fix"` (so the
 *     runner clones the PR's head branch and hosts the matching session) plus a per-run token;
 *   - dispatches through {@link ContainerExecution}, relaying the container's transcript telemetry
 *     into the run's transcript sink (the daemon stays the sole store writer, ADR-0030);
 *   - maps the terminal {@link ResultFrame}: `reviewed` → the consolidated {@link Worklist};
 *     `fixed`/`fix-escalate` → the {@link FixOutcome}. Two distinct failure shapes are kept apart
 *     (issue #220): a **synthesized no-frame** terminal (`noResult` — a dropped pipe, a killed
 *     container, a `docker run` that never started) is a daemon-side **infra fault** →
 *     {@link RunnerInfraError}, which the review loop *retries* before terminalizing; a
 *     **runner-reported `failed`** frame is a genuine in-container agent failure (already retried
 *     inside the container) → {@link AgentOutputParseError} carrying the runner's real detail, which
 *     the review loop maxes out (review-maxed + an honest heal-card). Neither loses the run (ADR-0016).
 *
 * The fix's actual code change is pushed **runner-direct** from inside the container (the agent
 * pushes itself, prompt-driven), so it lands on GitHub independent of the pipe; the daemon reads
 * it back through the next CI gate / re-review exactly as for an in-process fix.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Assignment, ContainerDispatch, ContainerRoute, RunToken } from "./assignment";
import { ContainerExecution, type DispatchResult, type DockerRunner } from "./container-execution";
import type { ResultFrame, TelemetryFrame } from "./protocol";
import { foldRateLimitTelemetry, type RecordRateLimitSignal } from "./record-rate-limit";
import type { TargetConfig } from "../config/schema";
import {
  RunnerInfraError,
  type FixAgentRunner,
  type FixContext,
  type FixOutcome,
  type ReviewAgentRunner,
  type ReviewContext,
} from "../review/agents";
import { buildFixPrompt, buildReviewPrompt } from "../review/prompts";
import { fixPhase, phaseLabel, reviewPhase } from "../review/phase";
import type { Worklist } from "../review/worklist";
import { AgentOutputParseError, MAX_PARSE_RETRIES } from "../executor/structured-session";
import { resolveDispatchRoute, type RouteWorld, type RoutingSource } from "../providers/resolve";
import { recordDispatchedRoute, type RouteRecordingStore } from "./route-recording";
import type { AgentType, RoutingPhase } from "../providers/select";
import { UsageLimitError } from "../core/usage";

/** Construction deps shared by the review and fix container adapters (known at the composition root). */
export interface ContainerReviewFixDeps {
  /** The `docker run` port — faked in tests, shells `docker` in production. */
  docker: DockerRunner;
  /** The resolved target config — supplies the fix prompt's build/test commands + repo. */
  config: TargetConfig;
  /** The branch the PR targets (the same base the worktree manager + review loop use). */
  baseBranch: string;
  /**
   * The live routing source + the daemon-wide headroom port the review/fix route is resolved
   * through (ADR-0037 / issue #220), consumed by the shared {@link resolveDispatchRoute} per run.
   * Both present → the review pass and each fix attempt resolve a fresh `{ provider, model, account }`
   * (a `{ wait: "no-provider" }` is not dispatched — see {@link resolveContainerRoute}); either
   * absent (a routing-agnostic setup / tests) → no route is resolved and the box-default creds mount.
   */
  routing?: RoutingSource;
  routeWorld?: RouteWorld;
  /**
   * The store the review/fix route is recorded into at dispatch (ADR-0037 P3.1, issue #164): the
   * daemon's `ScopedStore` satisfies it structurally. Optional — a routing-agnostic setup / a unit
   * test may omit it, then no `RouteResolved` fact is appended (the run still dispatches). Recording
   * also needs the run's `runId` ({@link ReviewContext.runId} / {@link FixContext.runId}).
   */
  store?: RouteRecordingStore;
  /**
   * Fold a container-reported per-account rate-limit signal back into the daemon's usage meter over
   * the best-effort pipe (ADR-0037/0038, issue #228): a review/fix container's session sees the 429
   * first and relays it, keeping the dispatched account's headroom current for the next route
   * resolution. Best-effort: absent (tests) or a dropped frame just leaves the meter staler.
   */
  recordRateLimit?: RecordRateLimitSignal;
  /** Mints the per-run token pushed into the container at dispatch (opaque in this slice). */
  makeToken?: (assignment: Assignment) => RunToken;
}

/**
 * Resolve the route for a review/fix run via the shared {@link resolveDispatchRoute} (ADR-0037 /
 * issue #220) and fold a no-provider wait into a thrown {@link UsageLimitError}. The review loop's
 * per-phase catch leaves a `UsageLimitError` resumable (row `running`, PR open) and the orphan sweep
 * re-drives it on the next tick once a pool regains headroom — exactly the "do not dispatch,
 * re-resolve next tick" the impl `limited` defer gives. Returns `null` when routing/routeWorld are
 * unwired (the box-default credentials then mount); this throw-vs-`limited` split is the only place
 * review/fix diverges from the impl runner's reading of the same resolution.
 *
 * `phase` threads the per-phase routing key (ADR-0037 #169): the route is resolved for `(repo,
 * type, phase)`, so a Phase-2 thermo review/fix can route to a different provider/model than its
 * Phase-1 normal pass. Phase 0 (a CI-gate/merge fix) has no per-phase key and resolves to `base`.
 */
function resolveContainerRoute(
  deps: ContainerReviewFixDeps,
  type: AgentType,
  phase: RoutingPhase,
): ContainerRoute | null {
  const resolved = resolveDispatchRoute(deps, type, phase);
  if (resolved && "wait" in resolved) {
    throw new UsageLimitError(`no provider with headroom for a ${type} run (ADR-0037 no-provider)`);
  }
  return resolved;
}

/** A placeholder per-run token — opaque until a later slice scopes the runner's GitHub/LLM access. */
function defaultToken(assignment: Assignment): RunToken {
  return { value: `ralph-${assignment.kind ?? "impl"}-${assignment.issueNumber}-${assignment.branch}` };
}

/**
 * Relay a container's best-effort telemetry (ADR-0030 / issue #228): a `rate-limit` frame folds into
 * the dispatched account's usage meter (`record`), keeping headroom current for the next route
 * resolution; a `transcript` frame carries one raw SDK message, fed through the very sink the
 * in-process review/fix session uses so both execution models persist identical shapes. Lifecycle
 * frames are dropped (a container-only liveness marker; the in-process review path emits none).
 */
function relayTelemetry(
  ctx: { transcriptSink?: { capture: (m: SDKMessage) => void } },
  record: RecordRateLimitSignal | undefined,
) {
  return (frame: TelemetryFrame, dispatch: ContainerDispatch): void => {
    if (foldRateLimitTelemetry(frame, dispatch, record)) {
      return;
    }
    if (frame.body.type === "transcript") {
      ctx.transcriptSink?.capture(frame.body.message as SDKMessage);
    }
  };
}

/**
 * Turn a non-success dispatch result into the right typed failure (issue #220): a synthesized
 * no-frame terminal (`noResult`) is a daemon-side infra fault → {@link RunnerInfraError} (the review
 * loop retries it); a runner-reported `failed` is a genuine in-container agent failure →
 * {@link AgentOutputParseError} carrying the runner's real `detail` (the review loop maxes it out
 * with an honest heal-card). The `MAX_PARSE_RETRIES + 1` attempt count matches the container's own
 * exhausted internal budget for an honest "after N attempts" message.
 */
function containerFailure(role: "review" | "fix", result: DispatchResult): Error {
  const detail = result.detail ?? "";
  if (result.noResult) {
    return new RunnerInfraError(role, detail || "container exited without a result frame");
  }
  return new AgentOutputParseError(MAX_PARSE_RETRIES + 1, detail || `container ${role} run failed`, detail);
}

/**
 * A {@link ReviewAgentRunner} backed by a fresh container (#189). Builds the in-process review
 * prompt, dispatches a `review` assignment, and returns the worklist the container relays.
 */
export class ContainerReviewAgentRunner implements ReviewAgentRunner {
  constructor(private readonly deps: ContainerReviewFixDeps) {}

  async review(ctx: ReviewContext): Promise<Worklist> {
    // Resolve the review route pre-dispatch (ADR-0037 / issue #220); a no-provider wait throws here
    // (resolveContainerRoute) so the run stays resumable rather than maxing the phase out. The
    // review phase (`ctx.phase` = 1 normal / 2 thermo) selects the per-phase routing key (#169).
    const route = resolveContainerRoute(this.deps, "review", ctx.phase);
    const prompt = buildReviewPrompt(ctx.issue, ctx.mode, ctx.phase, ctx.prNumber, ctx.prComments);
    const assignment: Assignment = {
      kind: "review",
      issueNumber: ctx.issue.number,
      mode: ctx.mode,
      branch: ctx.branch,
      base: this.deps.baseBranch,
      prompt,
    };
    // Record the review phase's route at dispatch (ADR-0037 P3.1, issue #164) — best-effort.
    await recordDispatchedRoute({
      store: this.deps.store,
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      phase: phaseLabel(reviewPhase(ctx.phase)),
      route,
      logger: ctx.logger,
    });
    const result = await this.dispatch(assignment, ctx, route);
    if (result.outcome === "reviewed" && result.worklist) {
      return result.worklist;
    }
    // A synthesized no-frame terminal (infra fault → retried) or a runner-reported `failed` (genuine
    // agent failure → review-maxed with an honest heal-card), discriminated by `noResult` (issue #220).
    throw containerFailure("review", result);
  }

  private dispatch(assignment: Assignment, ctx: ReviewContext, route: ContainerRoute | null): Promise<DispatchResult> {
    const dispatch: ContainerDispatch = {
      assignment,
      token: (this.deps.makeToken ?? defaultToken)(assignment),
      ...(route ? { route } : {}),
    };
    const execution = new ContainerExecution({ docker: this.deps.docker, onTelemetry: relayTelemetry(ctx, this.deps.recordRateLimit) });
    return execution.dispatch(dispatch, { abortSignal: ctx.abortSignal });
  }
}

/**
 * A {@link FixAgentRunner} backed by a fresh container (#189). Builds the in-process fix prompt
 * (gating on the target's build/test commands), dispatches a `fix` assignment whose agent pushes
 * runner-direct, and maps the terminal to a {@link FixOutcome}.
 */
export class ContainerFixAgentRunner implements FixAgentRunner {
  constructor(private readonly deps: ContainerReviewFixDeps) {}

  async fix(ctx: FixContext): Promise<FixOutcome> {
    // Resolve the fix route pre-dispatch (ADR-0037 / issue #220); a no-provider wait throws. The
    // fix phase (`ctx.phase` = 0 CI-gate/merge / 1 normal / 2 thermo) selects the per-phase key (#169).
    const route = resolveContainerRoute(this.deps, "fix", ctx.phase);
    const prompt = buildFixPrompt(ctx, this.deps.config.commands.build, this.deps.config.commands.test);
    const assignment: Assignment = {
      kind: "fix",
      issueNumber: ctx.issue.number,
      mode: ctx.mode,
      branch: ctx.branch,
      base: this.deps.baseBranch,
      prompt,
      // A rebase-conflict fix is owned end-to-end by the container: the agent rebases onto base
      // in its clone and the runner force-pushes the result (the daemon verifies it landed, #273).
      ...(ctx.rebaseConflict ? { rebaseConflict: true } : {}),
    };
    const dispatch: ContainerDispatch = {
      assignment,
      token: (this.deps.makeToken ?? defaultToken)(assignment),
      ...(route ? { route } : {}),
    };
    // Record the fix phase's route at dispatch (ADR-0037 P3.1, issue #164) — best-effort.
    await recordDispatchedRoute({
      store: this.deps.store,
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      phase: phaseLabel(fixPhase(ctx.phase)),
      route,
      logger: ctx.logger,
    });
    const execution = new ContainerExecution({ docker: this.deps.docker, onTelemetry: relayTelemetry(ctx, this.deps.recordRateLimit) });
    const result = await execution.dispatch(dispatch, { abortSignal: ctx.abortSignal });

    if (result.outcome === "fixed") {
      return { kind: "fixed" };
    }
    if (result.outcome === "fix-escalate" && result.fixEscalation) {
      return { kind: "escalate", question: result.fixEscalation };
    }
    throw containerFailure("fix", result);
  }
}
