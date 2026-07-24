/**
 * `ContainerAgentRunner` — the daemon-side adapter that makes a container run a drop-in
 * {@link AgentRunner} (ADR-0038 / issue #185, AC5). It is the whole of the "Option X" routing:
 * the composition root injects this as the executor's `agentRunner` when a target's
 * `executionMode` is `container`, so the executor — and the PR-read-back, escalate/stuck, and
 * review that follow — are **byte-for-byte unchanged**. Per run it builds the impl
 * {@link Assignment} (prompt + branch + base), dispatches it through {@link ContainerExecution},
 * folds the streamed telemetry into the run's transcript store, and maps the terminal
 * {@link ResultFrame} back to an {@link AgentRunResult} (`pr-opened` → `ok`).
 *
 * These tests drive the adapter against the real runner over an in-memory pipe (a `FakeDocker`
 * "container" runs {@link runContainerRunner} with a scripted session) — no real docker, SDK,
 * or git. They assert the adapter routes the assignment, lands telemetry, and maps the result.
 */
import { describe, expect, it } from "vitest";
import { ContainerAgentRunner } from "./container-agent-runner";
import {
  runContainerRunner,
  type RunnerEscalation,
  type RunnerEscalationInput,
  type SessionHost,
  type WorkspaceCloner,
} from "./runner";
import { FakeDocker } from "../testing/fake-transport";
import { MEMORY_DB, openStore } from "../store/store";
import { parseConfig, resolveTargets } from "../config/load";
import type { TargetConfig } from "../config/schema";
import { createLogger } from "../log/logger";
import type { Issue } from "../github/types";
import type { EscalationQuestion } from "../review/escalation";
import type { StuckReport } from "../executor/stuck-tool";
import { formatRalphAnswer, type RalphAnswer } from "../hitl/answer";
import { LABEL_READY } from "../hitl/labels";
import { scanPausedRuns } from "../hitl/resume";
import { FakeGitHub } from "../testing/fake-github";
import type { Assignment } from "./assignment";
import type { Account, ProviderName } from "../config/schema";
import type { RouteWorld, RoutingSource } from "../providers/resolve";
import type { RateLimitSignal } from "../core/usage";
import type { Transport } from "./transport";
import type { RecordRateLimitSignal } from "./record-rate-limit";

function config(): TargetConfig {
  return resolveTargets(
    parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }] }),
  )[0]!;
}

const silent = createLogger({ write: () => {} });

const issue: Issue = {
  number: 185,
  title: "An impl run executes in a fresh container",
  body: "do the thing",
  state: "open",
  labels: ["ready-for-agent", "afk", "mode:tdd"],
  createdAt: "2026-06-27T00:00:00.000Z",
};

const cloner: WorkspaceCloner = { clone: async () => ({ path: "/ws/185" }) };

/** A scripted in-container session: captures one transcript message, then ends as `result.isError`. */
function session(isError: boolean): SessionHost {
  return {
    run: async (input) => {
      input.transcriptSink.capture({
        type: "assistant",
        message: { content: [{ type: "text", text: "implementing" }] },
      } as never);
      return { subtype: isError ? "error" : "success", isError, text: "", turns: 1 };
    },
  };
}

/** A FakeDocker whose container runs the real runner with the given session. */
function dockerRunning(s: SessionHost): FakeDocker {
  return new FakeDocker((runnerTransport, dispatch) =>
    void runContainerRunner({ cloner, session: s, transport: runnerTransport }, dispatch),
  );
}

/** A complete, bar-clearing escalation question for the runner-direct escalate path (#187). */
const escalationQuestion: EscalationQuestion = {
  headline: "Which retention window for archived runs?",
  feature: "the run-archival job that prunes finished runs",
  whereWeStand: "the prune job is built but the retention window is a product choice",
  decision: "how long to keep a finished run before pruning it",
  stakes: "too short loses audit history operators rely on; too long grows the box's disk unbounded",
  recommendation: "keep 90 days",
};

