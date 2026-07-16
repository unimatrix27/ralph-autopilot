import { describe, expect, it } from "vitest";
import {
  accountsResponseSchema,
  analyticsResponseSchema,
  API_BASE,
  API_ROUTES,
  BACKLOG_PAUSED_STATES,
  backlogResponseSchema,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  drainRequestBodySchema,
  drainResponseSchema,
  forceTickRequestBodySchema,
  forceTickResponseSchema,
  healthResponseSchema,
  healthUsageResponseSchema,
  isLiveRunStatus,
  killRunRequestBodySchema,
  killRunResponseSchema,
  MAX_ANALYTICS_WINDOW_DAYS,
  NEEDS_YOU_STATES,
  overviewResponseSchema,
  resolveWindowDays,
  routeSchema,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  timelineEntrySchema,
  type RunStatusWire,
} from "./index";

const ATTENTION_POWER_ACTIONS = { actions: ["readmit", "close"], priorityLabels: [] };
const QUEUED_POWER_ACTIONS = {
  actions: ["pause", "set-mode", "set-priority", "close"],
  priorityLabels: ["priority:p0", "priority:p1"],
};
const MANUAL_HOLD_POWER_ACTIONS = {
  actions: ["unpause", "set-mode", "set-priority", "close"],
  priorityLabels: ["priority:p0", "priority:p1"],
};
const MODING_POWER_ACTIONS = { actions: ["set-mode", "close"], priorityLabels: [] };

