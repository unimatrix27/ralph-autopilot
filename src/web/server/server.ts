/**
 * The embedded HTTP control-plane server (ADR-0029/0031/0032). Runs *inside* the
 * daemon process — not a sidecar, not Next.js — on Node's built-in `http` (no web
 * framework dependency). It serves the built SPA statically and exposes the read
 * API under `/api`. Two security seams sit in front of the routes:
 *   - the **auth middleware** (reserved; default allow-all — Tailscale is the
 *     boundary, ADR-0032), and
 *   - the **Origin guard** on unsafe-method (mutating) requests (confused-deputy
 *     hygiene), wired before the shared JSON route dispatch.
 *
 * Isolation (ADR-0029): nothing here is ever awaited by the reconcile tick. The
 * server reaches daemon capability only through {@link WebControlPlanePorts}, listens on its own
 * socket, and is `unref`'d so it can never keep the process alive past a drain.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../../log/logger";
import type { WebSettings } from "../../config/schema";
import {
  accountsResponseSchema,
  analyticsResponseSchema,
  answerRequestBodySchema,
  answerResponseSchema,
  backlogResponseSchema,
  drainRequestBodySchema,
  drainResponseSchema,
  forceTickRequestBodySchema,
  forceTickResponseSchema,
  healthResponseSchema,
  healthUsageResponseSchema,
  inboxResponseSchema,
  killRunRequestBodySchema,
  killRunResponseSchema,
  overviewResponseSchema,
  powerActionRequestBodySchema,
  powerActionResponseSchema,
  effectiveRoutingResponseSchema,
  routingEditRequestBodySchema,
  routingEditResponseSchema,
  runDetailResponseSchema,
  runsResponseSchema,
  subscribeRequestBodySchema,
  subscribeResponseSchema,
  unsubscribeRequestBodySchema,
  unsubscribeResponseSchema,
  vapidPublicKeyResponseSchema,
  API_ROUTES,
  API_BASE,
} from "../contract";
import type {
  AnswerRequestBody,
  SubscribeRequestBody,
  UnsubscribeRequestBody,
  PowerActionRequestBody,
  RoutingEditRequestBody,
} from "../contract";
import type { AnswerPortResult } from "../inbox";
import type { PowerActionPortResult } from "../power-actions";
import type { RoutingEditPortResult } from "../routing-actions";
import { allowAllAuth, type AuthMiddleware } from "./auth";
import { isOriginAllowed, isSafeMethod } from "./origin-guard";
import type {
  WebControlPlanePorts,
  WebPushSubscribeResult,
  WebPushUnsubscribeResult,
} from "./ports";
import { serveStatic } from "./static";
import { handleLiveSse } from "./sse";

export interface WebServerDeps {
  config: WebSettings;
  logger: Logger;
  /** The isolated ports the server serves from (ADR-0029/0032). */
  ports: WebControlPlanePorts;
  /** Reserved auth seam (ADR-0032); defaults to allow-all (Tailscale is the boundary). */
  auth?: AuthMiddleware;
}

/** A host that needs no exposure warning (the request never leaves the box). */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * One JSON endpoint in the dispatch table: method plus a dispatcher that returns the exact HTTP
 * response to send. The auth + Origin seams run once above the table; SSE remains special because
 * it owns its response lifecycle.
 */
type ApiMethod = "GET" | "POST";

interface ResponseSchema {
  parse(data: unknown): unknown;
}

interface BodySchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
}

type RouteHttpResult = { status: number; body: unknown };
type JsonBodyReader = (req: IncomingMessage) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;

interface ApiRoute {
  method: ApiMethod;
  // A dispatch may be sync (most reads) or async (Inbox + answer await GitHub);
  // handleApi awaits it, which is a no-op on a non-promise return.
  dispatch: (req: IncomingMessage, readJsonBody: JsonBodyReader) => RouteHttpResult | Promise<RouteHttpResult>;
}

function routeAllowsMethod(routeMethod: ApiMethod, requestMethod: string | undefined): boolean {
  const method = (requestMethod ?? "GET").toUpperCase();
  return routeMethod === "GET" ? isSafeMethod(method) : method === routeMethod;
}

function jsonOk(responseSchema: ResponseSchema, data: unknown): RouteHttpResult {
  return { status: 200, body: responseSchema.parse(data) };
}