/** A session that calls the runner's `escalate` side effect, then ends. */
function escalatingSession(): SessionHost {
  return {
    run: async (input) => {
      await input.onEscalate?.(escalationQuestion);
      return { subtype: "success", isError: false, text: "", turns: 1 };
    },
  };
}

/** A session that calls the runner's `stuck` self-stop, then ends. */
function stuckSession(report: StuckReport): SessionHost {
  return {
    run: async (input) => {
      input.onStuck?.(report);
      return { subtype: "success", isError: false, text: "", turns: 1 };
    },
  };
}

/** A {@link RunnerEscalation} that records every publish and returns a fixed comment id. */
class FakeEscalation implements RunnerEscalation {
  readonly published: RunnerEscalationInput[] = [];
  constructor(private readonly result: { commentId: number; prNumber?: number }) {}
  async publish(input: RunnerEscalationInput): Promise<{ commentId: number; prNumber?: number }> {
    this.published.push(input);
    return this.result;
  }
}

/** A FakeDocker whose container runs the real runner with a session + escalation publisher. */
function dockerEscalating(s: SessionHost, escalation: RunnerEscalation): FakeDocker {
  return new FakeDocker((runnerTransport, dispatch) =>
    void runContainerRunner({ cloner, session: s, transport: runnerTransport, escalation }, dispatch),
  );
}

