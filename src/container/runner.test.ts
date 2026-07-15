/**
 * The real in-container runner (ADR-0038 / issue #185, epic #182 slice 3). Supersedes the
 * walking-skeleton {@link import("./stub-runner").runStubRunner}: it fresh-clones the
 * assignment's branch, hosts a real impl SDK session (the agent commits/pushes/opens the PR
 * itself, prompt-driven, exactly as in-process), relays transcript + lifecycle telemetry over
 * the best-effort {@link Transport}, and reports a terminal result.
 *
 * These tests assert *what the runner does* — the milestones it emits, that it hosts the
 * session against the cloned workspace, that its work survives a dead pipe — never private
 * call shapes. The session host and the clone are faked: no real SDK, git, or container runs
 * in the unit suite (the epic's testing decision).
 */
import { describe, expect, it } from "vitest";
import type { Assignment, ContainerDispatch } from "./assignment";
import type { Frame } from "./protocol";
import type { Transport } from "./transport";
import {
  runContainerRunner,
  type FixSessionHost,
  type ReviewSessionHost,
  type ReviewFixSessionInput,
  type RunnerEscalation,
  type RunnerEscalationInput,
  type SessionHost,
  type SessionHostInput,
  type WorkspaceCloner,
} from "./runner";
import type { ClassifiedSessionResult } from "../executor/agent";
import type { EscalationQuestion } from "../review/escalation";
import type { FixOutcome } from "../review/agents";
import type { Worklist } from "../review/worklist";
import { connectedTransports } from "../testing/fake-transport";

/** A complete, bar-clearing escalation question for the runner-direct escalate path (#187). */
function question(): EscalationQuestion {
  return {
    headline: "Which retention window for archived runs?",
    feature: "the run-archival job that prunes finished runs",
    whereWeStand: "the prune job is built but the retention window is a product choice",
    decision: "how long to keep a finished run before pruning it",
    stakes: "too short loses audit history operators rely on; too long grows the box's disk unbounded",
    recommendation: "keep 90 days",
  };
}

const assignment: Assignment = {
  issueNumber: 185,
  mode: "tdd",
  branch: "ralph/185-impl-run",
  base: "main",
  prompt: "implement issue #185 end to end",
};
const dispatch: ContainerDispatch = { assignment, token: { value: "run-token-xyz" } };

/** A {@link WorkspaceCloner} that records every clone and hands back a fixed workspace path. */
class FakeCloner implements WorkspaceCloner {
  readonly clones: Assignment[] = [];
  constructor(private readonly path = "/ws/185") {}
  async clone(a: Assignment): Promise<{ path: string }> {
    this.clones.push(a);
    return { path: this.path };
  }
}

/** A scripted {@link SessionHost}: records its inputs, optionally drives them, returns `result`. */
class FakeSession implements SessionHost {
  readonly inputs: SessionHostInput[] = [];
  result: ClassifiedSessionResult = { subtype: "success", isError: false, text: "ok", turns: 1 };
  onRun?: (input: SessionHostInput) => void | Promise<void>;
  async run(input: SessionHostInput): Promise<ClassifiedSessionResult> {
    this.inputs.push(input);
    await this.onRun?.(input);
    return this.result;
  }
}

/** A {@link RunnerEscalation} that records every publish and hands back a fixed comment id. */
class FakeEscalation implements RunnerEscalation {
  readonly published: RunnerEscalationInput[] = [];
  constructor(private readonly result: { commentId: number; prNumber?: number } = { commentId: 555 }) {}
  async publish(input: RunnerEscalationInput): Promise<{ commentId: number; prNumber?: number }> {
    this.published.push(input);
    return this.result;
  }
}

/** Drain the daemon side until the runner's terminal result frame, mirroring ContainerExecution. */
async function collectUntilResult(transport: Transport): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const frame of transport.receive()) {
    frames.push(frame);
    if (frame.kind === "result") break;
  }
  return frames;
}

