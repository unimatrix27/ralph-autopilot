/**
 * The daemon-side adapters that make a container run a drop-in {@link ReviewAgentRunner} /
 * {@link FixAgentRunner} (ADR-0038 / issue #189). The composition root injects these into the
 * {@link import("../review/review-loop").ReviewLoop} for a `container` target, so the review loop —
 * its CI gate, gating, phase machine, and squash-merge — is **byte-for-byte unchanged**: the only
 * difference is that the review pass and each fix attempt run in a fresh container instead of
 * in-process. Per call the adapter builds the same review/fix prompt the in-process path builds,
 * pushes it into a container as an {@link Assignment} (`kind: "review"`/`"fix"`), dispatches through
 * {@link ContainerExecution}, and maps the terminal {@link ResultFrame} back to the runner's
 * contract (`reviewed` → the worklist; `fixed`/`fix-escalate` → the {@link FixOutcome}).
 *
 * These tests drive the adapters against the real in-container runner over an in-memory pipe (a
 * `FakeDocker` "container" runs {@link runContainerRunner} with a scripted review/fix session) —
 * no real docker, SDK, or git. They assert the verdict/worklist contract is preserved and that the
 * two failure shapes are kept apart (issue #220): a dropped pipe / no result frame is a daemon-side
 * infra fault → {@link RunnerInfraError} (the review loop retries it), while a runner-reported
 * `failed` frame (the in-container session threw) is a genuine agent failure →
 * {@link AgentOutputParseError} carrying the runner's real detail (the review loop maxes it out).
 */
import { describe, expect, it } from "vitest";
import { ContainerFixAgentRunner, ContainerReviewAgentRunner } from "./container-review-fix-runner";
import { runContainerRunner, type FixSessionHost, type ReviewSessionHost } from "./runner";
import { FakeDocker } from "../testing/fake-transport";
import { MEMORY_DB, openStore } from "../store/store";
import { parseConfig, resolveTargets } from "../config/load";
import type { TargetConfig } from "../config/schema";
import { createLogger } from "../log/logger";
import type { Issue } from "../github/types";
import { RunnerInfraError, type FixContext, type ReviewContext } from "../review/agents";
import { AgentOutputParseError } from "../executor/structured-session";
import type { Worklist } from "../review/worklist";
import type { FixOutcome } from "../review/agents";
import type { EscalationQuestion } from "../review/escalation";
import type { Account, ProviderName } from "../config/schema";
import type { RouteWorld, RoutingSource } from "../providers/resolve";
import { UsageLimitError, type RateLimitSignal } from "../core/usage";

function config(): TargetConfig {
  return resolveTargets(
    parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "npm run build", test: "npm test" } }] }),
  )[0]!;
}

const silent = createLogger({ write: () => {} });

const issue: Issue = {
  number: 189,
  title: "review + fix runs execute in a container",
  body: "do it",
  state: "OPEN",
  labels: [],
  createdAt: "2026-06-28T00:00:00Z",
};

const reviewCtx: ReviewContext = {
  issue,
  mode: "tdd",
  phase: 1,
  prNumber: 42,
  branch: "ralph/189-x",
  worktreePath: "(unused — the container clones its own)",
  prComments: [],
  logger: silent,
};

const fixCtx: FixContext = {
  issue,
  mode: "tdd",
  phase: 1,
  worklist: { items: [{ severity: "P0", title: "null deref" }] },
  branch: "ralph/189-x",
  worktreePath: "(unused)",
  behaviourPreserving: false,
  logger: silent,
};

/** A FakeDocker whose container runs the real runner with the given review session. */
function dockerReviewing(reviewSession: ReviewSessionHost): FakeDocker {
  return new FakeDocker((runnerTransport, dispatch) =>
    void runContainerRunner(
      { cloner: { clone: async () => ({ path: "/ws" }) }, session: { run: async () => ({ subtype: "success", isError: false, text: "", turns: 1 }) }, reviewSession, transport: runnerTransport },
      dispatch,
    ),
  );
}

/** A FakeDocker whose container runs the real runner with the given fix session. */
function dockerFixing(fixSession: FixSessionHost): FakeDocker {
  return new FakeDocker((runnerTransport, dispatch) =>
    void runContainerRunner(
      { cloner: { clone: async () => ({ path: "/ws" }) }, session: { run: async () => ({ subtype: "success", isError: false, text: "", turns: 1 }) }, fixSession, transport: runnerTransport },
      dispatch,
    ),
  );
}