describe("ContainerAgentRunner — Option X routing (ADR-0038 / issue #185)", () => {
  it("dispatches the impl assignment through a container and returns ok on a pr-opened run", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const runner = new ContainerAgentRunner({ docker, store, config: config(), baseBranch: "main" });
    const result = await runner.run({
      issue,
      mode: "tdd",
      worktreePath: "(unused — the container clones its own)",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    const [dispatched] = docker.dispatches;
    expect(dispatched?.assignment).toMatchObject({ issueNumber: 185, mode: "tdd", branch: "ralph/185-impl", base: "main" });
    expect(dispatched?.assignment.prompt).toContain("#185");
    expect(dispatched?.token.value.length).toBeGreaterThan(0);
  });

  it("folds the container's transcript telemetry into the run's transcript store", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });

    const runner = new ContainerAgentRunner({ docker: dockerRunning(session(false)), store, config: config(), baseBranch: "main" });
    await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });

    const transcript = store.readTranscript(185, String(seeded.id));
    const roles = transcript.filter((e) => e.type === "TranscriptMessage").map((e) => (e.data as { role: string }).role);
    expect(roles).toContain("assistant"); // the relayed session message
    expect(roles).toContain("system"); // the `started` lifecycle note
  });

  it("records the runner-direct escalation so the daemon swaps to awaiting-answer (#187)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const escalation = new FakeEscalation({ commentId: 4242, prNumber: 9 });

    const runner = new ContainerAgentRunner({
      docker: dockerEscalating(escalatingSession(), escalation),
      store,
      config: config(),
      baseBranch: "main",
    });
    const result = await runner.run({
      issue,
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    // The executor's unchanged disposition sees `escalated` and pauses the run (no review).
    expect(result).toEqual({ ok: false, escalated: true, stuck: null });
    // The daemon indexed the already-posted question, so the `awaiting-answer` label swaps next
    // tick off the projected run status (it never re-posts the comment — the runner did that).
    const open = store.listOpenQuestions("acme/widgets");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "escalate", headline: escalationQuestion.headline, commentId: 4242, runId: seeded.id });
    expect(store.listRunsByStatus("awaiting-answer").map((r) => r.id)).toContain(seeded.id);
  });

  it("records resume context at escalation indexing time — the WIP branch + question keyed to the comment (#9)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const escalation = new FakeEscalation({ commentId: 4242, prNumber: 9 });

    const runner = new ContainerAgentRunner({
      docker: dockerEscalating(escalatingSession(), escalation),
      store,
      config: config(),
      baseBranch: "main",
    });
    await runner.run({
      issue,
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    // The resume context the answered run resolves through (`resolveResumable`): the full
    // question keyed to the posted comment, plus the WIP branch the resume clones. Without it
    // every answered container escalation wedges as `paused-run-unresumable` (#9).
    const ctx = store.getResumeContext(seeded.id);
    expect(ctx).toBeDefined();
    expect(ctx?.branch).toBe("ralph/185-impl");
    expect(ctx?.context.question).toEqual(escalationQuestion);
    expect(ctx?.context.commentId).toBe(4242);
    // An impl-agent escalate carries NO phase — phase-absence IS the impl-resume dispatch axis.
    expect(ctx?.context.phase).toBeUndefined();
  });

  it("regression #9: runner-direct escalation frame → scanPausedRuns reports the run resumable once an answer lands", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const escalation = new FakeEscalation({ commentId: 4242, prNumber: 9 });

    const runner = new ContainerAgentRunner({
      docker: dockerEscalating(escalatingSession(), escalation),
      store,
      config: config(),
      baseBranch: "main",
    });
    await runner.run({
      issue,
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    // The operator answers via the answer flow: the swap-back re-arms `ready-for-agent` and a
    // `ralph-answer` comment lands after the escalation's question comment (FakeGitHub ids start
    // at 5001, post-dating the relayed commentId 4242 — the #10 correlation holds).
    const github = new FakeGitHub();
    github.seed({ number: 185, labels: [LABEL_READY, "afk", "mode:tdd"] });
    const answer: RalphAnswer = { kind: "accept-recommendation", text: escalationQuestion.recommendation };
    void github.postComment(185, formatRalphAnswer(answer));

    const scan = await scanPausedRuns(github, store);

    // The answered, re-armed run resumes — never a `paused-run-unresumable` wedge.
    expect(scan.strandedAnswered).toEqual([]);
    expect(scan.resumable.map((r) => r.run.id)).toEqual([seeded.id]);
    expect(scan.resumable[0]!.answer).toEqual(answer);
    expect(scan.resumable[0]!.context.question.headline).toBe(escalationQuestion.headline);
    expect(scan.resumable[0]!.context.commentId).toBe(4242);
  });

  it("still records a resumable context when a stale runner relays no question (headline fallback, never a wedge)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    // A runner built before the question rode the escalated frame relays only
    // headline/commentId/prNumber. The daemon must still leave the run resumable —
    // the full question lives in the ralph-question comment on GitHub either way.
    const docker = new FakeDocker((t) =>
      void t.send({
        kind: "result",
        outcome: "escalated",
        detail: "escalated to the operator (issue #185)",
        escalation: { headline: escalationQuestion.headline, commentId: 4242 },
      }),
    );

    const runner = new ContainerAgentRunner({ docker, store, config: config(), baseBranch: "main" });
    const result = await runner.run({
      issue,
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    expect(result).toEqual({ ok: false, escalated: true, stuck: null });
    const ctx = store.getResumeContext(seeded.id);
    expect(ctx?.branch).toBe("ralph/185-impl");
    expect(ctx?.context.commentId).toBe(4242);
    expect(ctx?.context.question.headline).toBe(escalationQuestion.headline);
  });

  it("maps a stuck container run to the agent's self-stop report (#187)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const report: StuckReport = { category: "no-green-build", reason: "tests will not go green after 6 edits" };

    const runner = new ContainerAgentRunner({
      docker: dockerRunning(stuckSession(report)),
      store,
      config: config(),
      baseBranch: "main",
    });
    const result = await runner.run({
      issue,
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    expect(result).toEqual({ ok: false, escalated: false, stuck: report });
  });

  it("maps a failed container run to a not-ok result (no PR work product)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });

    const runner = new ContainerAgentRunner({ docker: dockerRunning(session(true)), store, config: config(), baseBranch: "main" });
    const result = await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });

    expect(result.ok).toBe(false);
    // No usage signal → a genuine failure stays not-limited (the executor terminalizes it).
    expect(result.limited).toBeFalsy();
  });

  it("defers (limited) a failed impl run that saw a usage/rate-limit — not agent-stuck (#29)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    // The in-container session relays a usage cap (the primitive fires onRateLimit with the
    // synthesized `rejected` signal before throwing UsageLimitError), then the run terminates
    // failed. The daemon adapter must read that as a transient usage limit → `limited` (defer),
    // NOT a fault → agent-stuck (the impl analogue of the review/fix resumable path).
    const usageLimitedSession: SessionHost = {
      run: async (input) => {
        input.onRateLimit?.({ status: "rejected", rateLimitType: "5h" });
        return { subtype: "error", isError: true, text: "", turns: 1 };
      },
    };

    const runner = new ContainerAgentRunner({
      docker: dockerRunning(usageLimitedSession),
      store,
      config: config(),
      baseBranch: "main",
    });
    const result = await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });

    expect(result).toEqual({ ok: false, escalated: false, stuck: null, limited: true });
  });
});

