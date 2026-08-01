/**
 * A promoted (`complexity:1`) issue's tier-1 profile governs **every later agent lane** — route
 * AND session budget — not just impl (ADR-0041 amending ADR-0039).
 *
 * These tests drive the real container adapters against fake dockers and assert what actually
 * rides the dispatch, because the failure mode being guarded against is precisely a promotion
 * that *looks* applied (the label is there, the route is right) while the review that follows
 * quietly runs on the standard budget.
 */
import { describe, expect, it } from "vitest";
import { MEMORY_DB, openStore } from "../store/store";
import { FakeDocker } from "../testing/fake-transport";
import { createLogger } from "../log/logger";
import { parseConfig, resolveTargets } from "../config/load";
import type { Account, AgentSettings, ProvidersSettings, TargetConfig } from "../config/schema";
import type { RoutingConfig, RouteWorld } from "../providers/resolve";
import type { Assignment } from "../container/assignment";
import { ContainerAgentRunner } from "../container/container-agent-runner";
import {
  ContainerFixAgentRunner,
  ContainerReviewAgentRunner,
} from "../container/container-review-fix-runner";
import { ContainerMasterAgentRunner } from "./container-master-runner";
import { LABEL_COMPLEXITY_1, LABEL_COMPLEXITY_2 } from "../core/labels";
import type { Issue, PrComment } from "../github/types";
import { withProfileOverride } from "../container/in-container-session";

const silent = createLogger({ write: () => {} });

function config(): TargetConfig {
  return resolveTargets(
    parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }] }),
  )[0]!;
}

const claudeAccount: Account = { id: "claude-a", provider: "claude", configDir: "~/.claude" };
const providers: ProvidersSettings = {};
const routeWorld: RouteWorld = { acquireAccount: () => claudeAccount };

const agentSettings: AgentSettings = {
  wallClockSeconds: 3600,
  heartbeatSeconds: 30,
  model: "opus",
  effort: "xhigh",
  mcpServers: [],
  mcpServerDefs: {},
  settingSources: ["project"],
  provider: "zai",
  // The BINDING mappings, plus tier-1 budget deltas that must reach every lane.
  types: { impl: [{ provider: "zai" }], review: [{ provider: "zai" }], fix: [{ provider: "zai" }] },
  tiers: {
    "1": { routes: [{ provider: "claude", model: "claude-fable-5" }], effort: "max", wallClockSeconds: 10800 },
    "2": { routes: [{ provider: "claude", model: "claude-opus-5" }] },
  },
};
const routing = (): RoutingConfig => ({ agent: agentSettings, providers });