/** A FakeDocker whose container exits immediately with no result frame (a dead/dropped pipe). */
function dockerDeadPipe(): FakeDocker {
  return new FakeDocker((runnerTransport, _dispatch) => {
    // The container died without reporting: end the runner→daemon stream so the daemon's
    // receive loop reaches EOF and `ContainerExecution.dispatch` synthesises a `failed` result.
    void runnerTransport.close();
  });
}

describe("ContainerReviewAgentRunner (ADR-0038 / issue #189)", () => {
  it("dispatches a review assignment and returns the worklist the container produced", async () => {
    const worklist: Worklist = { items: [{ severity: "P0", title: "null deref" }, { severity: "nit", title: "rename" }] };
    const reviewSession: ReviewSessionHost = { review: async () => worklist };
    const docker = dockerReviewing(reviewSession);

    const runner = new ContainerReviewAgentRunner({ docker, config: config(), baseBranch: "main" });
    const result = await runner.review(reviewCtx);

    expect(result).toEqual(worklist);
    const dispatched = docker.dispatches[0]?.assignment;
    expect(dispatched).toMatchObject({ kind: "review", issueNumber: 189, branch: "ralph/189-x", base: "main", mode: "tdd" });
    // The container is handed the same review prompt the in-process path builds.
    expect(dispatched?.prompt).toContain("Review pull request #42");
  });

  it("throws RunnerInfraError (not a parse failure) when the container review produces no result frame (dead pipe → retry)", async () => {
    const runner = new ContainerReviewAgentRunner({ docker: dockerDeadPipe(), config: config(), baseBranch: "main" });
    const err = await runner.review(reviewCtx).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RunnerInfraError);
    expect(err).not.toBeInstanceOf(AgentOutputParseError);
    expect((err as RunnerInfraError).role).toBe("review");
  });

  it("throws AgentOutputParseError (review-maxed) when the runner reports a `failed` frame (the in-container session threw)", async () => {
    const reviewSession: ReviewSessionHost = {
      review: async () => {
        throw new Error("structured output never parsed");
      },
    };
    const runner = new ContainerReviewAgentRunner({ docker: dockerReviewing(reviewSession), config: config(), baseBranch: "main" });
    const err = await runner.review(reviewCtx).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentOutputParseError);
    expect(err).not.toBeInstanceOf(RunnerInfraError);
    // The runner's real reason is carried through (no JSON-lie fabrication).
    expect((err as AgentOutputParseError).lastError).toContain("structured output never parsed");
  });
});

