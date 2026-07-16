import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../log/logger";
import {
  accountsResponseSchema,
  analyticsResponseSchema,
  answerResponseSchema,
  backlogResponseSchema,
  drainResponseSchema,
  forceTickResponseSchema,
  healthResponseSchema,
  healthUsageResponseSchema,
  inboxResponseSchema,
  killRunResponseSchema,
  overviewResponseSchema,
  powerActionResponseSchema,
  effectiveRoutingResponseSchema,
  routingEditResponseSchema,
  runDetailResponseSchema,
  runsResponseSchema,
  subscribeResponseSchema,
  unsubscribeResponseSchema,
  vapidPublicKeyResponseSchema,
} from "../contract";
import type { RoutingEditRequestBody } from "../contract";
import type { WebSettings } from "../../config/schema";
import type { DaemonControl, WebControlPlanePorts } from "./ports";
import { WebServer } from "./server";

const silentLogger = createLogger({ level: "error", write: () => {} });
let answerCalls: unknown[] = [];
const VALID_PUSH_PUBLIC_KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_PUSH_AUTH = "AAECAwQFBgcICQoLDA0ODw";
let powerActionCalls: unknown[] = [];
/** Recorded routing-edit calls (ADR-0037 P4.1): the route tests assert the write reaches the port. */
let routingEditCalls: RoutingEditRequestBody[] = [];

/** Recorded DaemonControl calls (issue #118): the route tests assert the routes call the port. */
let controlCalls: { method: "drain" | "forceTick" | "killRun"; runId?: number }[] = [];
/** Scripted killRun results: which run ids the faked control reports as still live. */
let liveRunIds: Set<number> = new Set();

