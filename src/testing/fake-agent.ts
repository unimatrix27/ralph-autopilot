/**
 * Test {@link AgentRunner} doubles. We cannot drive a real Agent SDK session in
 * a unit test (it needs OAuth and would call out), so these stand in for the
 * coding agent: one opens a PR immediately, the other lets a test control when
 * each run completes and tracks concurrency.
 */

import type { AgentRunContext, AgentRunner, AgentRunResult } from "../executor/agent";
import { buildLaunchMarker } from "../github/marker";
import type { EscalationQuestion } from "../review/escalation";
import type { StuckReport } from "../executor/stuck-tool";
import type { FakeGitHub } from "./fake-github";

/** Opens a `Closes #n` + marker PR in the fake GitHub, mimicking a successful run. */
export class PrOpeningAgentRunner implements AgentRunner {
  readonly runs: AgentRunContext[] = [];

  constructor(private readonly github: FakeGitHub) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.runs.push(ctx);
    const marker = buildLaunchMarker({ issueNumber: ctx.issue.number, branch: ctx.branch });
    const body = `Implements #${ctx.issue.number}.\n\nCloses #${ctx.issue.number}\n\n${marker}`;
    this.github.openPullRequest(ctx.branch, body);
    return { ok: true, escalated: false };
  }
}

/**
 * An impl runner that calls the wired `escalate` tool's side effect instead of
 * opening a PR — the impl-agent escalation path. It mimics an agent that hit a
 * decision it cannot make and escalated.
 */
export class EscalatingAgentRunner implements AgentRunner {
  readonly runs: AgentRunContext[] = [];

  constructor(private readonly question: EscalationQuestion) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.runs.push(ctx);
    if (!ctx.onEscalate) {
      throw new Error("EscalatingAgentRunner needs the escalate tool wired (ctx.onEscalate)");
    }
    await ctx.onEscalate(this.question);
    return { ok: true, escalated: true };
  }
}

/**
 * An impl runner that bounds out: it returns a `stuck` result instead of opening
 * a PR — the stuck-budget self-stop or a wall-clock kill, depending on the report
 * category. Mimics an agent the executor must terminate as `agent-stuck`.
 */
export class StuckAgentRunner implements AgentRunner {
  readonly runs: AgentRunContext[] = [];

  constructor(private readonly report: StuckReport) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.runs.push(ctx);
    return { ok: false, escalated: false, stuck: this.report };
  }
}

/** An impl runner for the resume path: records the injected resume context it was handed. */
export class ResumingAgentRunner implements AgentRunner {
  readonly runs: AgentRunContext[] = [];

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.runs.push(ctx);
    // A resumed agent continues on its existing branch; the draft PR is already
    // open, so this is a no-op beyond recording that resume context was injected.
    return { ok: true, escalated: false };
  }
}

/**
 * A runner that models the executor's per-run abort handle (#61). Its session
 * stays in flight until the test settles it, and it observes `ctx.abortSignal` —
 * the kill the executor's {@link import("../executor/executor").Executor.terminate}
 * sends a wedged run. An abort does NOT settle the session on its own (the real
 * SDK keeps the slot held until its `query()` iteration actually unwinds): it only
 * records the kill, so a test can assert the slot is held *while the session is
 * still alive*, then call {@link die} to model the aborted session finally
 * settling — at which point the executor's failure guard terminalizes the run and
 * the slot frees through occupySlot's single owner.
 */
export class AbortAwareAgentRunner implements AgentRunner {
  readonly started: number[] = [];
  /** Issue numbers whose session received the executor's abort (the kill signal). */
  readonly aborted: number[] = [];
  concurrent = 0;
  peak = 0;
  private readonly settlers = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();

  run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const issueNumber = ctx.issue.number;
    this.started.push(issueNumber);
    this.concurrent += 1;
    this.peak = Math.max(this.peak, this.concurrent);
    return new Promise<AgentRunResult>((resolve, reject) => {
      this.settlers.set(issueNumber, {
        resolve: () => resolve({ ok: true, escalated: false }),
        reject,
      });
      const signal = ctx.abortSignal;
      if (signal) {
        const onAbort = (): void => {
          this.aborted.push(issueNumber);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    }).finally(() => {
      this.concurrent -= 1;
      this.settlers.delete(issueNumber);
    });
  }

  /** Settle the in-flight session for `issueNumber` as a normal completion. */
  complete(issueNumber: number): void {
    this.settler(issueNumber).resolve();
  }

  /**
   * Settle the in-flight session as a thrown failure — the wedged session finally
   * dying after its abort. The executor's failure guard turns this into the
   * `agent-stuck` terminal + worktree teardown that frees the slot.
   */
  die(issueNumber: number, message = "session aborted (wall-clock / external kill)"): void {
    this.settler(issueNumber).reject(new Error(message));
  }

  private settler(issueNumber: number): { resolve: () => void; reject: (err: Error) => void } {
    const settler = this.settlers.get(issueNumber);
    if (!settler) {
      throw new Error(`no in-flight agent for #${issueNumber}`);
    }
    return settler;
  }
}

/**
 * A runner whose every run blocks until the test calls {@link complete}. Tracks
 * concurrent and peak in-flight counts and the order runs started, so a test can
 * assert the cap is honoured, slots refill, and ordering is FIFO.
 */
export class ControlledAgentRunner implements AgentRunner {
  readonly started: number[] = [];
  concurrent = 0;
  peak = 0;
  private readonly resolvers = new Map<number, () => void>();

  constructor(private readonly github?: FakeGitHub) {}

  run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.started.push(ctx.issue.number);
    this.concurrent += 1;
    this.peak = Math.max(this.peak, this.concurrent);
    const promise = new Promise<AgentRunResult>((resolve) => {
      this.resolvers.set(ctx.issue.number, () => resolve({ ok: true, escalated: false }));
    });
    return promise.finally(() => {
      this.concurrent -= 1;
    });
  }

  /** Complete the in-flight run for `issueNumber`, optionally opening its PR. */
  complete(issueNumber: number, branch?: string): void {
    const resolve = this.resolvers.get(issueNumber);
    if (!resolve) {
      throw new Error(`no in-flight agent for #${issueNumber}`);
    }
    if (this.github && branch) {
      const marker = buildLaunchMarker({ issueNumber, branch });
      this.github.openPullRequest(branch, `Closes #${issueNumber}\n\n${marker}`);
    }
    this.resolvers.delete(issueNumber);
    resolve();
  }
}