describe("in-container runner (ADR-0038 / issue #185)", () => {
  it("emits a started lifecycle, hosts the impl session, then reports a pr-opened result", async () => {
    const { daemon, runner } = connectedTransports();
    const session = new FakeSession();
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session, transport: runner }, dispatch);
    const frames = await collected;

    expect(session.inputs).toHaveLength(1);
    expect(frames).toContainEqual({ kind: "telemetry", body: { type: "lifecycle", name: "started" } });
    expect(frames.at(-1)).toEqual({ kind: "result", outcome: "pr-opened", detail: expect.any(String) });
  });

  it("fresh-clones the assignment's branch and hosts the session against that workspace", async () => {
    const { daemon, runner } = connectedTransports();
    const cloner = new FakeCloner("/ws/fresh-185");
    const session = new FakeSession();
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner, session, transport: runner }, dispatch);
    await collected;

    expect(cloner.clones).toEqual([assignment]);
    expect(session.inputs[0]?.workspacePath).toBe("/ws/fresh-185");
  });

  it("relays the session's captured transcript messages as telemetry frames", async () => {
    const { daemon, runner } = connectedTransports();
    const session = new FakeSession();
    const message = { type: "assistant", text: "working on it" };
    session.onRun = (input) => input.transcriptSink.capture(message as never);
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session, transport: runner }, dispatch);
    const frames = await collected;

    expect(frames).toContainEqual({ kind: "telemetry", body: { type: "transcript", message } });
  });

  it("hosts the session even when the pipe is dead — telemetry is best-effort, work still lands", async () => {
    // A carrier whose every send rejects (a broken pipe). The runner-direct work — clone +
    // the session's own git/PR — must still happen; the pipe is never load-bearing (ADR-0016).
    const deadPipe: Transport = {
      send: async () => {
        throw new Error("EPIPE: broken pipe");
      },
      // eslint-disable-next-line require-yield -- an immediately-closed inbound stream.
      receive: async function* () {},
      close: async () => {},
    };
    const session = new FakeSession();

    await expect(
      runContainerRunner({ cloner: new FakeCloner(), session, transport: deadPipe }, dispatch),
    ).resolves.toBeUndefined();
    expect(session.inputs).toHaveLength(1);
  });

  it("publishes the escalation runner-direct and reports an escalated result frame (#187)", async () => {
    const { daemon, runner } = connectedTransports();
    const q = question();
    const session = new FakeSession();
    session.onRun = async (input) => {
      await input.onEscalate?.(q);
    };
    const escalation = new FakeEscalation({ commentId: 9001, prNumber: 7 });
    const collected = collectUntilResult(daemon);

    await runContainerRunner(
      { cloner: new FakeCloner("/ws/esc"), session, transport: runner, escalation },
      dispatch,
    );
    const frames = await collected;

    // The runner pushed WIP + posted the comment directly (runner-direct), against the run's
    // own cloned workspace — independent of the pipe.
    expect(escalation.published).toEqual([{ assignment, question: q, workspacePath: "/ws/esc" }]);
    // The terminal frame relays the already-posted comment so the daemon can swap the label.
    expect(frames.at(-1)).toEqual({
      kind: "result",
      outcome: "escalated",
      detail: expect.any(String),
      escalation: { headline: q.headline, commentId: 9001, prNumber: 7 },
    });
  });

  it("reports a stuck result frame carrying the agent's self-stop report (#187)", async () => {
    const { daemon, runner } = connectedTransports();
    const session = new FakeSession();
    session.onRun = (input) => {
      input.onStuck?.({ category: "futility", reason: "the task cannot be completed as scoped" });
    };
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session, transport: runner }, dispatch);
    const frames = await collected;

    expect(frames.at(-1)).toEqual({
      kind: "result",
      outcome: "stuck",
      detail: expect.any(String),
      stuck: { category: "futility", reason: "the task cannot be completed as scoped" },
    });
  });

  it("publishes the escalation even when the pipe is dead — it still lands on GitHub (#187)", async () => {
    // AC4: with the pipe down the terminal frame never arrives, but the runner-direct comment +
    // WIP push must still happen — the escalation lands on GitHub regardless (ADR-0016).
    const deadPipe: Transport = {
      send: async () => {
        throw new Error("EPIPE: broken pipe");
      },
      // eslint-disable-next-line require-yield -- an immediately-closed inbound stream.
      receive: async function* () {},
      close: async () => {},
    };
    const q = question();
    const session = new FakeSession();
    session.onRun = async (input) => {
      await input.onEscalate?.(q);
    };
    const escalation = new FakeEscalation();

    await expect(
      runContainerRunner({ cloner: new FakeCloner(), session, transport: deadPipe, escalation }, dispatch),
    ).resolves.toBeUndefined();
    expect(escalation.published).toHaveLength(1);
  });

  it("reports a failed result when the impl session ends in error (no work product)", async () => {
    const { daemon, runner } = connectedTransports();
    const session = new FakeSession();
    session.result = { subtype: "error_max_turns", isError: true, text: "", turns: 9 };
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session, transport: runner }, dispatch);
    const frames = await collected;

    expect(frames.at(-1)).toEqual({ kind: "result", outcome: "failed", detail: expect.any(String) });
  });
});