const ports: WebControlPlanePorts = {
  health: () => ({
    status: "ok",
    name: "ralph-autopilot",
    version: "9.9.9",
    startedAt: "2026-06-21T00:00:00.000Z",
    uptimeSeconds: 5,
  }),
  // Echo the repo filter back through `repo` so the route test can assert the
  // `?repo=` query reached the port; the rest is a minimal contract-valid payload.
  overview: (query) => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: query.repo ?? null,
    repos: ["owner/a", "owner/b"],
    reconcileIntervalSeconds: 30,
    needsYou: [],
    fleet: [],
    funnel: { eligible: 0, inFlight: 0, awaitingCi: 0, awaitingMerge: 0, merged: 0 },
    activity: [],
    powerActions: {},
  }),
  // An idle live feed for the non-SSE route tests (the SSE flow has its own suite).
  live: {
    subscribeWake: () => ({ close: () => {} }),
    readAfter: () => [],
    head: () => 0,
  },
  // Echo the repo + window back so the route test can assert both queries reached the
  // port; `windowDays` defaults to 30 (the unresolved query forwards undefined).
  analytics: (query) => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: query.repo ?? null,
    repos: ["owner/a", "owner/b"],
    windowDays: query.windowDays ?? 30,
    since: "2026-05-23T00:00:00.000Z",
    daily: [],
    summary: { totalMerges: 0, meanTimeToMergeMs: null, totalEscalations: 0, totalReviewMaxed: 0, totalAnomalies: 0 },
    distributions: { fixAttempts: [], escalations: [], reviewMaxed: [] },
  }),
  healthUsage: () => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    daemon: {
      targets: "owner/repo",
      cap: 5,
      inFlight: 1,
      startedAt: "2026-06-21T00:00:00.000Z",
      lastTickAt: "2026-06-21T00:00:00.000Z",
      nextTickAt: "2026-06-21T00:00:30.000Z",
      stale: false,
      lastError: null,
    },
    anomalies: [],
    usage: {
      admitBelowPercent: 85,
      activeId: "default",
      paused: false,
      logins: [{ id: "default", active: true, gated: false, disabled: false, windows: [], cooldownUntil: null }],
    },
  }),
  // The account panel (issue #11): one claude account with identity + usage and one parked zai key
  // (env-var NAME only, no value), so the route test can assert the shape parses and no secret leaks.
  accounts: () => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    admitBelowPercent: 85,
    accounts: [
      {
        id: "main",
        provider: "claude",
        enabled: true,
        identity: { emailAddress: "ada@example.com", displayName: "Ada", organizationName: "AE" },
        usage: {
          active: true,
          gated: false,
          cooldownUntil: null,
          windows: [{ type: "five_hour", utilization: 40, resetsAt: "2026-06-21T05:00:00.000Z" }],
        },
      },
      {
        id: "glm",
        provider: "zai",
        enabled: false,
        authTokenEnvName: "ZAI_API_KEY",
        usage: { active: false, gated: false, cooldownUntil: null, windows: [] },
      },
    ],
  }),
  // Likewise echoes the repo filter; minimal contract-valid backlog payload.
  backlog: (query) => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: query.repo ?? null,
    repos: ["owner/a", "owner/b"],
    reconcileIntervalSeconds: 30,
    eligible: [],
    blocked: [],
    paused: [],
    manualHolds: [],
    modingCandidates: [],
    noProvider: [],
    powerActions: {},
  }),
  // Echoes the repo filter; minimal contract-valid runs index.
  runs: (query) => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: query.repo ?? null,
    repos: ["owner/a", "owner/b"],
    runs: [],
  }),
  // A run exists only for issue 7 on owner/a; everything else 404s. Echoes the key so the
  // route test can assert the `?repo=`/`?issue=` query reached the port.
  run: (query) =>
    query.repo === "owner/a" && query.issue === 7
      ? {
          generatedAt: "2026-06-21T00:00:00.000Z",
          run: {
            repo: query.repo,
            issue: query.issue,
            title: "A merged run",
            runId: "1",
            status: "merged",
            mode: "tdd",
            branch: "ralph/7-x",
            prNumber: 9,
            startedAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:10:00.000Z",
            spanStartGlobalPosition: 1,
            fixAttempts: {},
          },
          timeline: [],
          transcript: [],
          pruned: null,
        }
      : null,
  // The Inbox (issue #112): echoes the repo filter over a minimal contract-valid payload with one
  // card, so the route test can assert the `?repo=` query reached the port and the shape parses.
  inbox: async (query) => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: query.repo ?? null,
    repos: ["owner/a", "owner/b"],
    reconcileIntervalSeconds: 30,
    cards: [
      {
        repo: "owner/a",
        issue: 11,
        title: "Q11",
        createdAt: "2026-02-02T00:00:00Z",
        attentionLabel: "awaiting-answer",
        consequence: "resume-from-wip",
        phase: null,
        question: {
          headline: "h",
          feature: "f",
          whereWeStand: "w",
          decision: "d",
          options: ["a", "b"],
          stakes: "s",
          recommendation: "r",
        },
        run: { runId: "1", branch: "ralph/11-x", prNumber: 9 },
        powerActionSurface: "attention",
      },
    ],
    powerActions: { "owner/a": { attention: { actions: ["readmit", "close"], priorityLabels: [] } } },
  }),
  // The answer write (issue #112): a scripted domain outcome so the route test can assert the HTTP
  // layer maps each outcome — answered→200, no-open-question→404, invalid-answer→400 — independent
  // of the port logic (exercised in control-plane.test.ts).
  answer: async (body) => {
    answerCalls.push(body);
    return body.issue === 999
      ? { kind: "no-open-question" as const, error: "no open question" }
      : body.kind === "option" && (body.optionIndex ?? -1) > 5
        ? { kind: "invalid-answer" as const, error: "optionIndex out of range" }
        : {
            kind: "answered" as const,
            response: {
              generatedAt: "2026-06-21T00:00:00.000Z",
              repo: body.repo,
              issue: body.issue,
              attentionLabel: "awaiting-answer",
              consequence: "resume-from-wip",
              resumesNextTickSeconds: 30,
            },
          };
  },
  // The power-action write (issue #114): a scripted domain outcome so the route test can assert the
  // HTTP layer maps each outcome — applied→200, bad-request→400, not-found→404 — and that the Origin
  // guard + close-confirm gate the route (AC2/AC3), independent of the port logic (control-plane.test.ts).
  powerAction: async (body) => {
    powerActionCalls.push(body);
    if (body.repo === "owner/not-configured") {
      return { kind: "bad-request" as const, error: "owner/not-configured is not a configured target repo" };
    }
    if (body.kind === "set-priority" && body.priority === "priority:evil") {
      return { kind: "bad-request" as const, error: "priority not configured" };
    }
    if (body.issue === 999) {
      return { kind: "not-found" as const, error: "no such issue" };
    }
    return {
      kind: "applied" as const,
      response: {
        generatedAt: "2026-06-21T00:00:00.000Z",
        repo: body.repo,
        issue: body.issue,
        action: body.kind,
        appliesNextTickSeconds: 30,
      },
    };
  },
  // A recording DaemonControl (issue #118): each route test asserts the route called the right
  // method with the right arg, independent of the orchestrator implementation (exercised in
  // orchestrator.test.ts). killRun reports a run as killed iff it is in the scripted live set.
  control: {
    drain: () => {
      controlCalls.push({ method: "drain" });
    },
    forceTick: () => {
      controlCalls.push({ method: "forceTick" });
    },
    killRun: (runId: number) => {
      controlCalls.push({ method: "killRun", runId });
      return liveRunIds.has(runId);
    },
  } satisfies DaemonControl,
  // Runtime routing (ADR-0037 P4.1): a minimal contract-valid effective routing, and a scripted
  // edit outcome so the route tests assert the HTTP layer maps each branch (applied→200,
  // bad-request→400) and that the Origin guard fronts the write — independent of the overlay logic
  // (exercised in routing-store.test.ts / routing-actions.test.ts).
  routing: (query) => ({
    generatedAt: "2026-06-21T00:00:00.000Z",
    repo: query.repo ?? null,
    defaultProvider: "claude",
    defaultModel: "opus",
    types: [
      { type: "impl", requiresTools: true, preference: [{ provider: "claude" }] },
      { type: "review", requiresTools: false, preference: [{ provider: "claude" }] },
      { type: "fix", requiresTools: false, preference: [{ provider: "claude" }] },
      { type: "autoMode", requiresTools: false, preference: [{ provider: "claude" }] },
    ],
    providers: [
      { provider: "claude", configured: true, toolsCapable: true },
      { provider: "openai", configured: false, toolsCapable: false },
      { provider: "zai", configured: false, toolsCapable: true },
    ],
    accounts: [],
  }),
  applyRouting: (body) => {
    routingEditCalls.push(body);
    // A capability-invalid pairing (impl → openai) is rejected at the edge (AC3). The per-phase
    // object form (review/fix, #169) carries no top-level `provider`, so it is ignored here.
    const entries = Array.isArray(body.routing)
      ? body.routing
      : body.routing && "provider" in body.routing
        ? [body.routing]
        : [];
    if (body.type === "impl" && entries.some((entry) => entry.provider === "openai")) {
      return {
        kind: "bad-request" as const,
        error: "agent type 'impl' cannot route to provider 'openai': it is not tools-capable",
      };
    }
    return {
      kind: "applied" as const,
      response: {
        generatedAt: "2026-06-21T00:00:00.000Z",
        target: "type" as const,
        type: body.type,
        cleared: body.routing === null,
        appliesNextDispatchSeconds: 30,
      },
    };
  },
  // Web push (issue #119): a scripted vapid read + idempotent subscribe/unsubscribe so the route
  // tests assert the HTTP layer (200/503, body parsing) independent of the port logic.
  webpushVapid: () => ({ enabled: true, publicKey: VALID_PUSH_PUBLIC_KEY }),
  webpushSubscribe: async (body) => ({ kind: "subscribed" as const, response: { ok: true, endpoint: body.endpoint } }),
  webpushUnsubscribe: async () => ({ kind: "unsubscribed" as const }),
};