function getJsonRoute(responseSchema: ResponseSchema, handler: (req: IncomingMessage) => unknown | Promise<unknown>): ApiRoute {
  return {
    method: "GET",
    dispatch: async (req) => jsonOk(responseSchema, await handler(req)),
  };
}

function getHttpRoute(handler: (req: IncomingMessage) => RouteHttpResult | Promise<RouteHttpResult>): ApiRoute {
  return {
    method: "GET",
    dispatch: handler,
  };
}

function postJsonRoute<TBody>(opts: {
  bodySchema: BodySchema<TBody>;
  invalidBodyMessage: string;
  handler: (req: IncomingMessage, body: TBody) => RouteHttpResult | Promise<RouteHttpResult>;
}): ApiRoute {
  return {
    method: "POST",
    dispatch: async (req, readJsonBody) => {
      const raw = await readJsonBody(req);
      if (!raw.ok) {
        return { status: 400, body: { error: raw.error } };
      }
      const parsed = opts.bodySchema.safeParse(raw.value);
      if (!parsed.success) {
        return {
          status: 400,
          body: {
            error: opts.invalidBodyMessage,
            issues: parsed.error.issues.map((i) => i.message),
          },
        };
      }
      return opts.handler(req, parsed.data);
    },
  };
}

function answerResultToHttp(result: AnswerPortResult): RouteHttpResult {
  switch (result.kind) {
    case "answered":
      return jsonOk(answerResponseSchema, result.response);
    case "invalid-answer":
      return { status: 400, body: { error: result.error } };
    case "no-open-question":
      return { status: 404, body: { error: result.error } };
  }
}

function subscribeResultToHttp(result: WebPushSubscribeResult): RouteHttpResult {
  switch (result.kind) {
    case "subscribed":
      return jsonOk(subscribeResponseSchema, result.response);
    case "disabled":
      return { status: 503, body: { error: result.error } };
  }
}

function unsubscribeResultToHttp(result: WebPushUnsubscribeResult): RouteHttpResult {
  switch (result.kind) {
    case "unsubscribed":
      return jsonOk(unsubscribeResponseSchema, { ok: true });
  }
}

/**
 * Map a power-action domain outcome to its HTTP status (mirrors {@link answerResultToHttp}):
 * `applied` → 200 (the action was written back, response parsed against the schema);
 * `bad-request` → 400 (unknown repo, an unconfigured priority, …); `not-found` → 404 (no such issue).
 */
function powerActionResultToHttp(result: PowerActionPortResult): RouteHttpResult {
  switch (result.kind) {
    case "applied":
      return jsonOk(powerActionResponseSchema, result.response);
    case "bad-request":
      return { status: 400, body: { error: result.error } };
    case "not-found":
      return { status: 404, body: { error: result.error } };
  }
}

/**
 * Map a routing-edit domain outcome to its HTTP status (ADR-0037 P4.1): `applied` → 200 (the
 * overlay + config.yaml were updated), `bad-request` → 400 (a capability-invalid pairing, or a
 * config the edit would make un-loadable). The Origin guard fronts the route by construction (POST).
 */
function routingEditResultToHttp(result: RoutingEditPortResult): RouteHttpResult {
  switch (result.kind) {
    case "applied":
      return jsonOk(routingEditResponseSchema, result.response);
    case "bad-request":
      return { status: 400, body: { error: result.error } };
  }
}

export class WebServer {
  private server: Server | null = null;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly auth: AuthMiddleware;
  /** JSON endpoints keyed by exact path; the auth + Origin seams run once above it. */
  private readonly routes: ReadonlyMap<string, ApiRoute>;