describe("ContainerAgentRunner — resume-not-restart in a container (ADR-0038 / issue #188)", () => {
  const question: EscalationQuestion = {
    headline: "Which storage backend?",
    feature: "persistence",
    whereWeStand: "the schema is drafted but the driver is unpicked",
    decision: "sqlite vs postgres",
    stakes: "wrong pick is a migration later",
    recommendation: "sqlite",
  };
  const answer: RalphAnswer = { kind: "free-text", text: "Use sqlite — single-box deploy." };

  it("dispatches a resume assignment carrying the operator's answer with the Q&A injected into the prompt", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 188, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const runner = new ContainerAgentRunner({ docker, store, config: config(), baseBranch: "main" });
    const result = await runner.run({
      issue: { ...issue, number: 188 },
      mode: "tdd",
      worktreePath: "(unused — the container clones the WIP branch)",
      branch: "ralph/188-resume",
      runId: seeded.id,
      logger: silent,
      resume: { question, answer },
    });

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    const dispatched = docker.dispatches[0]?.assignment as Assignment;
    // The answer travels on the assignment — the runner's cloner reads it to clone the WIP
    // branch (the prior work is committed there) instead of base.
    expect(dispatched.answer).toBe(answer.text);
    // The built prompt is the resume prompt: it continues the WIP branch and injects the Q&A.
    expect(dispatched.prompt).toContain("Resume work on GitHub issue #188");
    expect(dispatched.prompt).toContain(answer.text);
    expect(dispatched.prompt).toContain(question.headline);
  });

  it("builds a fresh-impl assignment (no answer) when the run is not a resume", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 188, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const runner = new ContainerAgentRunner({ docker, store, config: config(), baseBranch: "main" });
    await runner.run({
      issue: { ...issue, number: 188 },
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/188-impl",
      runId: seeded.id,
      logger: silent,
    });

    expect(docker.dispatches[0]?.assignment.answer).toBeUndefined();
  });
});