function settings(staticDir: string): WebSettings {
  return { enabled: true, host: "127.0.0.1", port: 0, staticDir, allowedOrigins: [] };
}

async function req(
  port: number,
  path: string,
  opts: { method?: string; origin?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; body: string; contentType: string | null }> {
  const headers: Record<string, string> = {};
  if (opts.origin) {
    headers.origin = opts.origin;
  }
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  } else if (opts.rawBody !== undefined) {
    headers["content-type"] = "application/json";
    init.body = opts.rawBody;
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type") };
}

describe("WebServer", () => {
  let dir: string;
  let server: WebServer;
  let port: number;

  beforeEach(async () => {
    answerCalls = [];
    powerActionCalls = [];
    routingEditCalls = [];
    controlCalls = [];
    liveRunIds = new Set([42]); // run 42 is "live" by default for kill-run tests
    dir = mkdtempSync(join(tmpdir(), "ralph-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title><div id=root></div>");
    writeFileSync(join(dir, "app.js"), "console.log('hi')");
    server = new WebServer({ config: settings(dir), logger: silentLogger, ports });
    await server.start();
    port = server.boundPort()!;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves /api/health as a valid, contract-shaped response", async () => {
    const res = await req(port, "/api/health");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    expect(healthResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
  });

  it("serves /api/health/usage as a valid, contract-shaped response", async () => {
    const res = await req(port, "/api/health/usage");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    expect(healthUsageResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
  });

  it("serves /api/accounts as a valid, contract-shaped response with no secret material (issue #11)", async () => {
    const res = await req(port, "/api/accounts");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    expect(accountsResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
    // The env-var NAME may appear (a name, not a value); no credential *value* ever does.
    expect(res.body).toContain("ZAI_API_KEY");
    expect(res.body).not.toMatch(/sk-ant|Bearer |configDir|codexHome/);
  });

  it("serves /api/overview as a contract-shaped response, forwarding the repo filter", async () => {
    const all = await req(port, "/api/overview");
    expect(all.status).toBe(200);
    const parsed = overviewResponseSchema.safeParse(JSON.parse(all.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repo).toBeNull();

    // The `?repo=` query reaches the port (the HTTP layer's only decision).
    const filtered = await req(port, "/api/overview?repo=" + encodeURIComponent("owner/a"));
    expect(filtered.status).toBe(200);
    expect(JSON.parse(filtered.body).repo).toBe("owner/a");

    // An empty `?repo=` is treated as no filter (the aggregate).
    const empty = await req(port, "/api/overview?repo=");
    expect(JSON.parse(empty.body).repo).toBeNull();
  });

  it("serves /api/analytics as a contract-shaped response, forwarding the repo + window filters", async () => {
    const all = await req(port, "/api/analytics");
    expect(all.status).toBe(200);
    const parsed = analyticsResponseSchema.safeParse(JSON.parse(all.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repo).toBeNull();
    expect(parsed.success && parsed.data.windowDays).toBe(30); // default window

    // Both `?repo=` and `?window=` reach the port (the HTTP layer's only decisions).
    const filtered = await req(port, "/api/analytics?repo=" + encodeURIComponent("owner/a") + "&window=7");
    expect(filtered.status).toBe(200);
    const body = JSON.parse(filtered.body);
    expect(body.repo).toBe("owner/a");
    expect(body.windowDays).toBe(7);

    // A non-numeric window is treated as unset (the port applies the default).
    const bad = await req(port, "/api/analytics?window=abc");
    expect(JSON.parse(bad.body).windowDays).toBe(30);
  });

  it("serves /api/backlog as a contract-shaped response, forwarding the repo filter", async () => {
    const all = await req(port, "/api/backlog");
    expect(all.status).toBe(200);
    const parsed = backlogResponseSchema.safeParse(JSON.parse(all.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repo).toBeNull();

    // The `?repo=` query reaches the port (the HTTP layer's only decision).
    const filtered = await req(port, "/api/backlog?repo=" + encodeURIComponent("owner/a"));
    expect(filtered.status).toBe(200);
    expect(JSON.parse(filtered.body).repo).toBe("owner/a");

    // An empty `?repo=` is treated as no filter (the aggregate).
    const empty = await req(port, "/api/backlog?repo=");
    expect(JSON.parse(empty.body).repo).toBeNull();
  });

  it("serves /api/runs as a contract-shaped response, forwarding the repo filter", async () => {
    const all = await req(port, "/api/runs");
    expect(all.status).toBe(200);
    const parsed = runsResponseSchema.safeParse(JSON.parse(all.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repo).toBeNull();

    const filtered = await req(port, "/api/runs?repo=" + encodeURIComponent("owner/a"));
    expect(filtered.status).toBe(200);
    expect(JSON.parse(filtered.body).repo).toBe("owner/a");
  });

  it("serves /api/run as a contract-shaped response, forwarding the repo + issue key", async () => {
    const res = await req(port, "/api/run?repo=" + encodeURIComponent("owner/a") + "&issue=7");
    expect(res.status).toBe(200);
    const parsed = runDetailResponseSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.run.issue).toBe(7);
  });

  it("404s /api/run for a run that does not exist", async () => {
    const res = await req(port, "/api/run?repo=" + encodeURIComponent("owner/a") + "&issue=999");
    expect(res.status).toBe(404);
  });

  it("400s /api/run without the required repo + issue key", async () => {
    expect((await req(port, "/api/run")).status).toBe(400);
    expect((await req(port, "/api/run?repo=" + encodeURIComponent("owner/a"))).status).toBe(400);
  });

  it("serves a real static asset", async () => {
    const res = await req(port, "/app.js");
    expect(res.status).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("falls back to index.html for unknown client-side routes (SPA deep links)", async () => {
    const res = await req(port, "/runs/123");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain("id=root");
  });

  it("404s an unknown API route", async () => {
    const res = await req(port, "/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("rejects a cross-origin mutating request via the Origin guard", async () => {
    const res = await req(port, "/api/health", { method: "POST", origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("lets a same-origin mutating request past the Origin guard (then 405 — /api/health is read-only)", async () => {
    const res = await req(port, "/api/health", { method: "POST", origin: `http://127.0.0.1:${port}` });
    expect(res.status).toBe(405);
  });

  it("405s a write to a static path", async () => {
    const res = await req(port, "/app.js", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("serves /api/inbox as a contract-shaped response, forwarding the repo filter", async () => {
    const all = await req(port, "/api/inbox");
    expect(all.status).toBe(200);
    const parsed = inboxResponseSchema.safeParse(JSON.parse(all.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.repo).toBeNull();
    expect(parsed.success && parsed.data.reconcileIntervalSeconds).toBe(30);

    const filtered = await req(port, "/api/inbox?repo=" + encodeURIComponent("owner/a"));
    expect(filtered.status).toBe(200);
    expect(JSON.parse(filtered.body).repo).toBe("owner/a");
  });

  it("405s a POST to the GET-only /api/inbox read", async () => {
    const res = await req(port, "/api/inbox", { method: "POST", origin: `http://127.0.0.1:${port}` });
    expect(res.status).toBe(405);
  });

  it("405s a GET to the POST-only /api/inbox/answer write", async () => {
    const res = await req(port, "/api/inbox/answer");
    expect(res.status).toBe(405);
  });

  it("405s a non-POST unsafe method on /api/inbox/answer without writing", async () => {
    const res = await req(port, "/api/inbox/answer", {
      method: "PUT",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "accept-recommendation" },
    });
    expect(res.status).toBe(405);
    expect(answerCalls).toHaveLength(0);
  });

  it("rejects a cross-origin answer POST via the Origin guard before it reaches the route (AC4)", async () => {
    const res = await req(port, "/api/inbox/answer", {
      method: "POST",
      origin: "https://evil.example",
      body: { repo: "owner/a", issue: 11, kind: "accept-recommendation" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin answer POST, resolving through the port (AC4)", async () => {
    const res = await req(port, "/api/inbox/answer", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "accept-recommendation" },
    });
    expect(res.status).toBe(200);
    expect(answerResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
  });

  it("accepts a no-Origin answer POST (a non-browser client / the CLI)", async () => {
    const res = await req(port, "/api/inbox/answer", {
      method: "POST",
      body: { repo: "owner/a", issue: 11, kind: "free-text", text: "do the thing" },
    });
    expect(res.status).toBe(200);
  });

  it("400s a malformed answer body (bad JSON, then a schema-invalid body)", async () => {
    const badJson = await req(port, "/api/inbox/answer", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      rawBody: "{not json",
    });
    expect(badJson.status).toBe(400);

    const badSchema = await req(port, "/api/inbox/answer", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "no-such-kind" },
    });
    expect(badSchema.status).toBe(400);
  });

  it("maps answer domain outcomes to HTTP statuses: 404 for no open question, 400 for an invalid answer", async () => {
    const notFound = await req(port, "/api/inbox/answer", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 999, kind: "accept-recommendation" },
    });
    expect(notFound.status).toBe(404);

    const invalid = await req(port, "/api/inbox/answer", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "option", optionIndex: 9 },
    });
    expect(invalid.status).toBe(400);
  });

  it("405s a GET on the POST-only /api/backlog/action write", async () => {
    const res = await req(port, "/api/backlog/action");
    expect(res.status).toBe(405);
  });

  // --- Runtime routing (ADR-0037 P4.1, issue #166) -----------------------------------------

  it("serves /api/routing as a contract-shaped response, forwarding the repo filter", async () => {
    const all = await req(port, "/api/routing");
    expect(all.status).toBe(200);
    expect(effectiveRoutingResponseSchema.safeParse(JSON.parse(all.body)).success).toBe(true);
    expect(JSON.parse(all.body).repo).toBeNull();

    const filtered = await req(port, "/api/routing?repo=" + encodeURIComponent("owner/a"));
    expect(JSON.parse(filtered.body).repo).toBe("owner/a");
  });

  it("405s a GET on the POST-only /api/routing/edit write", async () => {
    const res = await req(port, "/api/routing/edit");
    expect(res.status).toBe(405);
  });

  it("rejects a cross-origin routing edit via the Origin guard before it reaches the route (AC3)", async () => {
    const res = await req(port, "/api/routing/edit", {
      method: "POST",
      origin: "https://evil.example",
      body: { target: "type", type: "review", routing: { provider: "claude" } },
    });
    expect(res.status).toBe(403);
    expect(routingEditCalls).toHaveLength(0);
  });

  it("accepts a same-origin routing edit, applying through the port (AC1/AC2)", async () => {
    const res = await req(port, "/api/routing/edit", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { target: "type", type: "review", routing: { provider: "claude", model: "sonnet" } },
    });
    expect(res.status).toBe(200);
    expect(routingEditResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
    expect(routingEditCalls).toHaveLength(1);
  });

  it("400s a capability-invalid routing edit (impl → openai) at the edge (AC3)", async () => {
    const res = await req(port, "/api/routing/edit", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { target: "type", type: "impl", routing: { provider: "openai" } },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not tools-capable/i);
  });

  it("400s a malformed routing edit body (unknown target) before the port", async () => {
    const res = await req(port, "/api/routing/edit", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { target: "bogus" },
    });
    expect(res.status).toBe(400);
    expect(routingEditCalls).toHaveLength(0);
  });

  it("rejects a cross-origin power action via the Origin guard before it reaches the route (AC3)", async () => {
    const res = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: "https://evil.example",
      body: { repo: "owner/a", issue: 11, kind: "readmit" },
    });
    expect(res.status).toBe(403);
    expect(powerActionCalls).toHaveLength(0);
  });

  it("rejects a close without confirm: the body fails the schema parse (AC2 — confirm required)", async () => {
    // No confirm at all.
    const noConfirm = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "close" },
    });
    expect(noConfirm.status).toBe(400);
    // An explicit confirm: false is equally rejected.
    const falseConfirm = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "close", confirm: false },
    });
    expect(falseConfirm.status).toBe(400);
    // Neither malformed close reached the port (no write fired).
    expect(powerActionCalls).toHaveLength(0);
  });

  it("accepts a same-origin power action, resolving through the port and echoing the ~Ns figure (AC1/AC3)", async () => {
    const res = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "readmit" },
    });
    expect(res.status).toBe(200);
    const parsed = powerActionResponseSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.action).toBe("readmit");
    expect(parsed.success && parsed.data.appliesNextTickSeconds).toBe(30); // "acts next tick (~30s)"
  });

  it("accepts a no-Origin power action (a non-browser client / the CLI)", async () => {
    const res = await req(port, "/api/backlog/action", {
      method: "POST",
      body: { repo: "owner/a", issue: 11, kind: "pause" },
    });
    expect(res.status).toBe(200);
  });

  it("maps power-action domain outcomes to HTTP statuses: 404 not-found, 400 bad-request", async () => {
    const notFound = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 999, kind: "set-mode", mode: "infra" },
    });
    expect(notFound.status).toBe(404);

    const badRequest = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "set-priority", priority: "priority:evil" },
    });
    expect(badRequest.status).toBe(400);
  });

  it("400s a malformed power-action body (bad JSON, then a schema-invalid body)", async () => {
    const badJson = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      rawBody: "{not json",
    });
    expect(badJson.status).toBe(400);

    const badSchema = await req(port, "/api/backlog/action", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { repo: "owner/a", issue: 11, kind: "set-mode", mode: "no-such-mode" },
    });
    expect(badSchema.status).toBe(400);
  });

  // ---- Tier-2 daemon control (issue #118, ADR-0032): drain / force-tick / kill-run ----
  // The routes call the DaemonControl port (a fake here) and never reach reconciler internals;
  // the orchestrator implementation is tested separately (orchestrator.test.ts). All three are
  // POST so the Origin guard fronts them; drain + kill-run additionally require confirm.

  it("drain: a same-origin POST with confirm calls DaemonControl.drain and returns 200", async () => {
    const res = await req(port, "/api/daemon/drain", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { confirm: true },
    });
    expect(res.status).toBe(200);
    expect(drainResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
    expect(JSON.parse(res.body).draining).toBe(true);
    expect(controlCalls).toEqual([{ method: "drain" }]);
  });

  it("drain: refuses to fire without confirm (400) and never calls the port", async () => {
    const noConfirm = await req(port, "/api/daemon/drain", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { confirm: false },
    });
    expect(noConfirm.status).toBe(400);
    const missing = await req(port, "/api/daemon/drain", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: {},
    });
    expect(missing.status).toBe(400);
    expect(controlCalls).toEqual([]);
  });

  it("force-tick: a same-origin POST calls DaemonControl.forceTick and returns 200 (no confirm needed)", async () => {
    const res = await req(port, "/api/daemon/force-tick", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(forceTickResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
    expect(JSON.parse(res.body).ticked).toBe(true);
    expect(controlCalls).toEqual([{ method: "forceTick" }]);
  });

  it("kill-run: a same-origin POST with runId + confirm calls DaemonControl.killRun(runId), echoing killed", async () => {
    const res = await req(port, "/api/daemon/kill-run", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { runId: "42", confirm: true },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(killRunResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ runId: "42", killed: true });
    expect(controlCalls).toEqual([{ method: "killRun", runId: 42 }]);
  });

  it("kill-run: reports killed:false for a run that already settled, without erroring", async () => {
    const res = await req(port, "/api/daemon/kill-run", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { runId: "999", confirm: true }, // 999 is not in the live set
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ runId: "999", killed: false });
    expect(controlCalls).toEqual([{ method: "killRun", runId: 999 }]);
  });

  it("kill-run: refuses to fire without confirm (400) and never calls the port", async () => {
    const res = await req(port, "/api/daemon/kill-run", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { runId: "42" },
    });
    expect(res.status).toBe(400);
    expect(controlCalls).toEqual([]);
  });

  it("kill-run: rejects invalid run ids (400) and never calls the port", async () => {
    const nonNumeric = await req(port, "/api/daemon/kill-run", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { runId: "abc", confirm: true },
    });
    expect(nonNumeric.status).toBe(400);

    const outOfRange = await req(port, "/api/daemon/kill-run", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { runId: "9007199254740992", confirm: true },
    });
    expect(outOfRange.status).toBe(400);
    expect(controlCalls).toEqual([]);
  });

  it("control routes are Origin-guarded: a cross-origin POST is 403 before reaching the port", async () => {
    const drain = await req(port, "/api/daemon/drain", {
      method: "POST",
      origin: "https://evil.example",
      body: { confirm: true },
    });
    expect(drain.status).toBe(403);
    const kill = await req(port, "/api/daemon/kill-run", {
      method: "POST",
      origin: "https://evil.example",
      body: { runId: "42", confirm: true },
    });
    expect(kill.status).toBe(403);
    const force = await req(port, "/api/daemon/force-tick", {
      method: "POST",
      origin: "https://evil.example",
      body: {},
    });
    expect(force.status).toBe(403);
    // The guard rejected every control write before it reached the port.
    expect(controlCalls).toEqual([]);
  });

  it("control routes accept a no-Origin POST (a non-browser client / the CLI)", async () => {
    const drain = await req(port, "/api/daemon/drain", { method: "POST", body: { confirm: true } });
    expect(drain.status).toBe(200);
    const force = await req(port, "/api/daemon/force-tick", { method: "POST", body: {} });
    expect(force.status).toBe(200);
    expect(controlCalls.map((c) => c.method)).toEqual(["drain", "forceTick"]);
  });

  it("405s a GET on the POST-only control routes", async () => {
    expect((await req(port, "/api/daemon/drain")).status).toBe(405);
    expect((await req(port, "/api/daemon/force-tick")).status).toBe(405);
    expect((await req(port, "/api/daemon/kill-run")).status).toBe(405);
  });

  it("serves /api/webpush/vapid as a contract-shaped response", async () => {
    const res = await req(port, "/api/webpush/vapid");
    expect(res.status).toBe(200);
    expect(vapidPublicKeyResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
    expect(JSON.parse(res.body).enabled).toBe(true);
  });

  it("405s a GET to the POST-only /api/webpush/subscribe write", async () => {
    expect((await req(port, "/api/webpush/subscribe")).status).toBe(405);
  });

  it("rejects a cross-origin webpush subscribe POST via the Origin guard (ADR-0032)", async () => {
    const res = await req(port, "/api/webpush/subscribe", {
      method: "POST",
      origin: "https://evil.example",
      body: { endpoint: "https://push.example/abc", keys: { p256dh: VALID_PUSH_PUBLIC_KEY, auth: VALID_PUSH_AUTH } },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin webpush subscribe POST, resolving through the port", async () => {
    const res = await req(port, "/api/webpush/subscribe", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { endpoint: "https://push.example/abc", keys: { p256dh: VALID_PUSH_PUBLIC_KEY, auth: VALID_PUSH_AUTH } },
    });
    expect(res.status).toBe(200);
    expect(subscribeResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
  });

  it("400s a malformed webpush subscribe body", async () => {
    const bad = await req(port, "/api/webpush/subscribe", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { endpoint: "not-a-url", keys: { p256dh: "k" } },
    });
    expect(bad.status).toBe(400);
  });

  it("400s webpush subscribe bodies that are not real PushSubscription shapes", async () => {
    const insecureEndpoint = await req(port, "/api/webpush/subscribe", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { endpoint: "http://push.example/abc", keys: { p256dh: VALID_PUSH_PUBLIC_KEY, auth: VALID_PUSH_AUTH } },
    });
    expect(insecureEndpoint.status).toBe(400);

    const wrongLengthKeys = await req(port, "/api/webpush/subscribe", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { endpoint: "https://push.example/abc", keys: { p256dh: "BGk", auth: "a" } },
    });
    expect(wrongLengthKeys.status).toBe(400);
  });

  it("accepts a same-origin webpush unsubscribe POST (idempotent)", async () => {
    const res = await req(port, "/api/webpush/unsubscribe", {
      method: "POST",
      origin: `http://127.0.0.1:${port}`,
      body: { endpoint: "https://push.example/abc" },
    });
    expect(res.status).toBe(200);
    expect(unsubscribeResponseSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
  });
});