  constructor(private readonly deps: WebServerDeps) {
    this.allowedOrigins = new Set(deps.config.allowedOrigins);
    this.auth = deps.auth ?? allowAllAuth;
    // The route table owns per-endpoint method, query/body parsing, success schema parsing, and
    // domain-outcome-to-HTTP mapping. handleApi stays the common shell: auth, Origin guard, lookup,
    // dispatch, send. The live SSE route is the one exception because it streams.
    this.routes = new Map<string, ApiRoute>([
      [API_ROUTES.health, getJsonRoute(healthResponseSchema, () => deps.ports.health())],
      [
        API_ROUTES.overview,
        getJsonRoute(overviewResponseSchema, (req) => deps.ports.overview({ repo: readRepoFilter(parseQuery(req.url)) })),
      ],
      [
        API_ROUTES.analytics,
        getJsonRoute(analyticsResponseSchema, (req) => {
          const query = parseQuery(req.url);
          return deps.ports.analytics({ repo: readRepoFilter(query), windowDays: readWindowFilter(query) });
        }),
      ],
      [API_ROUTES.healthUsage, getJsonRoute(healthUsageResponseSchema, () => deps.ports.healthUsage())],
      [API_ROUTES.accounts, getJsonRoute(accountsResponseSchema, () => deps.ports.accounts())],
      [
        API_ROUTES.backlog,
        getJsonRoute(backlogResponseSchema, (req) => deps.ports.backlog({ repo: readRepoFilter(parseQuery(req.url)) })),
      ],
      [
        API_ROUTES.runs,
        getJsonRoute(runsResponseSchema, (req) => deps.ports.runs({ repo: readRepoFilter(parseQuery(req.url)) })),
      ],
      [
        API_ROUTES.run,
        getHttpRoute((req) => {
          const query = parseQuery(req.url);
          const repo = readRepoFilter(query);
          const issue = readIssueFilter(query);
          if (!repo || issue === undefined) {
            return { status: 400, body: { error: "repo and issue query params are required" } };
          }
          const detail = deps.ports.run({ repo, issue });
          return detail ? jsonOk(runDetailResponseSchema, detail) : { status: 404, body: { error: "no such run" } };
        }),
      ],
      [
        API_ROUTES.inbox,
        getJsonRoute(inboxResponseSchema, (req) => deps.ports.inbox({ repo: readRepoFilter(parseQuery(req.url)) })),
      ],
      [
        API_ROUTES.answer,
        postJsonRoute<AnswerRequestBody>({
          bodySchema: answerRequestBodySchema,
          invalidBodyMessage: "invalid answer body",
          handler: async (_req, body) => answerResultToHttp(await deps.ports.answer(body)),
        }),
      ],
      [
        API_ROUTES.action,
        postJsonRoute<PowerActionRequestBody>({
          bodySchema: powerActionRequestBodySchema,
          invalidBodyMessage: "invalid power-action body",
          handler: async (_req, body) => powerActionResultToHttp(await deps.ports.powerAction(body)),
        }),
      ],
      // Tier-2 daemon control (issue #118, ADR-0032): drain / force-tick / kill-run, all POST so
      // the Origin guard fronts them. The two destructive actions (drain, kill-run) require
      // `confirm: true` in their body schemas, so an accidental click cannot fire. Each calls the
      // DaemonControl port — never the reconciler, executor, or SDK sessions.
      [
        API_ROUTES.drain,
        postJsonRoute({
          bodySchema: drainRequestBodySchema,
          invalidBodyMessage: "drain requires { confirm: true }",
          handler: () => {
            deps.ports.control.drain();
            return jsonOk(drainResponseSchema, { generatedAt: new Date().toISOString(), draining: true });
          },
        }),
      ],
      [
        API_ROUTES.forceTick,
        postJsonRoute({
          bodySchema: forceTickRequestBodySchema,
          invalidBodyMessage: "invalid force-tick body",
          handler: () => {
            deps.ports.control.forceTick();
            return jsonOk(forceTickResponseSchema, { generatedAt: new Date().toISOString(), ticked: true });
          },
        }),
      ],
      [
        API_ROUTES.killRun,
        postJsonRoute({
          bodySchema: killRunRequestBodySchema,
          invalidBodyMessage: "kill-run requires { runId, confirm: true }",
          handler: (_req, body) => {
            const killed = deps.ports.control.killRun(Number(body.runId));
            return jsonOk(killRunResponseSchema, { generatedAt: new Date().toISOString(), runId: body.runId, killed });
          },
        }),
      ],
      // Runtime routing (ADR-0037 P4.1, issue #166): GET the effective routing, POST a set/clear.
      // The write is POST so the Origin guard fronts it; the capability gate rejects an invalid
      // pairing at the port (400). Mirrors the read/write split of inbox + backlog/action.
      [
        API_ROUTES.routing,
        getJsonRoute(effectiveRoutingResponseSchema, (req) =>
          deps.ports.routing({ repo: readRepoFilter(parseQuery(req.url)) }),
        ),
      ],
      [
        API_ROUTES.routingEdit,
        postJsonRoute<RoutingEditRequestBody>({
          bodySchema: routingEditRequestBodySchema,
          invalidBodyMessage: "invalid routing edit body",
          handler: (_req, body) => routingEditResultToHttp(deps.ports.applyRouting(body)),
        }),
      ],
      [API_ROUTES.webpushVapid, getJsonRoute(vapidPublicKeyResponseSchema, () => deps.ports.webpushVapid())],
      [
        API_ROUTES.webpushSubscribe,
        postJsonRoute<SubscribeRequestBody>({
          bodySchema: subscribeRequestBodySchema,
          invalidBodyMessage: "invalid webpush subscribe body",
          handler: async (_req, body) => subscribeResultToHttp(await deps.ports.webpushSubscribe(body)),
        }),
      ],
      [
        API_ROUTES.webpushUnsubscribe,
        postJsonRoute<UnsubscribeRequestBody>({
          bodySchema: unsubscribeRequestBodySchema,
          invalidBodyMessage: "invalid webpush unsubscribe body",
          handler: async (_req, body) => unsubscribeResultToHttp(await deps.ports.webpushUnsubscribe(body)),
        }),
      ],
    ]);
  }