/** A scripted {@link ReviewSessionHost}: records inputs, returns `worklist` or throws. */
class FakeReviewSession implements ReviewSessionHost {
  readonly inputs: ReviewFixSessionInput[] = [];
  worklist: Worklist = { items: [] };
  error?: Error;
  async review(input: ReviewFixSessionInput): Promise<Worklist> {
    this.inputs.push(input);
    if (this.error) throw this.error;
    return this.worklist;
  }
}

/** A scripted {@link FixSessionHost}: records inputs, returns `outcome` or throws. */
class FakeFixSession implements FixSessionHost {
  readonly inputs: ReviewFixSessionInput[] = [];
  outcome: FixOutcome = { kind: "fixed" };
  error?: Error;
  async fix(input: ReviewFixSessionInput): Promise<FixOutcome> {
    this.inputs.push(input);
    if (this.error) throw this.error;
    return this.outcome;
  }
}

const reviewAssignment: Assignment = {
  kind: "review",
  issueNumber: 189,
  mode: "tdd",
  branch: "ralph/189-review",
  base: "main",
  prompt: "review the diff on PR #42",
};
const reviewDispatch: ContainerDispatch = { assignment: reviewAssignment, token: { value: "tok" } };
const fixAssignment: Assignment = { ...reviewAssignment, kind: "fix", branch: "ralph/189-fix", prompt: "fix the gating items" };
const fixDispatch: ContainerDispatch = { assignment: fixAssignment, token: { value: "tok" } };

describe("in-container runner — review + fix runs (ADR-0038 / issue #189)", () => {
  it("clones the head branch, hosts the review session, and relays the consolidated worklist", async () => {
    const { daemon, runner } = connectedTransports();
    const cloner = new FakeCloner("/ws/review");
    const reviewSession = new FakeReviewSession();
    reviewSession.worklist = { items: [{ severity: "P0", title: "null deref" }] };
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner, session: new FakeSession(), reviewSession, transport: runner }, reviewDispatch);
    const frames = await collected;

    expect(cloner.clones).toEqual([reviewAssignment]);
    expect(reviewSession.inputs[0]?.workspacePath).toBe("/ws/review");
    expect(frames.at(-1)).toEqual({
      kind: "result",
      outcome: "reviewed",
      detail: expect.any(String),
      worklist: { items: [{ severity: "P0", title: "null deref" }] },
    });
  });

  it("relays a failed result when the review session cannot produce a parseable worklist", async () => {
    const { daemon, runner } = connectedTransports();
    const reviewSession = new FakeReviewSession();
    reviewSession.error = new Error("unparseable structured output");
    const collected = collectUntilResult(daemon);

    await runContainerRunner(
      { cloner: new FakeCloner(), session: new FakeSession(), reviewSession, transport: runner },
      reviewDispatch,
    );
    const frames = await collected;

    expect(frames.at(-1)).toEqual({ kind: "result", outcome: "failed", detail: expect.any(String) });
  });

  it("hosts the fix session and reports a fixed result (the fix pushed runner-direct)", async () => {
    const { daemon, runner } = connectedTransports();
    const fixSession = new FakeFixSession();
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session: new FakeSession(), fixSession, transport: runner }, fixDispatch);
    const frames = await collected;

    expect(fixSession.inputs).toHaveLength(1);
    expect(frames.at(-1)).toEqual({ kind: "result", outcome: "fixed", detail: expect.any(String) });
  });

  it("reports a fix-escalate result carrying the question when the fix agent escalates", async () => {
    const { daemon, runner } = connectedTransports();
    const fixSession = new FakeFixSession();
    const q = question();
    fixSession.outcome = { kind: "escalate", question: q };
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session: new FakeSession(), fixSession, transport: runner }, fixDispatch);
    const frames = await collected;

    expect(frames.at(-1)).toEqual({
      kind: "result",
      outcome: "fix-escalate",
      detail: expect.any(String),
      fixEscalation: q,
    });
  });
});