describe("ContainerFixAgentRunner (ADR-0038 / issue #189)", () => {
  it("dispatches a fix assignment and maps a fixed run to the fixed outcome (pushed runner-direct)", async () => {
    const fixSession: FixSessionHost = { fix: async () => ({ kind: "fixed" }) };
    const docker = dockerFixing(fixSession);

    const runner = new ContainerFixAgentRunner({ docker, config: config(), baseBranch: "main" });
    const outcome = await runner.fix(fixCtx);

    expect(outcome).toEqual<FixOutcome>({ kind: "fixed" });
    const dispatched = docker.dispatches[0]?.assignment;
    expect(dispatched).toMatchObject({ kind: "fix", issueNumber: 189, branch: "ralph/189-x", base: "main" });
    expect(dispatched?.prompt.length).toBeGreaterThan(0);
  });

  // #273: a rebase-conflict fix is signalled to the container so the runner (not the agent)
  // owns the rebase force-push end-to-end. The signal threads straight from rebaseConflict.
  it("threads rebaseConflict:true onto the assignment for a rebase-conflict fix (#273)", async () => {
    const fixSession: FixSessionHost = { fix: async () => ({ kind: "fixed" }) };
    const docker = dockerFixing(fixSession);
    const runner = new ContainerFixAgentRunner({ docker, config: config(), baseBranch: "main" });

    await runner.fix({ ...fixCtx, rebaseConflict: true });

    expect(docker.dispatches[0]?.assignment).toMatchObject({ kind: "fix", rebaseConflict: true });
  });

  it("omits the rebaseConflict flag for a normal fix (no rebaseConflict)", async () => {
    const fixSession: FixSessionHost = { fix: async () => ({ kind: "fixed" }) };
    const docker = dockerFixing(fixSession);
    const runner = new ContainerFixAgentRunner({ docker, config: config(), baseBranch: "main" });

    await runner.fix(fixCtx);

    expect(docker.dispatches[0]?.assignment.rebaseConflict).toBeFalsy();
  });

  it("maps a fix-escalate run to the escalate outcome carrying the question", async () => {
    const question: EscalationQuestion = {
      headline: "Split the store module?",
      feature: "persistence",
      whereWeStand: "schema fine, module doing two jobs",
      decision: "split now vs later",
      stakes: "splitting later is a wider refactor",
      recommendation: "split now",
    };
    const fixSession: FixSessionHost = { fix: async () => ({ kind: "escalate", question }) };

    const runner = new ContainerFixAgentRunner({ docker: dockerFixing(fixSession), config: config(), baseBranch: "main" });
    const outcome = await runner.fix(fixCtx);

    expect(outcome).toEqual<FixOutcome>({ kind: "escalate", question });
  });

  it("throws RunnerInfraError (not a parse failure) when the container fix produces no result frame (dead pipe → retry)", async () => {
    const runner = new ContainerFixAgentRunner({ docker: dockerDeadPipe(), config: config(), baseBranch: "main" });
    const err = await runner.fix(fixCtx).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RunnerInfraError);
    expect(err).not.toBeInstanceOf(AgentOutputParseError);
    expect((err as RunnerInfraError).role).toBe("fix");
  });

  it("throws AgentOutputParseError (review-maxed) when the runner reports a `failed` fix frame (the in-container session threw)", async () => {
    const fixSession: FixSessionHost = {
      fix: async () => {
        throw new Error("fix session blew up");
      },
    };
    const runner = new ContainerFixAgentRunner({ docker: dockerFixing(fixSession), config: config(), baseBranch: "main" });
    const err = await runner.fix(fixCtx).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentOutputParseError);
    expect(err).not.toBeInstanceOf(RunnerInfraError);
    expect((err as AgentOutputParseError).lastError).toContain("fix session blew up");
  });
});

describe("Container review/fix — consume route resolution (ADR-0037 / issue #220)", () => {
  function routing(agent: Record<string, unknown> = {}, providers: Record<string, unknown> = {}): RoutingSource {
    const cfg = resolveTargets(
      parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], agent, providers }),
    )[0]!;
    return () => ({ agent: cfg.agent, providers: cfg.providers });
  }
  function world(headroom: Partial<Record<ProviderName, Account>>): RouteWorld {
    return { acquireAccount: (_repo, provider) => headroom[provider] ?? null };
  }
  const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/host/c1" };

  it("resolves the review route per run and carries the selected account + model onto the dispatch", async () => {
    const docker = dockerReviewing({ review: async () => ({ items: [] }) });
    const runner = new ContainerReviewAgentRunner({
      docker,
      config: config(),
      baseBranch: "main",
      // review is capability-open; the per-type entry's model travels with the resolved route.
      routing: routing({ types: { review: [{ provider: "claude", model: "haiku" }] } }),
      routeWorld: world({ claude: CLAUDE }),
    });

    await runner.review(reviewCtx);

    expect(docker.dispatches[0]?.route).toEqual({ provider: "claude", model: "haiku", account: CLAUDE });
  });

  it("resolves the fix route per run and carries the selected account onto the dispatch", async () => {
    const docker = dockerFixing({ fix: async () => ({ kind: "fixed" }) });
    const runner = new ContainerFixAgentRunner({
      docker,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: world({ claude: CLAUDE }),
    });

    await runner.fix(fixCtx);

    // no per-type override → the dispatch route carries the EFFECTIVE default (agent.model)
    expect(docker.dispatches[0]?.route).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });

  it("does NOT dispatch a review on no-provider — throws UsageLimitError so the run stays resumable", async () => {
    const docker = dockerReviewing({ review: async () => ({ items: [] }) });
    const runner = new ContainerReviewAgentRunner({
      docker,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: world({}), // every pool gated
    });

    await expect(runner.review(reviewCtx)).rejects.toBeInstanceOf(UsageLimitError);
    // The executor's review-loop catch leaves the run resumable + re-drives it next tick; the
    // dropped-pipe AgentOutputParseError (review-maxed) path is NOT taken — no container ran.
    expect(docker.dispatches).toHaveLength(0);
  });

  it("does NOT dispatch a fix on no-provider — throws UsageLimitError so the run stays resumable", async () => {
    const docker = dockerFixing({ fix: async () => ({ kind: "fixed" }) });
    const runner = new ContainerFixAgentRunner({
      docker,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: world({}),
    });

    await expect(runner.fix(fixCtx)).rejects.toBeInstanceOf(UsageLimitError);
    expect(docker.dispatches).toHaveLength(0);
  });

  it("leaves dispatch route-less (box-default) when routing/routeWorld are unwired", async () => {
    const docker = dockerReviewing({ review: async () => ({ items: [] }) });
    const runner = new ContainerReviewAgentRunner({ docker, config: config(), baseBranch: "main" });

    await runner.review(reviewCtx);

    expect(docker.dispatches[0]?.route).toBeUndefined();
  });

  it("folds a review container's rate-limit signal into the dispatched account's meter (issue #228)", async () => {
    const signal: RateLimitSignal = { status: "rejected", resetsAt: 1718924400 };
    const folds: Array<{ provider: ProviderName; accountId: string | undefined; signal: RateLimitSignal }> = [];
    // A review session that observes a 429 mid-pass and relays it, then returns its (empty) worklist.
    const docker = new FakeDocker((runnerTransport, dispatch) =>
      void runContainerRunner(
        {
          cloner: { clone: async () => ({ path: "/ws" }) },
          session: { run: async () => ({ subtype: "success", isError: false, text: "", turns: 1 }) },
          reviewSession: {
            review: async (input) => {
              input.onRateLimit?.(signal);
              return { items: [] };
            },
          },
          transport: runnerTransport,
        },
        dispatch,
      ),
    );

    const runner = new ContainerReviewAgentRunner({
      docker,
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: world({ claude: CLAUDE }),
      recordRateLimit: (provider, accountId, s) => void folds.push({ provider, accountId, signal: s }),
    });
    await runner.review(reviewCtx);

    expect(folds).toEqual([{ provider: "claude", accountId: "c1", signal }]);
  });
});