function issueAt(tier: string): Issue {
  return {
    number: 42,
    title: "Promoted work",
    body: "b",
    state: "OPEN",
    labels: ["afk", "mode:tdd", tier],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** A docker that records the dispatch and immediately ends the container with no frames. */
function recordingDocker(recorded: Assignment[]): FakeDocker {
  return new FakeDocker((transport, dispatch) => {
    recorded.push(dispatch.assignment);
    transport.close();
  });
}

const prComments: PrComment[] = [];

describe("a promoted complexity:1 issue carries tier 1 through every lane (ADR-0041)", () => {
  it("impl dispatches on the tier-1 route and budget", async () => {
    const recorded: Assignment[] = [];
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    store.upsertRun({ issueNumber: 42, mode: "tdd" });
    const runner = new ContainerAgentRunner({
      docker: recordingDocker(recorded),
      store,
      config: config(),
      baseBranch: "main",
      routing,
      routeWorld,
    });

    await runner.run({
      issue: issueAt(LABEL_COMPLEXITY_1),
      mode: "tdd",
      worktreePath: "(unused)",
      branch: "ralph/42-x",
      logger: silent,
      runId: 1,
    });

    expect(recorded[0]!.profile).toEqual({ effort: "max", wallClockSeconds: 10800 });
    expect(store.getRunRoute(1)).toMatchObject({ provider: "claude", model: "claude-fable-5" });
  });

  it("REVIEW dispatches on the tier-1 route and budget — not the uniform review route", async () => {
    const recorded: Assignment[] = [];
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    const runner = new ContainerReviewAgentRunner({
      docker: recordingDocker(recorded),
      config: config(),
      baseBranch: "main",
      routing,
      routeWorld,
      store,
    });
    store.upsertRun({ issueNumber: 42, mode: "tdd" });

    await runner
      .review({
        issue: issueAt(LABEL_COMPLEXITY_1),
        mode: "tdd",
        runId: 1,
        phase: 1,
        prNumber: 9,
        branch: "ralph/42-x",
        worktreePath: "/w",
        prComments,
        logger: silent,
      })
      .catch(() => undefined); // the fake container returns no frame; only the dispatch matters

    expect(recorded[0]!.kind).toBe("review");
    expect(recorded[0]!.profile).toEqual({ effort: "max", wallClockSeconds: 10800 });
    expect(store.getRunRoute(1)).toMatchObject({ provider: "claude", model: "claude-fable-5" });
  });

  it("FIX dispatches on the tier-1 route and budget", async () => {
    const recorded: Assignment[] = [];
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    store.upsertRun({ issueNumber: 42, mode: "tdd" });
    const runner = new ContainerFixAgentRunner({
      docker: recordingDocker(recorded),
      config: config(),
      baseBranch: "main",
      routing,
      routeWorld,
      store,
    });

    await runner
      .fix({
        issue: issueAt(LABEL_COMPLEXITY_1),
        mode: "tdd",
        runId: 1,
        phase: 1,
        attempt: 1,
        prNumber: 9,
        branch: "ralph/42-x",
        worktreePath: "/w",
        worklist: { items: [] },
        logger: silent,
      } as never)
      .catch(() => undefined);

    expect(recorded[0]!.kind).toBe("fix");
    expect(recorded[0]!.profile).toEqual({ effort: "max", wallClockSeconds: 10800 });
    expect(store.getRunRoute(1)).toMatchObject({ provider: "claude", model: "claude-fable-5" });
  });

  it("MASTER dispatches on the tier-1 budget too", async () => {
    const recorded: Assignment[] = [];
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    store.upsertRun({ issueNumber: 42, mode: "tdd" });
    const runner = new ContainerMasterAgentRunner({
      docker: recordingDocker(recorded),
      store,
      config: config(),
      baseBranch: "main",
      routing,
      capabilities: { capabilities: async () => ["impl", "master-escalation"] },
    });

    await runner.run({
      context: {} as never,
      prompt: "adjudicate",
      systemAppend: "sys",
      route: { provider: "claude", model: "claude-fable-5", account: claudeAccount },
      branch: "ralph/42-x",
      worktreePath: "/w",
      runId: 1,
      issue: issueAt(LABEL_COMPLEXITY_1),
      logger: silent,
    });

    expect(recorded[0]!.kind).toBe("master");
    expect(recorded[0]!.escalationMode).toBe("master");
    expect(recorded[0]!.profile).toEqual({ effort: "max", wallClockSeconds: 10800 });
  });

  it("MASTER probes the RESOLVED runner image, not the repo slug (#45)", async () => {
    const recorded: Assignment[] = [];
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    store.upsertRun({ issueNumber: 42, mode: "tdd" });
    // The image a real `docker run` would launch — a per-target tag, distinct from `acme/widgets`.
    const resolvedImage = "ralph/agent/acme-widgets:cachekey";
    const docker = new FakeDocker(
      (transport, dispatch) => {
        recorded.push(dispatch.assignment);
        transport.close();
      },
      undefined,
      resolvedImage,
    );
    const probed: string[] = [];
    const runner = new ContainerMasterAgentRunner({
      docker,
      store,
      config: config(), // config().targetRepo === "acme/widgets"
      baseBranch: "main",
      routing,
      capabilities: {
        capabilities: async (image) => {
          probed.push(image);
          return image === resolvedImage ? ["impl", "master-escalation"] : [];
        },
      },
    });

    await runner.run({
      context: {} as never,
      prompt: "adjudicate",
      systemAppend: "sys",
      route: { provider: "claude", model: "claude-fable-5", account: claudeAccount },
      branch: "ralph/42-x",
      worktreePath: "/w",
      runId: 1,
      issue: issueAt(LABEL_COMPLEXITY_1),
      logger: silent,
    });

    // The gate inspected the resolved image; probing the repo slug would return [] and refuse EVERY
    // master dispatch even on a correctly-built image (the #45 bug). The dispatch landing proves it passed.
    expect(probed).toEqual([resolvedImage]);
    expect(recorded[0]!.kind).toBe("master");
  });

  it("an UNPROMOTED complexity:2 issue keeps the uniform review route and the global budget", async () => {
    const recorded: Assignment[] = [];
    const store = openStore(MEMORY_DB).forRepo("acme/widgets");
    store.upsertRun({ issueNumber: 42, mode: "tdd" });
    const runner = new ContainerReviewAgentRunner({
      docker: recordingDocker(recorded),
      config: config(),
      baseBranch: "main",
      routing,
      routeWorld,
      store,
    });

    await runner
      .review({
        issue: issueAt(LABEL_COMPLEXITY_2),
        mode: "tdd",
        runId: 1,
        phase: 1,
        prNumber: 9,
        branch: "ralph/42-x",
        worktreePath: "/w",
        prComments,
        logger: silent,
      })
      .catch(() => undefined);

    expect(recorded[0]!.profile).toBeUndefined();
    expect(store.getRunRoute(1)).toMatchObject({ provider: "zai" });
  });
});

describe("the runner APPLIES the profile it is handed (never re-derives it)", () => {
  it("swaps effort and wall-clock into the mounted config", () => {
    const base = config();
    const profiled = withProfileOverride(base, { effort: "max", wallClockSeconds: 10800 });
    expect(profiled.agent.effort).toBe("max");
    expect(profiled.agent.wallClockSeconds).toBe(10800);
    // …and an absent profile leaves the mounted globals byte-identical.
    expect(withProfileOverride(base, undefined)).toBe(base);
  });
});