  /** The bound `host:port` once listening (for logging/tests), or `null` before start. */
  url(): string | null {
    return this.server ? `http://${this.deps.config.host}:${this.deps.config.port}` : null;
  }

  /** The actual bound TCP port (resolves an ephemeral `port: 0` for tests), or `null`. */
  boundPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  /**
   * Begin listening. Resolves once the socket is bound; rejects on a bind error
   * (e.g. port in use) so the caller can log-and-continue — a web bind failure must
   * never abort daemon startup (ADR-0029). Binding to a non-loopback host emits a
   * loud exposure warning (ADR-0032), but is permitted; loopback is the default.
   */
  start(): Promise<void> {
    const { config, logger } = this.deps;
    if (!isLoopbackHost(config.host)) {
      logger.warn("web.exposure-warning", {
        host: config.host,
        reason:
          "control plane bound to a non-loopback address — there is no managed auth in front of it; rely on Tailscale/firewall for access control (ADR-0032)",
      });
    }
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        this.server = null;
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        // Never let the web socket hold the event loop open past a drain.
        server.unref();
        logger.info("web.listening", { url: this.url(), staticDir: config.staticDir });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });
  }

  /** Stop listening (best-effort, fast). Resolves when the socket is closed. */
  stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return Promise.resolve();
    }
    this.server = null;
    return new Promise<void>((resolve) => {
      // Drop keep-alive sockets so close() does not hang on idle connections.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = req.url ?? "/";
      const path = url.split("?")[0] ?? "/";

      if (path === API_BASE || path.startsWith(API_BASE + "/")) {
        // The API dispatch is async (the Inbox read + the answer write await ports that reach
        // GitHub), so a rejected promise must be caught here rather than escape as an unhandled
        // rejection — mirroring the sync try/catch around the static path below (ADR-0029).
        this.handleApi(req, res, path).catch((err) => this.fail(res, req, err));
        return;
      }

      // Everything else is the SPA. Only read methods serve static content.
      if (!isSafeMethod(req.method)) {
        this.send(res, 405, { error: "method not allowed" });
        return;
      }
      const served = serveStatic(this.deps.config.staticDir, path, res, this.deps.logger);
      if (!served) {
        // The UI was not built into staticDir — keep the box reachable with a hint
        // rather than 404ing the operator (the build gate normally prevents this).
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><meta charset=utf-8><title>ralph-autopilot</title>" +
            "<body style=\"font:14px system-ui;padding:2rem;max-width:42rem;margin:auto\">" +
            "<h1>ralph-autopilot control plane</h1>" +
            `<p>The API is live, but no built SPA was found at <code>${escapeHtml(this.deps.config.staticDir)}</code>.</p>` +
            "<p>Run <code>npm run build</code> (which builds the <code>web/</code> workspace) and reload.</p>",
        );
      }
    } catch (err) {
      this.fail(res, req, err);
    }
  }

  /**
   * The single request-failure path: log, then 500 if the headers are unsent (or just
   * end the response if they are). Shared by the sync `handle` catch and the async
   * `handleApi` promise catch so the two paths cannot drift.
   */
  private fail(res: ServerResponse, req: IncomingMessage, err: unknown): void {
    this.deps.logger.error("web.request-failed", { url: req.url, error: String(err) });
    if (!res.headersSent) {
      this.send(res, 500, { error: "internal error" });
    } else {
      res.end();
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    // Seam 1: auth (reserved; default allow-all — Tailscale is the boundary).
    const verdict = this.auth(req);
    if (!verdict.ok) {
      this.send(res, verdict.status ?? 401, { error: verdict.message ?? "unauthorized" });
      return;
    }

    // Seam 2: Origin guard on mutating requests (ADR-0032). Every unsafe method reaches the
    // same guard before route dispatch, so write routes are protected by construction.
    if (!isSafeMethod(req.method)) {
      const allowed = isOriginAllowed(req.headers.origin, {
        host: req.headers.host,
        allowedOrigins: this.allowedOrigins,
      });
      if (!allowed) {
        this.deps.logger.warn("web.origin-rejected", { origin: req.headers.origin, path });
        this.send(res, 403, { error: "cross-origin request rejected" });
        return;
      }
    }

    if (path === API_ROUTES.live) {
      if (!isSafeMethod(req.method)) {
        this.send(res, 405, { error: "method not allowed" });
        return;
      }
      // A long-lived SSE stream — it owns its own response lifecycle (no `this.send`),
      // and a stalled client is bounded by the broadcast channel, never the daemon. It
      // is not a dispatch-table read route because it does not parse-and-send JSON.
      handleLiveSse(req, res, this.deps.ports.live, this.deps.logger);
      return;
    }

    const route = this.routes.get(path);
    if (route) {
      if (!routeAllowsMethod(route.method, req.method)) {
        this.send(res, 405, { error: "method not allowed" });
        return;
      }
      const result = await route.dispatch(req, (request) => this.readJsonBody(request));
      this.send(res, result.status, result.body);
      return;
    }

    this.send(res, 404, { error: "not found" });
  }

  /**
   * Read + JSON-parse a mutating request's body. Capped at 1 MiB so a client cannot stream an
   * unbounded body at the loopback server; a missing/empty/malformed body is reported as a 400
   * error rather than thrown, so the answer route maps it directly without hitting the async
   * catch-all 500.
   */
  private async readJsonBody(
    req: IncomingMessage,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    let data = "";
    try {
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 1_000_000) {
          req.destroy();
          return { ok: false, error: "request body too large" };
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "failed to read body" };
    }
    if (data.length === 0) {
      return { ok: false, error: "empty request body" };
    }
    try {
      return { ok: true, value: JSON.parse(data) };
    } catch {
      return { ok: false, error: "malformed JSON body" };
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(json);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/**
 * Parse a request URL's query against a dummy base (so a relative request URL resolves)
 * and return its params; a malformed URL yields `undefined`. The single parse + try/catch
 * both the `?repo=` and `?window=` readers draw from, so a handler parses each request once.
 */
function parseQuery(url: string | undefined): URLSearchParams | undefined {
  try {
    return new URL(url ?? "/", "http://localhost").searchParams;
  } catch {
    return undefined;
  }
}

/**
 * Read the `?repo=<owner/name>` overview filter from the parsed query. A missing or
 * empty value yields `undefined` — the all-repos aggregate; the client encodes
 * 'aggregate' by omitting the param, so the backend stays oblivious to any UI sentinel.
 */
function readRepoFilter(query: URLSearchParams | undefined): string | undefined {
  const repo = query?.get("repo");
  return repo && repo.length > 0 ? repo : undefined;
}

/**
 * Read the `?window=<days>` analytics window from the parsed query as a raw number; the
 * port clamps/defaults it (`resolveWindowDays`), so a missing, empty, or non-numeric
 * value yields `undefined` (the default window).
 */
function readWindowFilter(query: URLSearchParams | undefined): number | undefined {
  const raw = query?.get("window");
  if (raw === null || raw === undefined || raw.length === 0) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the `?issue=<n>` run-detail key from the parsed query as a 1-based issue number, or
 * `undefined` for a missing / non positive-integer value (the run-detail route then 400s).
 */
function readIssueFilter(query: URLSearchParams | undefined): number | undefined {
  const raw = query?.get("issue");
  if (raw === null || raw === undefined || raw.length === 0) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