describe("in-container runner — relays rate-limit signals back to the daemon meter (issue #228)", () => {
  const signal = { status: "rejected", resetsAt: 1718924400, utilization: 100, rateLimitType: "five_hour" } as const;

  it("emits a rate-limit telemetry frame carrying the signal when the impl session observes one", async () => {
    const { daemon, runner } = connectedTransports();
    const session = new FakeSession();
    // The session sees the 429 mid-run and forwards it through the wired onRateLimit relay.
    session.onRun = (input) => input.onRateLimit?.(signal);
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session, transport: runner }, dispatch);
    const frames = await collected;

    // The relayed signal rides a `rate-limit` telemetry frame carrying ONLY the signal; neither the
    // provider nor the account id is on the wire — the daemon sources both from the dispatch route.
    expect(frames).toContainEqual({ kind: "telemetry", body: { type: "rate-limit", signal } });
    // The relay is flushed BEFORE the terminal frame, so the daemon folds the meter ahead of the result.
    const rlIdx = frames.findIndex((f) => f.kind === "telemetry" && f.body.type === "rate-limit");
    const resultIdx = frames.findIndex((f) => f.kind === "result");
    expect(rlIdx).toBeGreaterThanOrEqual(0);
    expect(rlIdx).toBeLessThan(resultIdx);
  });

  it("relays a rate-limit signal a review session observes too (the review/fix path also wires the relay)", async () => {
    const { daemon, runner } = connectedTransports();
    const reviewSession = new FakeReviewSession();
    reviewSession.review = async (input) => {
      input.onRateLimit?.(signal);
      return { items: [] };
    };
    const collected = collectUntilResult(daemon);

    await runContainerRunner(
      { cloner: new FakeCloner(), session: new FakeSession(), reviewSession, transport: runner },
      reviewDispatch,
    );
    const frames = await collected;

    expect(frames).toContainEqual({ kind: "telemetry", body: { type: "rate-limit", signal } });
  });

  it("wires the relay unconditionally — the route-less drop now lives daemon-side in the fold", async () => {
    const { daemon, runner } = connectedTransports();
    const session = new FakeSession();
    // The runner no longer gates the relay on a provider dep: it always wires onRateLimit and ships
    // the signal. A route-less run's signal is dropped daemon-side (foldRateLimitTelemetry no-ops
    // when the dispatch carries no route), not by withholding the relay here — so the impl session
    // always sees onRateLimit and the frame still goes out.
    session.onRun = (input) => {
      expect(input.onRateLimit).toBeDefined();
      input.onRateLimit?.(signal);
    };
    const collected = collectUntilResult(daemon);

    await runContainerRunner({ cloner: new FakeCloner(), session, transport: runner }, dispatch);
    const frames = await collected;

    expect(frames).toContainEqual({ kind: "telemetry", body: { type: "rate-limit", signal } });
  });
});
