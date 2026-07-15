/**
 * The **dispatch edge** of the notification sink (issue #117): turns notification
 * requests into best-effort HTTP POSTs to the configured ntfy/webhook endpoints.
 *
 * The binding contract is **fire-and-forget, never block, never throw** — the sink rides
 * the after-commit broadcast channel's microtask drain (ADR-0029), so `dispatch` is
 * synchronous and returns the instant every request is *launched*; the actual network
 * calls are detached promises whose settlement can never reach the caller. A rejecting or
 * synchronously-throwing fetch is swallowed and logged, and one broken endpoint never
 * stops the others (per-call isolation).
 *
 * The bearer token is resolved here from the configured env-var NAME (the ADR-0034
 * precedent — config never carries a credential) and handed to the pure formatters, so
 * the wire shape stays exhaustively unit-tested in {@link import("./format").format}.
 */
import type { Logger } from "../log/logger";
import type { NotificationEndpoint } from "../config/schema";
import { formatNtfyDispatch, formatWebhookDispatch, type HttpDispatch } from "./format";
import type { NotificationRequest } from "./types";

/** The `fetch` init shape the dispatcher passes (a strict subset of `RequestInit`). */
export interface FetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** A minimal `fetch`-shaped port: URL + init → a promise of a response. */
export type FetchPort = (url: string, init: FetchInit) => Promise<Response>;

/**
 * Resolve the node-global `fetch` lazily (at dispatch time, not module-load). Reading it
 * once at load would capture whatever `globalThis.fetch` was at import — missing a
 * runtime polyfill or a test's `globalThis.fetch` mock — so resolve it when a dispatch
 * actually fires. Returns `null` on a runtime with no global `fetch`.
 */
function resolveGlobalFetch(): FetchPort | null {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
}

export interface NotificationDispatcherDeps {
  /** The configured delivery endpoints (fan-out: each request hits every endpoint). */
  endpoints: NotificationEndpoint[];
  /** The fetch port; defaults to the node-global `fetch` (resolved lazily at dispatch). */
  fetch?: FetchPort;
  /** Structured logger for best-effort dispatch diagnostics (never fatal). */
  logger: Logger;
  /** Read an env var by name; defaults to `process.env`. Injected under test. */
  readEnv?: (name: string) => string | undefined;
}

export class NotificationDispatcher {
  private readonly endpoints: NotificationEndpoint[];
  private readonly fetch: FetchPort | null;
  private readonly logger: Logger;
  private readonly readEnv: (name: string) => string | undefined;

  constructor(deps: NotificationDispatcherDeps) {
    this.endpoints = deps.endpoints;
    // `undefined` (the default) → resolve the global lazily at dispatch time; an
    // explicit `null` would also fall through to the lazy global. Injected under test.
    this.fetch = deps.fetch ?? null;
    this.logger = deps.logger;
    this.readEnv = deps.readEnv ?? ((name) => process.env[name]);
  }

  /**
   * Launch one HTTP POST per (request × endpoint) and return immediately — the network
   * calls settle on detached promises. Never throws, never blocks. A missing `fetch`
   * (no injected port and no `globalThis.fetch`) logs once and drops the batch rather
   * than crashing.
   */
  dispatch(requests: NotificationRequest[]): void {
    if (requests.length === 0 || this.endpoints.length === 0) {
      return;
    }
    const fetch = this.fetch ?? resolveGlobalFetch();
    if (fetch === null) {
      this.logger.warn("notify.no-fetch", { endpoints: this.endpoints.length, count: requests.length });
      return;
    }
    for (const r of requests) {
      for (const endpoint of this.endpoints) {
        this.launch(r, endpoint, fetch);
      }
    }
  }

  /** Format + fire one POST, swallowing any synchronous throw or rejected promise. */
  private launch(r: NotificationRequest, endpoint: NotificationEndpoint, fetch: FetchPort): void {
    const token = endpoint.tokenEnv ? this.readEnv(endpoint.tokenEnv) ?? null : null;
    const dispatch: HttpDispatch =
      endpoint.kind === "ntfy"
        ? formatNtfyDispatch(r, endpoint, token)
        : formatWebhookDispatch(r, endpoint, token);
    let pending: Promise<Response>;
    try {
      pending = fetch(dispatch.url, { method: dispatch.method, headers: dispatch.headers, body: dispatch.body });
    } catch {
      this.logger.warn("notify.dispatch-failed", {
        kind: r.kind,
        ...endpointLogFields(endpoint),
        failure: "fetch-threw",
      });
      return;
    }
    // Detached: the settlement never reaches the caller (the broadcast drain / tick).
    void pending.catch(() => {
      this.logger.warn("notify.dispatch-failed", {
        kind: r.kind,
        ...endpointLogFields(endpoint),
        failure: "fetch-rejected",
      });
    });
  }
}

function endpointLogFields(endpoint: NotificationEndpoint): { endpoint: string; endpointHost: string | null } {
  return {
    endpoint: endpoint.kind,
    endpointHost: hostnameOf(endpoint.url),
  };
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