describe("ContainerAgentRunner — consumes route resolution (ADR-0037 / issue #220)", () => {
  /** Live routing for `acme/widgets` from partial agent/provider overrides. */
  function routing(agent: Record<string, unknown> = {}, providers: Record<string, unknown> = {}): RoutingSource {
    const cfg = resolveTargets(
      parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], agent, providers }),
    )[0]!;
    return () => ({ agent: cfg.agent, providers: cfg.providers });
  }

  /** A headroom port that hands back a fixed account per named provider; unnamed → gated (null). */
  function world(headroom: Partial<Record<ProviderName, Account>>): RouteWorld {
    return { acquireAccount: (_repo, provider) => headroom[provider] ?? null };
  }

  const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/host/c1" };

  function ctx(seededId: number, overrides: Partial<Parameters<ContainerAgentRunner["run"]>[0]> = {}) {
    return {
      issue,
      mode: "tdd" as const,
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seededId,
      logger: silent,
      ...overrides,
    };
  }

  it("resolves the impl route and carries the selected account + provider/model on the dispatch", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const runner = new ContainerAgentRunner({
      docker,
      store,
      config: config(),
      baseBranch: "main",
      // The model travels with the per-type route ENTRY (not the global default), so the resolved
      // route carries it onto the dispatch.
      routing: routing({ types: { impl: [{ provider: "claude", model: "opus" }] } }),
      routeWorld: world({ claude: CLAUDE }),
    });
    const result = await runner.run(ctx(seeded.id));

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    // The route the daemon resolved rides on the dispatch (self-contained; #164 records it).
    expect(docker.dispatches[0]?.route).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });

  it("steers two runs onto the different accounts the pool hands back (AC: per-run selection)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));
    const a: Account = { id: "a", provider: "claude", configDir: "/host/a" };
    const b: Account = { id: "b", provider: "claude", configDir: "/host/b" };
    // A pool that rotates: first acquire → a, second → b.
    const pool = [a, b];
    let n = 0;
    const rotating: RouteWorld = { acquireAccount: () => pool[n++] ?? null };

    const runner = new ContainerAgentRunner({ docker, store, config: config(), baseBranch: "main", routing: routing(), routeWorld: rotating });
    await runner.run(ctx(seeded.id));
    await runner.run(ctx(seeded.id, { branch: "ralph/185-impl-2" }));

    expect(docker.dispatches[0]?.route?.account).toEqual(a);
    expect(docker.dispatches[1]?.route?.account).toEqual(b);
  });

  it("does NOT dispatch on no-provider — returns limited so admission re-resolves next tick (#163)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const runner = new ContainerAgentRunner({
      docker,
      store,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      // Every pool gated → resolveRoute returns { wait: "no-provider" }.
      routeWorld: world({}),
    });
    const result = await runner.run(ctx(seeded.id));

    // `limited` defers cleanly (executor restores ready-for-agent, drops the run) — never an error,
    // never agent-stuck. No container ever started.
    expect(result).toEqual({ ok: false, escalated: false, stuck: null, limited: true });
    expect(docker.dispatches).toHaveLength(0);
  });

  it("never dispatches a capability-invalid (impl, openai) route — the gate defers it (#220)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));
    const OPENAI: Account = { id: "o1", provider: "openai", codexHome: "/host/o" };

    // The capability gate is enforced at config-load too (it would reject impl→openai there), so
    // build the routing thunk directly to exercise resolveRoute's defence-in-depth: even handed a
    // capability-invalid impl route, the gate inside resolveRoute returns no-provider — impl never
    // reaches a capability-invalid backend.
    const base = resolveTargets(parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }] }))[0]!;
    const invalidRouting: RoutingSource = () => ({
      agent: { ...base.agent, types: { ...base.agent.types, impl: [{ provider: "openai" }] } },
      providers: base.providers,
    });

    const runner = new ContainerAgentRunner({
      docker,
      store,
      config: config(),
      baseBranch: "main",
      routing: invalidRouting,
      // openai HAS headroom, but the gate skips it for impl → no-provider, never a dispatch.
      routeWorld: world({ openai: OPENAI }),
    });
    const result = await runner.run(ctx(seeded.id));

    expect(result.limited).toBe(true);
    expect(docker.dispatches).toHaveLength(0);
  });

  it("dispatches the box-default path unchanged when routing/routeWorld are unwired (tests)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const runner = new ContainerAgentRunner({ docker, store, config: config(), baseBranch: "main" });
    const result = await runner.run(ctx(seeded.id));

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    expect(docker.dispatches[0]?.route).toBeUndefined();
  });
});