describe("Container review/fix — record the dispatched route (ADR-0037 P3.1 / issue #164)", () => {
  function routing(agent: Record<string, unknown> = {}): RoutingSource {
    const cfg = resolveTargets(
      parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], agent }),
    )[0]!;
    return () => ({ agent: cfg.agent, providers: cfg.providers });
  }
  const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/host/c1" };

  it("records the review phase's route under its phase label at dispatch", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 189, mode: "tdd" });
    const runner = new ContainerReviewAgentRunner({
      docker: dockerReviewing({ review: async () => ({ items: [] }) }),
      config: config(),
      baseBranch: "main",
      routing: routing({ types: { review: [{ provider: "claude", model: "haiku" }] } }),
      routeWorld: { acquireAccount: () => CLAUDE },
      store,
    });

    await runner.review({ ...reviewCtx, runId: seeded.id, phase: 2 });

    expect(store.getRunRoute(seeded.id)).toEqual({ provider: "claude", model: "haiku", account: "c1" });
    const recorded = store.events.readIssueStream("acme/widgets", 189).filter((e) => e.type === "RouteResolved");
    expect(recorded[0]?.data).toMatchObject({ phase: "review-2", route: { account: "c1" } });
  });

  it("records the fix phase's route under its phase label at dispatch", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 189, mode: "tdd" });
    const runner = new ContainerFixAgentRunner({
      docker: dockerFixing({ fix: async () => ({ kind: "fixed" }) }),
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: { acquireAccount: () => CLAUDE },
      store,
    });

    await runner.fix({ ...fixCtx, runId: seeded.id, phase: 1 });

    expect(store.getRunRoute(seeded.id)).toEqual({ provider: "claude", model: "opus", account: "c1" });
    const recorded = store.events.readIssueStream("acme/widgets", 189).filter((e) => e.type === "RouteResolved");
    expect(recorded[0]?.data).toMatchObject({ phase: "fix-1" });
  });

  it("records nothing when routing is unwired (box-default) or runId is absent", async () => {
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const seeded = store.upsertRun({ issueNumber: 189, mode: "tdd" });
    // Routing wired but the context carries no runId → no correlation tag → nothing recorded.
    const runner = new ContainerFixAgentRunner({
      docker: dockerFixing({ fix: async () => ({ kind: "fixed" }) }),
      config: config(),
      baseBranch: "main",
      routing: routing(),
      routeWorld: { acquireAccount: () => CLAUDE },
      store,
    });

    await runner.fix(fixCtx); // no runId

    expect(store.getRunRoute(seeded.id)).toBeNull();
  });
});