describe("web contract leaf", () => {
  it("round-trips a valid health response", () => {
    const value = {
      status: "ok" as const,
      name: "ralph-autopilot",
      version: "0.0.0",
      startedAt: "2026-06-21T00:00:00.000Z",
      uptimeSeconds: 42,
    };
    const parsed = healthResponseSchema.parse(value);
    expect(parsed).toEqual(value);
  });

  it("rejects unknown keys (the contract is strict, so drift is loud)", () => {
    const result = healthResponseSchema.safeParse({
      status: "ok",
      name: "ralph-autopilot",
      version: "0.0.0",
      startedAt: "2026-06-21T00:00:00.000Z",
      uptimeSeconds: 1,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a wrong-typed field", () => {
    const result = healthResponseSchema.safeParse({
      status: "ok",
      name: "ralph-autopilot",
      version: "0.0.0",
      startedAt: "2026-06-21T00:00:00.000Z",
      uptimeSeconds: -1, // must be nonnegative
    });
    expect(result.success).toBe(false);
  });

  it("namespaces every route under the API base", () => {
    for (const route of Object.values(API_ROUTES)) {
      expect(route.startsWith(API_BASE)).toBe(true);
    }
  });
});

describe("overview contract", () => {
  const valid = {
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: null,
    repos: ["owner/a", "owner/b"],
    reconcileIntervalSeconds: 30,
    needsYou: [
      {
        state: "daemon-anomaly" as const,
        repo: "owner/a",
        issue: 9,
        waitingSince: null,
        summary: "Completeness anomaly — needs repair",
        powerActionSurface: "attention" as const,
      },
      {
        state: "awaiting-answer" as const,
        repo: "owner/b",
        issue: 20,
        waitingSince: "2026-06-20T00:00:00.000Z",
        summary: "Pick a DB driver",
        powerActionSurface: "attention" as const,
      },
    ],
    fleet: [
      {
        repo: "owner/a",
        issue: 12,
        // The GitHub issue title captured at dispatch (issue #13); nullable on the wire.
        title: "Live + Runs views",
        phase: "fix-1",
        fixAttempt: 2,
        phaseStartedAt: "2026-06-20T23:30:00.000Z",
        // The live phase's route (ADR-0037 P3.1, issue #164): account id only, model nullable.
        route: { provider: "claude" as const, model: "opus", account: "c1" },
      },
    ],
    funnel: { eligible: 3, inFlight: 1, awaitingCi: 0, awaitingMerge: 2, merged: 5 },
    activity: [
      {
        repo: "owner/a",
        issue: 5,
        event: "merged",
        ts: "2026-06-20T22:00:00.000Z",
        summary: "Merged PR #7",
      },
      { repo: null, issue: null, event: "daemon-anomaly", ts: "2026-06-20T21:00:00.000Z", summary: "Daemon anomaly" },
    ],
    powerActions: {
      "owner/a": { attention: ATTENTION_POWER_ACTIONS },
      "owner/b": { attention: ATTENTION_POWER_ACTIONS },
    },
  };

  it("round-trips a full, valid overview (parse → serialize is identity)", () => {
    const parsed = overviewResponseSchema.parse(valid);
    expect(parsed).toEqual(valid);
    // Serialize → re-parse is also identity (the wire crossing both sides perform).
    expect(overviewResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(valid);
  });

  it("accepts a repo-narrowed response (repo set, repos still the full set)", () => {
    const narrowed = { ...valid, repo: "owner/a" };
    expect(overviewResponseSchema.safeParse(narrowed).success).toBe(true);
  });

  it("rejects unknown keys anywhere (strict, so drift is loud)", () => {
    expect(overviewResponseSchema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
    const badItem = { ...valid, needsYou: [{ ...valid.needsYou[0], extra: 1 }] };
    expect(overviewResponseSchema.safeParse(badItem).success).toBe(false);
  });

  it("rejects a needs-you state outside the four attention states", () => {
    const bad = { ...valid, needsYou: [{ ...valid.needsYou[0], state: "in-flight" }] };
    expect(overviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a negative funnel count and a non-integer issue", () => {
    expect(overviewResponseSchema.safeParse({ ...valid, funnel: { ...valid.funnel, merged: -1 } }).success).toBe(false);
    const badIssue = { ...valid, fleet: [{ ...valid.fleet[0], issue: 1.5 }] };
    expect(overviewResponseSchema.safeParse(badIssue).success).toBe(false);
  });

  it("orders the attention states most-urgent-first", () => {
    expect(NEEDS_YOU_STATES).toEqual(["daemon-anomaly", "agent-stuck", "review-maxed", "awaiting-answer"]);
  });

  it("accepts a null fleet route (box-default / unrecorded dispatch)", () => {
    const noRoute = { ...valid, fleet: [{ ...valid.fleet[0], route: null }] };
    expect(overviewResponseSchema.safeParse(noRoute).success).toBe(true);
  });

  it("requires the fleet route field (serialise ↔ parse stay in sync, ADR-0031)", () => {
    const { route: _drop, ...fleetWithoutRoute } = valid.fleet[0]!;
    const missing = { ...valid, fleet: [fleetWithoutRoute] };
    expect(overviewResponseSchema.safeParse(missing).success).toBe(false);
  });
});

describe("route contract (ADR-0037 P3.1, issue #164)", () => {
  it("parses a full route and a default-model route (model null)", () => {
    expect(routeSchema.parse({ provider: "claude", model: "opus", account: "c1" })).toEqual({
      provider: "claude",
      model: "opus",
      account: "c1",
    });
    expect(routeSchema.parse({ provider: "zai", model: null, account: "z3" })).toEqual({
      provider: "zai",
      model: null,
      account: "z3",
    });
  });

  it("rejects an unknown provider and any unknown key (strict, account id only — no credential)", () => {
    expect(routeSchema.safeParse({ provider: "anthropic", model: null, account: "c1" }).success).toBe(false);
    // A leaked credential field (configDir/authTokenEnv) is rejected — the wire carries the id alone.
    expect(routeSchema.safeParse({ provider: "claude", model: null, account: "c1", configDir: "/x" }).success).toBe(false);
  });

  it("requires model to be present (nullable, not optional) so the wire shape is explicit", () => {
    expect(routeSchema.safeParse({ provider: "claude", account: "c1" }).success).toBe(false);
  });

  it("a timeline entry's route is optional — present for RouteResolved, absent otherwise", () => {
    expect(
      timelineEntrySchema.safeParse({ globalPosition: 2, streamPosition: 2, type: "ReviewPhaseEntered", data: {} }).success,
    ).toBe(true);
    const routed = timelineEntrySchema.parse({
      globalPosition: 3,
      streamPosition: 3,
      type: "RouteResolved",
      data: { runId: "5", phase: "impl" },
      route: { provider: "claude", model: "opus", account: "c1" },
    });
    expect(routed.route).toEqual({ provider: "claude", model: "opus", account: "c1" });
  });
});

describe("analytics contract", () => {
  const valid = {
    generatedAt: "2026-06-21T12:00:00.000Z",
    repo: null,
    repos: ["owner/a", "owner/b"],
    windowDays: 30,
    since: "2026-05-23T00:00:00.000Z",
    daily: [
      { date: "2026-06-20", merges: 2, anomalies: 0, meanTimeToMergeMs: 3_600_000 },
      { date: "2026-06-21", merges: 0, anomalies: 1, meanTimeToMergeMs: null },
    ],
    summary: {
      totalMerges: 2,
      meanTimeToMergeMs: 3_600_000,
      totalEscalations: 3,
      totalReviewMaxed: 1,
      totalAnomalies: 1,
    },
    distributions: {
      fixAttempts: [{ bucket: 3, count: 1 }],
      escalations: [
        { bucket: 1, count: 2 },
        { bucket: 2, count: 1 },
      ],
      reviewMaxed: [{ bucket: 1, count: 1 }],
    },
  };

  it("round-trips a full, valid analytics payload (parse → serialize is identity)", () => {
    const parsed = analyticsResponseSchema.parse(valid);
    expect(parsed).toEqual(valid);
    expect(analyticsResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(valid);
  });

  it("accepts a repo-narrowed response (repo set, repos still the full set)", () => {
    expect(analyticsResponseSchema.safeParse({ ...valid, repo: "owner/a" }).success).toBe(true);
  });

  it("rejects unknown keys anywhere (strict, so drift is loud)", () => {
    expect(analyticsResponseSchema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
    const badPoint = { ...valid, daily: [{ ...valid.daily[0], extra: 1 }] };
    expect(analyticsResponseSchema.safeParse(badPoint).success).toBe(false);
    const badBucket = {
      ...valid,
      distributions: { ...valid.distributions, fixAttempts: [{ bucket: 1, count: 1, extra: 1 }] },
    };
    expect(analyticsResponseSchema.safeParse(badBucket).success).toBe(false);
  });

  it("rejects a negative count and a non-integer window", () => {
    expect(analyticsResponseSchema.safeParse({ ...valid, summary: { ...valid.summary, totalMerges: -1 } }).success).toBe(false);
    expect(analyticsResponseSchema.safeParse({ ...valid, windowDays: 7.5 }).success).toBe(false);
  });

  it("resolves the window: default for absent/invalid, clamps the max, floors fractions", () => {
    expect(resolveWindowDays(undefined)).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS);
    expect(resolveWindowDays(Number.NaN)).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS);
    expect(resolveWindowDays(0)).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS);
    expect(resolveWindowDays(-5)).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS);
    expect(resolveWindowDays(7)).toBe(7);
    expect(resolveWindowDays(14.9)).toBe(14);
    expect(resolveWindowDays(10_000)).toBe(MAX_ANALYTICS_WINDOW_DAYS);
  });
});

describe("health + usage contract", () => {
  const valid = {
    generatedAt: "2026-06-21T12:00:00.000Z",
    daemon: {
      targets: "owner/repo",
      cap: 5,
      inFlight: 2,
      startedAt: "2026-06-21T08:00:00.000Z",
      lastTickAt: "2026-06-21T11:59:50.000Z",
      nextTickAt: "2026-06-21T12:00:20.000Z",
      stale: false,
      lastError: null,
    },
    anomalies: [
      {
        repo: "owner/repo",
        issue: 42,
        reason: "paused-label-missing-run",
        title: "an island",
        since: "2026-06-21T10:00:00.000Z",
      },
    ],
    usage: {
      admitBelowPercent: 85,
      activeId: "primary",
      paused: false,
      logins: [
        {
          id: "primary",
          active: true,
          gated: false,
          disabled: false,
          windows: [
            { type: "five_hour", utilization: 40, resetsAt: "2026-06-21T13:00:00.000Z" },
            { type: "seven_day", utilization: null, resetsAt: null },
          ],
          cooldownUntil: null,
        },
        {
          id: "secondary",
          active: false,
          gated: true,
          disabled: true,
          windows: [],
          cooldownUntil: "2026-06-21T12:30:00.000Z",
        },
      ],
    },
  };

  it("round-trips a full, valid payload (parse → serialize is identity)", () => {
    const parsed = healthUsageResponseSchema.parse(valid);
    expect(parsed).toEqual(valid);
    expect(healthUsageResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(valid);
  });

  it("accepts a null daemon (before the first tick) and an empty anomaly list", () => {
    expect(healthUsageResponseSchema.safeParse({ ...valid, daemon: null, anomalies: [] }).success).toBe(true);
  });

  it("rejects unknown keys anywhere (strict, so drift is loud)", () => {
    expect(healthUsageResponseSchema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
    const badDaemon = { ...valid, daemon: { ...valid.daemon, extra: 1 } };
    expect(healthUsageResponseSchema.safeParse(badDaemon).success).toBe(false);
    const badLogin = { ...valid, usage: { ...valid.usage, logins: [{ ...valid.usage.logins[0], extra: 1 }] } };
    expect(healthUsageResponseSchema.safeParse(badLogin).success).toBe(false);
  });

  it("rejects a negative cap and a non-positive anomaly issue", () => {
    expect(healthUsageResponseSchema.safeParse({ ...valid, daemon: { ...valid.daemon, cap: -1 } }).success).toBe(false);
    const badIssue = { ...valid, anomalies: [{ ...valid.anomalies[0], issue: 0 }] };
    expect(healthUsageResponseSchema.safeParse(badIssue).success).toBe(false);
  });
});

describe("accounts contract (issue #11)", () => {
  const valid = {
    generatedAt: "2026-07-16T12:00:00.000Z",
    admitBelowPercent: 85,
    accounts: [
      {
        id: "main",
        provider: "claude" as const,
        enabled: true,
        identity: { emailAddress: "ada@example.com", displayName: "Ada Lovelace", organizationName: "Analytical Engines" },
        usage: {
          active: true,
          gated: false,
          cooldownUntil: null,
          windows: [
            { type: "five_hour", utilization: 40, resetsAt: "2026-07-16T13:00:00.000Z" },
            { type: "seven_day", utilization: null, resetsAt: null },
          ],
        },
      },
      // A parked claude account with NO identity (graceful absence) and a never-used null convention.
      {
        id: "second",
        provider: "claude" as const,
        enabled: false,
        usage: { active: false, gated: false, cooldownUntil: null, windows: [] },
      },
      // A key-based zai account: id + provider + the env-var NAME (never its value), no identity.
      {
        id: "glm",
        provider: "zai" as const,
        enabled: true,
        authTokenEnvName: "ZAI_API_KEY",
        usage: { active: false, gated: true, cooldownUntil: "2026-07-16T12:30:00.000Z", windows: [] },
      },
    ],
  };

  it("round-trips a full, valid payload (parse → serialize is identity)", () => {
    const parsed = accountsResponseSchema.parse(valid);
    expect(parsed).toEqual(valid);
    // Serialize → re-parse is also identity (the wire crossing both sides perform, ADR-0031).
    expect(accountsResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(valid);
  });

  it("omits an absent identity rather than emitting null (graceful absence, issue #11)", () => {
    const parsed = accountsResponseSchema.parse(valid);
    expect("identity" in parsed.accounts[1]!).toBe(false);
    // A profile missing a field carries only the fields it has (never a guessed placeholder).
    const partial = {
      ...valid,
      accounts: [{ ...valid.accounts[0]!, identity: { emailAddress: "ada@example.com" } }],
    };
    expect(accountsResponseSchema.parse(partial).accounts[0]!.identity).toEqual({ emailAddress: "ada@example.com" });
  });

  it("rejects unknown keys anywhere (strict, so a leaked credential field is a parse error)", () => {
    expect(accountsResponseSchema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
    // A credential field smuggled onto an account (configDir / authTokenEnv) is rejected outright.
    const leaked = { ...valid, accounts: [{ ...valid.accounts[0]!, configDir: "/home/op/.claude" }] };
    expect(accountsResponseSchema.safeParse(leaked).success).toBe(false);
    const leakedToken = { ...valid, accounts: [{ ...valid.accounts[2]!, authTokenEnv: "SECRET_VALUE" }] };
    expect(accountsResponseSchema.safeParse(leakedToken).success).toBe(false);
    const badIdentity = {
      ...valid,
      accounts: [{ ...valid.accounts[0]!, identity: { emailAddress: "a@b.c", accountUuid: "leak" } }],
    };
    expect(accountsResponseSchema.safeParse(badIdentity).success).toBe(false);
  });

  it("rejects an unknown provider and a non-integer threshold", () => {
    const badProvider = { ...valid, accounts: [{ ...valid.accounts[0]!, provider: "anthropic" }] };
    expect(accountsResponseSchema.safeParse(badProvider).success).toBe(false);
    expect(accountsResponseSchema.safeParse({ ...valid, admitBelowPercent: 85.5 }).success).toBe(false);
  });

  it("namespaces the accounts route under the API base", () => {
    expect(API_ROUTES.accounts.startsWith(`${API_BASE}/`)).toBe(true);
  });
});

describe("backlog contract", () => {
  const valid = {
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: null,
    repos: ["owner/a", "owner/b"],
    reconcileIntervalSeconds: 30,
    eligible: [
      {
        repo: "owner/a",
        issue: 11,
        title: "first up",
        priority: "priority:p0",
        priorityColor: "red" as const,
        powerActionSurface: "queued" as const,
      },
      {
        repo: "owner/a",
        issue: 12,
        title: "then this",
        priority: null,
        priorityColor: null,
        powerActionSurface: "queued" as const,
      },
    ],
    blocked: [
      {
        repo: "owner/b",
        issue: 20,
        title: "waiting on deps",
        blockers: [
          { ref: 7, satisfied: true },
          { ref: 8, satisfied: false },
        ],
        powerActionSurface: "queued" as const,
      },
    ],
    paused: [
      { repo: "owner/a", issue: 30, title: "needs a human", state: "agent-stuck" as const, powerActionSurface: "attention" as const },
    ],
    manualHolds: [{ repo: "owner/a", issue: 35, title: "operator held", powerActionSurface: "manual-hold" as const }],
    modingCandidates: [{ repo: "owner/b", issue: 40, title: "no mode yet", powerActionSurface: "moding" as const }],
    noProvider: [
      { repo: "owner/a", issue: 50, title: "parked — no provider", resetsAt: "2026-06-29T14:30:00.000Z", powerActionSurface: "queued" as const },
      { repo: "owner/b", issue: 51, title: "no eta", resetsAt: null, powerActionSurface: "queued" as const },
    ],
    powerActions: {
      "owner/a": {
        queued: QUEUED_POWER_ACTIONS,
        attention: ATTENTION_POWER_ACTIONS,
        "manual-hold": MANUAL_HOLD_POWER_ACTIONS,
      },
      "owner/b": {
        queued: QUEUED_POWER_ACTIONS,
        moding: MODING_POWER_ACTIONS,
      },
    },
  };

  it("round-trips a full, valid backlog (parse → serialize is identity)", () => {
    const parsed = backlogResponseSchema.parse(valid);
    expect(parsed).toEqual(valid);
    expect(backlogResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(valid);
  });

  it("accepts a repo-narrowed response (repo set, repos still the full set)", () => {
    expect(backlogResponseSchema.safeParse({ ...valid, repo: "owner/a" }).success).toBe(true);
  });

  it("rejects unknown keys anywhere (strict, so drift is loud)", () => {
    expect(backlogResponseSchema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
    const badBlocker = {
      ...valid,
      blocked: [{ ...valid.blocked[0], blockers: [{ ref: 7, satisfied: true, extra: 1 }] }],
    };
    expect(backlogResponseSchema.safeParse(badBlocker).success).toBe(false);
  });

  it("rejects a paused state outside the four attention states", () => {
    const bad = { ...valid, paused: [{ ...valid.paused[0], state: "in-flight" }] };
    expect(backlogResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("carries the no-provider wait with a nullable reset ETA (ADR-0037 P3.2, #165)", () => {
    const parsed = backlogResponseSchema.parse(valid);
    expect(parsed.noProvider.map((n) => [n.issue, n.resetsAt])).toEqual([
      [50, "2026-06-29T14:30:00.000Z"],
      [51, null],
    ]);
    // A no-provider row must carry resetsAt (nullable, never absent) and reject unknown keys.
    const missingReset = { ...valid, noProvider: [{ repo: "owner/a", issue: 50, title: "x", powerActionSurface: "queued" }] };
    expect(backlogResponseSchema.safeParse(missingReset).success).toBe(false);
    const extraKey = { ...valid, noProvider: [{ ...valid.noProvider[0], extra: 1 }] };
    expect(backlogResponseSchema.safeParse(extraKey).success).toBe(false);
  });

  it("rejects a non-positive or non-integer issue/ref", () => {
    expect(
      backlogResponseSchema.safeParse({ ...valid, eligible: [{ ...valid.eligible[0], issue: 0 }] }).success,
    ).toBe(false);
    const badRef = { ...valid, blocked: [{ ...valid.blocked[0], blockers: [{ ref: 1.5, satisfied: true }] }] };
    expect(backlogResponseSchema.safeParse(badRef).success).toBe(false);
  });

  it("orders the paused attention states most-urgent-first", () => {
    expect(BACKLOG_PAUSED_STATES).toEqual(["daemon-anomaly", "agent-stuck", "review-maxed", "awaiting-answer"]);
  });
});

describe("isLiveRunStatus — which runs open a live tail", () => {
  it("treats `awaiting-merge` (the integration agent) as live, not terminal", () => {
    // The integration agent runs while the run deliberately stays `awaiting-merge`, so a
    // Fleet card opening this run must land on the streaming transcript (issue #111).
    expect(isLiveRunStatus("awaiting-merge")).toBe(true);
  });

  it("streams every non-terminal status and freezes only the terminal ones", () => {
    for (const status of RUN_STATUSES) {
      const terminal = (TERMINAL_RUN_STATUSES as readonly RunStatusWire[]).includes(status);
      expect(isLiveRunStatus(status)).toBe(!terminal);
    }
    expect([...TERMINAL_RUN_STATUSES]).toEqual(["agent-stuck", "review-maxed", "merged", "closed"]);
  });
});

describe("daemon control contract (issue #118)", () => {
  it("round-trips valid drain / force-tick / kill-run responses and routes them under the API base", () => {
    const drain = drainResponseSchema.parse({ generatedAt: "2026-06-23T00:00:00.000Z", draining: true });
    expect(drain).toEqual({ generatedAt: "2026-06-23T00:00:00.000Z", draining: true });

    const tick = forceTickResponseSchema.parse({ generatedAt: "2026-06-23T00:00:00.000Z", ticked: true });
    expect(tick).toEqual({ generatedAt: "2026-06-23T00:00:00.000Z", ticked: true });

    const kill = killRunResponseSchema.parse({ generatedAt: "2026-06-23T00:00:00.000Z", runId: "7", killed: true });
    expect(kill).toEqual({ generatedAt: "2026-06-23T00:00:00.000Z", runId: "7", killed: true });

    // Every control route is namespaced under the API base (the URL contract).
    expect([API_ROUTES.drain, API_ROUTES.forceTick, API_ROUTES.killRun].every((r) => r.startsWith(`${API_BASE}/daemon/`))).toBe(true);
  });

  it("requires confirm: true on the destructive drain + kill-run bodies (confirm before firing)", () => {
    // A missing or false confirm is rejected — the wire-edge gate against an accidental fire.
    expect(drainRequestBodySchema.safeParse({ confirm: false }).success).toBe(false);
    expect(drainRequestBodySchema.safeParse({}).success).toBe(false);
    expect(drainRequestBodySchema.safeParse({ confirm: true }).success).toBe(true);

    expect(killRunRequestBodySchema.safeParse({ runId: "7", confirm: false }).success).toBe(false);
    expect(killRunRequestBodySchema.safeParse({ runId: "7" }).success).toBe(false);
    expect(killRunRequestBodySchema.safeParse({ runId: "7", confirm: true }).success).toBe(true);
  });

  it("rejects a kill-run body missing the run id, and rejects unknown keys (strict)", () => {
    expect(killRunRequestBodySchema.safeParse({ confirm: true }).success).toBe(false); // no runId
    expect(killRunRequestBodySchema.safeParse({ runId: "", confirm: true }).success).toBe(false); // empty runId
    expect(
      killRunRequestBodySchema.safeParse({ runId: "7", confirm: true, extra: "nope" }).success,
    ).toBe(false);
    expect(drainRequestBodySchema.safeParse({ confirm: true, extra: "nope" }).success).toBe(false);
  });

  it("requires kill-run ids to be positive safe integers", () => {
    expect(killRunRequestBodySchema.safeParse({ runId: "7", confirm: true }).success).toBe(true);
    expect(killRunRequestBodySchema.safeParse({ runId: "abc", confirm: true }).success).toBe(false);
    expect(killRunRequestBodySchema.safeParse({ runId: "7.5", confirm: true }).success).toBe(false);
    expect(killRunRequestBodySchema.safeParse({ runId: "0", confirm: true }).success).toBe(false);
    expect(killRunRequestBodySchema.safeParse({ runId: "9007199254740992", confirm: true }).success).toBe(false);
  });

  it("force-tick takes an empty body (non-destructive, no confirm) but still rejects unknown keys", () => {
    expect(forceTickRequestBodySchema.safeParse({}).success).toBe(true);
    expect(forceTickRequestBodySchema.safeParse({ confirm: true }).success).toBe(false); // unknown key
  });
});