describe("ContainerAgentRunner — records the dispatched route (ADR-0037 P3.1 / issue #164)", () => {
  function routing(agent: Record<string, unknown> = {}): RoutingSource {
    const cfg = resolveTargets(
      parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], agent }),
    )[0]!;
    return () => ({ agent: cfg.agent, providers: cfg.providers });
  }
  const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/host/c1" };

  it("records the impl phase's { provider, model, account-id } into the read-model at dispatch", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });

    const runner = new ContainerAgentRunner({
      docker: dockerRunning(session(false)),
      store,
      config: config(),
      baseBranch: "main",
      routing: routing({ types: { impl: [{ provider: "claude", model: "opus" }] } }),
      routeWorld: { acquireAccount: () => CLAUDE },
    });
    await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });

    // The read-model carries the resolved route — the account's ID only, never its credential.
    expect(store.getRunRoute(seeded.id)).toEqual({ provider: "claude", model: "opus", account: "c1" });
    // It rides on a RouteResolved fact tagged with the impl phase (the permanent timeline tier).
    const events = store.events.readIssueStream("acme/widgets", 185);
    const recorded = events.filter((e) => e.type === "RouteResolved");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.data).toMatchObject({ phase: "impl", route: { provider: "claude", model: "opus", account: "c1" } });
  });

  it("a resume's re-dispatch overwrites the recorded route (latest dispatch wins)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    // Same provider, two accounts: the pool rotates a1 → c2 across the two dispatches, so the
    // recorded route's account is the latest container's (one route per container lifetime).
    const A: Account = { id: "a1", provider: "claude", configDir: "/host/a" };
    const B: Account = { id: "c2", provider: "claude", configDir: "/host/c2" };
    const pool = [A, B];
    let n = 0;
    const runner = new ContainerAgentRunner({
      docker: dockerRunning(session(false)),
      store,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: { acquireAccount: () => pool[n++] ?? null },
    });

    await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });
    expect(store.getRunRoute(seeded.id)).toEqual({ provider: "claude", model: "opus", account: "a1" });
    // The resume is a fresh dispatch that re-resolves onto the next account; the latest wins.
    await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });
    expect(store.getRunRoute(seeded.id)).toEqual({ provider: "claude", model: "opus", account: "c2" });
  });

  it("records nothing for a box-default (route-less) dispatch — getRunRoute stays null", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });

    const runner = new ContainerAgentRunner({ docker: dockerRunning(session(false)), store, config: config(), baseBranch: "main" });
    await runner.run({ issue, mode: "tdd", worktreePath: "x", branch: "ralph/185-impl", runId: seeded.id, logger: silent });

    expect(store.getRunRoute(seeded.id)).toBeNull();
    expect(store.events.readIssueStream("acme/widgets", 185).some((e) => e.type === "RouteResolved")).toBe(false);
  });
});

describe("ContainerAgentRunner — feeds container rate-limit signals back to the meter (ADR-0037/0038 / issue #228)", () => {
  const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/host/c1" };

  function routing(agent: Record<string, unknown> = {}, providers: Record<string, unknown> = {}): RoutingSource {
    const cfg = resolveTargets(
      parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], agent, providers }),
    )[0]!;
    return () => ({ agent: cfg.agent, providers: cfg.providers });
  }
  function world(headroom: Partial<Record<ProviderName, Account>>): RouteWorld {
    return { acquireAccount: (_repo, provider) => headroom[provider] ?? null };
  }
  function ctx(seededId: number) {
    return { issue, mode: "tdd" as const, worktreePath: "x", branch: "ralph/185-impl", runId: seededId, logger: silent };
  }

  /** A scripted in-container session that reports a rate-limit signal mid-run, then ends cleanly. */
  function rateLimitedSession(signal: RateLimitSignal): SessionHost {
    return {
      run: async (input) => {
        input.onRateLimit?.(signal);
        return { subtype: "success", isError: false, text: "", turns: 1 };
      },
    };
  }

  /** A FakeDocker running the real runner with an optional transport wrap (the daemon-side fold sources
   *  the provider from the dispatch route, so the runner needs no provider of its own). */
  function dockerRunningWrapped(s: SessionHost, wrap: (t: Transport) => Transport = (t) => t): FakeDocker {
    return new FakeDocker((runnerTransport, dispatch) =>
      void runContainerRunner({ cloner, session: s, transport: wrap(runnerTransport) }, dispatch),
    );
  }

  it("folds a claude container's rate-limit signal into the DISPATCHED account's meter (the named account moves)", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const signal: RateLimitSignal = { status: "rejected", resetsAt: 1718924400, utilization: 100 };
    const folds: Array<{ provider: ProviderName; accountId: string | undefined; signal: RateLimitSignal }> = [];
    const recordRateLimit: RecordRateLimitSignal = (provider, accountId, s) => void folds.push({ provider, accountId, signal: s });

    const runner = new ContainerAgentRunner({
      docker: dockerRunningWrapped(rateLimitedSession(signal)),
      store,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: world({ claude: CLAUDE }),
      recordRateLimit,
    });
    const result = await runner.run(ctx(seeded.id));

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    // The signal born inside the container folds into the meter tagged with the provider the runner
    // ran on + the account the DAEMON dispatched (never on the wire) — the named account moves.
    expect(folds).toEqual([{ provider: "claude", accountId: "c1", signal }]);
  });

  it("a dropped rate-limit frame (the transport drops it) leaves the meter untouched and the run still succeeds", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const folds: unknown[] = [];
    // A transport that silently drops every rate-limit telemetry send — a broken pipe for that frame
    // — while transcript + result frames still flow. The runner's relay swallows the failure.
    const dropRateLimit = (t: Transport): Transport => ({
      send: (f) =>
        f.kind === "telemetry" && f.body.type === "rate-limit" ? Promise.reject(new Error("pipe dropped")) : t.send(f),
      receive: () => t.receive(),
      close: () => t.close(),
    });

    const runner = new ContainerAgentRunner({
      docker: dockerRunningWrapped(rateLimitedSession({ status: "rejected" }), dropRateLimit),
      store,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: world({ claude: CLAUDE }),
      recordRateLimit: (...args) => void folds.push(args),
    });
    const result = await runner.run(ctx(seeded.id));

    // The run completes normally and the meter never moved: a dropped signal degrades to a
    // less-fresh allocation, never a thrown error or a lost run (best-effort pipe, ADR-0038).
    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    expect(folds).toHaveLength(0);
  });
});