describe("WebServer static read faults (ADR-0029 isolation)", () => {
  it("handles an async stream read error without crashing the daemon", async () => {
    // index.html exists (so the placeholder path is not taken) but is a *directory*,
    // so createReadStream emits an async EISDIR 'error' after handle() has returned —
    // exactly the unhandled-error shape that, without the stream error handler, would
    // escape as an uncaught exception and crash the process (ADR-0029 wedge).
    const dir = mkdtempSync(join(tmpdir(), "ralph-web-faulty-"));
    mkdirSync(join(dir, "index.html"));
    const server = new WebServer({ config: settings(dir), logger: silentLogger, ports });
    await server.start();
    const port = server.boundPort()!;
    try {
      // The faulting request resolves (does not hang or reset): either a clean 500 if
      // the fault preceded the header commit, or a terminated 200 if it followed.
      const res = await req(port, "/");
      expect([200, 500]).toContain(res.status);
      // The invariant that matters: the fault did not wedge the daemon — the API is
      // still reachable on the same server afterwards.
      const health = await req(port, "/api/health");
      expect(health.status).toBe(200);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WebServer without a built SPA", () => {
  it("still starts and serves a placeholder, keeping the API reachable", async () => {
    const missing = join(tmpdir(), "ralph-web-missing-does-not-exist");
    const server = new WebServer({ config: settings(missing), logger: silentLogger, ports });
    await server.start();
    const port = server.boundPort()!;
    try {
      const health = await req(port, "/api/health");
      expect(health.status).toBe(200);
      const root = await req(port, "/");
      expect(root.status).toBe(200);
      expect(root.body).toContain("npm run build");
    } finally {
      await server.stop();
    }
  });
});