describe("ContainerAgentRunner — per-tier agent profiles (issue #278)", () => {
  function routing(agent: Record<string, unknown> = {}): RoutingSource {
    const cfg = resolveTargets(
      parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], agent }),
    )[0]!;
    return () => ({ agent: cfg.agent, providers: cfg.providers });
  }
  function world(headroom: Partial<Record<ProviderName, Account>>): RouteWorld {
    return { acquireAccount: (_repo, provider) => headroom[provider] ?? null };
  }
  const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/host/c1" };
  const TIERED = {
    types: { impl: [{ provider: "claude", model: "opus" }] },
    tiers: { "1": { routes: [{ provider: "claude", model: "claude-fable-5" }], effort: "max", wallClockSeconds: 10800 } },
  };
  const tieredIssue: Issue = { ...issue, labels: [...issue.labels, "complexity:1"] };

  function runner(docker: FakeDocker, store: ReturnType<ReturnType<typeof openStore>["forRepo"]>) {
    return new ContainerAgentRunner({
      docker,
      store,
      config: config(),
      baseBranch: "main",
      routing: routing(TIERED),
      routeWorld: world({ claude: CLAUDE }),
    });
  }

  it("a complexity:1 label routes the dispatch onto the tier's routes and carries the session profile", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd", tier: 1 });
    const docker = dockerRunning(session(false));

    const result = await runner(docker, store).run({
      issue: tieredIssue,
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    // The tier's routes replaced the impl list; the tier's budget rides the assignment.
    expect(docker.dispatches[0]?.route).toEqual({ provider: "claude", model: "claude-fable-5", account: CLAUDE });
    expect(docker.dispatches[0]?.assignment.profile).toEqual({ effort: "max", wallClockSeconds: 10800 });
  });

  it("an unlabeled issue dispatches on types.impl with NO profile — byte-identical to before", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 185, mode: "tdd" });
    const docker = dockerRunning(session(false));

    const result = await runner(docker, store).run({
      issue, // no complexity:* label
      mode: "tdd",
      worktreePath: "x",
      branch: "ralph/185-impl",
      runId: seeded.id,
      logger: silent,
    });

    expect(result).toEqual({ ok: true, escalated: false, stuck: null });
    expect(docker.dispatches[0]?.route).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
    expect(docker.dispatches[0]?.assignment.profile).toBeUndefined();
    expect("profile" in (docker.dispatches[0]?.assignment ?? {})).toBe(false);
  });
});
