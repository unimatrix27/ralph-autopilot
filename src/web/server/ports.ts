/**
 * The ports the web layer reads through (ADR-0029 isolation contract: "the web
 * layer depends only on ports"). The embedded server never reaches into daemon
 * internals — the reconciler, store, or SDK sessions — it only calls these
 * pure-read functions, so a web fault cannot wedge the loop and the server stays
 * trivially testable with a fake.
 *
 * The foundations slice needs exactly one: process health. Later slices widen this
 * interface (snapshot reads over `buildSnapshot`, run/transcript projections, the
 * write ports) — always as additive methods here, never as new reach-ins.
 */
import type {
  AccountsResponse,
  AnalyticsResponse,
  AnswerRequestBody,
  BacklogResponse,
  EffectiveRoutingResponse,
  HealthResponse,
  HealthUsageResponse,
  InboxResponse,
  OverviewResponse,
  PowerActionRequestBody,
  RoutingEditRequestBody,
  RunDetailResponse,
  RunsResponse,
  SubscribeRequestBody,
  UnsubscribeRequestBody,
  VapidPublicKeyResponse,
} from "../contract";
import type { AnswerPortResult } from "../inbox";
import type { LiveFeedPort } from "../../store/live-feed";
export type { LiveFeedPort } from "../../store/live-feed";
import type { PowerActionPortResult } from "../power-actions";
import type { RoutingEditPortResult } from "../routing-actions";
import type { DaemonControl } from "../../daemon/control";
export type { DaemonControl } from "../../daemon/control";

/** Options for the overview read; `repo` narrows every section to one target (issue #108). */
export interface OverviewQuery {
  /** Narrow every section to this repo; omit for the aggregate (all-repos) view. */
  repo?: string;
}

/** Options for the analytics read; `repo` narrows every metric, `windowDays` selects the window (issue #115). */
export interface AnalyticsQuery {
  /** Narrow every metric to this repo; omit for the aggregate (all-repos) view. */
  repo?: string;
  /** The trend window in days; resolved/clamped by the port (`resolveWindowDays`). Omit for the default. */
  windowDays?: number;
}

/** Options for the backlog read; `repo` narrows every section to one target (issue #113). */
export interface BacklogQuery {
  /** Narrow every section to this repo; omit for the aggregate (all-repos) view. */
  repo?: string;
}

/** Options for the runs-index read; `repo` narrows the list to one target (issue #111). */
export interface RunsQuery {
  /** Narrow the list to this repo; omit for the aggregate (all-repos) view. */
  repo?: string;
}

/** The key of one run for the run-detail read (issue #111): one run per (repo, issue). */
export interface RunQuery {
  repo: string;
  issue: number;
}

/** Options for the Inbox read (issue #112); `repo` narrows the list to one target. */
export interface InboxQuery {
  /** Narrow the list to this repo; omit for the aggregate (all-repos) view. */
  repo?: string;
}

/**
 * Options for the effective-routing read (ADR-0037 P4.1); `repo` is accepted for forward-compatible
 * per-repo deviation (#170) but ignored in v1 — every repo resolves the global routing.
 */
export interface RoutingQuery {
  /** Forward-compat per-repo key (#170); echoed back, but v1 always resolves the global routing. */
  repo?: string;
}

export interface WebControlPlanePorts {
  /**
   * Process liveness + identity for `/api/health`. A pure read computed at call
   * time (so `uptimeSeconds` is current); it touches nothing the reconcile tick
   * owns.
   */
  health(): HealthResponse;

  /**
   * The operator Overview for `/api/overview` (issue #108): a thin serialization of
   * `buildSnapshot` (the read edge adds no decision logic, ADR-0029). A pure read
   * over the store — it never touches the reconciler or SDK sessions. `query.repo`
   * narrows every section; omitted, it aggregates across all repos.
   */
  overview(query: OverviewQuery): OverviewResponse;

  /**
   * The live event feed for `/api/live` (issue #109): catch-up by `global_position`
   * cursor then a live subscription. A pure edge over the event log + the in-process
   * broadcast — it never touches the reconciler or SDK sessions, and a stalled SSE
   * client is bounded by the broadcast channel, never the append path (ADR-0029).
   */
  live: LiveFeedPort;

  /**
   * The analytics trends for `/api/analytics` (issue #115): throughput,
   * mean-time-to-merge, the anomaly trend, and the fix-attempt / escalation /
   * review-maxed distributions — a thin serialization of the pure
   * {@link import("../analytics").computeAnalytics} over the durable run-log history
   * (ADR-0029). `query.repo` narrows every metric; `query.windowDays` selects the
   * window. A pure read over the store — it never touches the reconciler or SDK sessions.
   */
  analytics(query: AnalyticsQuery): AnalyticsResponse;

  /**
   * Daemon health + usage for `/api/health/usage` (issue #116): liveness, the
   * surfaced anomalies with their logged reason, and the ADR-0028 dual-login usage.
   * A pure read over the store + a read-only usage-meter snapshot — it never flips the
   * active login or touches the reconciler. Daemon-wide, so it takes no repo filter.
   */
  healthUsage(): HealthUsageResponse;

  /**
   * The account panel for `/api/accounts` (issue #11): every resolved pool account with its
   * identity (claude OAuth email/name/org, read daemon-side at projection time and omitted on
   * graceful absence), operator-park state (#10), and live plan usage joined by account id. A pure
   * read over the routing overlay + a usage-meter snapshot + the daemon-side profile read — it
   * never flips the active login or touches the reconciler. Daemon-wide, so it takes no repo
   * filter. Carries no secret material (no keys, tokens, or env-var values).
   */
  accounts(): AccountsResponse;

  /**
   * The operator Backlog for `/api/backlog` (issue #113): eligible (in the daemon's
   * pick-order), blocked (with a dependency mini-graph), paused (grouped by attention
   * state), and moding-pass candidates. Like {@link overview} it is a thin
   * serialization of `buildSnapshot` (ADR-0029) — a pure read over the store.
   * `query.repo` narrows every section; omitted, it aggregates across all repos.
   */
  backlog(query: BacklogQuery): BacklogResponse;

  /**
   * The run history index for `/api/runs` (issue #111): every run newest-first, each a link
   * into the run-detail viewer. A thin serialization of the run rows (ADR-0029) — a pure
   * read over the store. `query.repo` narrows the list; omitted, it aggregates across repos.
   */
  runs(query: RunsQuery): RunsResponse;

  /**
   * One run's detail + transcript for `/api/run` (issue #111): the run header, the permanent
   * domain timeline, and the verbose/prunable transcript. A pure read over the store — the
   * run row, its issue stream, and its transcript stream. Returns `null` when no run exists
   * for the (repo, issue) so the server can answer 404.
   */
  run(query: RunQuery): RunDetailResponse | null;

  /**
   * The Inbox for `/api/inbox` (issue #112): every open `ralph-answer` question across the
   * configured repos, oldest-first, each enriched with its consequence + run deep links. A read
   * over GitHub (the queue's source of truth, ADR-0007) plus a run lookup over the store — it
   * never touches the reconciler or SDK sessions. `query.repo` narrows the list; omitted, it
   * aggregates across all repos.
   */
  inbox(query: InboxQuery): Promise<InboxResponse>;

  /**
   * Answer one open question for `/api/inbox/answer` (issue #112): the first write path. Resolves
   * the operator's structured choice against the live question (re-fetched from GitHub) and submits
   * through `RalphAnswerService` verbatim — the `ralph-answer` comment + the label swap back to
   * `ready-for-agent`. The reconciler resumes/re-admits next tick (ADR-0032). Returns the
   * {@link AnswerPortResult}: `answered`, `no-open-question`, or `invalid-answer`. Never throws on
   * a bad request — the HTTP adapter maps the domain outcome to a status.
   */
  answer(body: AnswerRequestBody): Promise<AnswerPortResult>;

  /**
   * Apply one Tier-1 power action for `/api/backlog/action` (issue #114, ADR-0032): re-admit / close
   * / set `mode:*` / set priority / pause / unpause. The action is an on-protocol GitHub write:
   * it plans label adds/removes (or the destructive close) against the live issue (re-fetched from
   * GitHub), and readmitting an answerable pause goes through `RalphAnswerService` so the
   * `ralph-answer` correlation payload exists before the label swap. The reconciler acts on
   * the new GitHub state next tick (eventually-consistent — the UI states "acts next tick (~Ns)"). The
   * destructive `close` requires `confirm: true` in the body (enforced at the contract edge). Returns
   * the {@link PowerActionPortResult}: `applied`, `bad-request`, or `not-found`. Never throws on a
   * bad request — the HTTP adapter maps the domain outcome to a status.
   */
  powerAction(body: PowerActionRequestBody): Promise<PowerActionPortResult>;

  /**
   * The effective routing for `/api/routing` (ADR-0037 P4.1, issue #166): every agent type's
   * resolved `(provider, model)` preference list, the provider capability matrix, and the
   * account-pool summary — a pure read of the runtime routing overlay. `query.repo` is accepted
   * for forward-compatible per-repo deviation (#170) but ignored in v1 (the global routing).
   */
  routing(query: RoutingQuery): EffectiveRoutingResponse;

  /**
   * Set or clear one agent type's preference list for `/api/routing/edit` (ADR-0037 P4.1): the
   * runtime routing write. The change lands in the in-memory overlay route resolution reads each
   * dispatch AND writes through to `config.yaml`; effect is the next dispatch (an in-flight
   * container is unaffected). The overlay validates the capability gate + full reload at the edge,
   * so a capability-invalid pairing (e.g. `impl → openai`) returns `bad-request`. Origin-guarded
   * by construction (POST routes through the guard). Returns the {@link RoutingEditPortResult}:
   * `applied` or `bad-request`. Never throws on a bad request — the HTTP adapter maps the outcome.
   */
  applyRouting(body: RoutingEditRequestBody): RoutingEditPortResult;

  /**
   * Tier-2 daemon control (issue #118, ADR-0032): drain / force-tick / kill-run. Implemented
   * by the orchestrator — the web layer calls it and never reaches reconciler internals, the
   * SDK sessions, or the executor's abort handles. The `/api/daemon/*` routes are its only
   * callers; drain and kill-run require an explicit `confirm` and all three are Origin-guarded
   * by construction (POST routes through the guard).
   */
  control: DaemonControl;
  /**
   * The VAPID public key for `/api/webpush/vapid` (issue #119): whether push is configured, and the
   * base64url uncompressed application-server public key the browser subscribes with. Returns
   * `enabled: false` (null key) when the daemon has no VAPID identity — a read-only pure lookup.
   */
  webpushVapid(): VapidPublicKeyResponse;

  /**
   * Register a device's `PushSubscription` for `/api/webpush/subscribe` (issue #119): persist it so
   * pushes survive a daemon restart. Origin-guarded by the server (ADR-0032); this port only writes
   * the durable subscription. Never throws on a bad request — returns a domain outcome the HTTP
   * adapter maps. `disabled` when push is not configured.
   */
  webpushSubscribe(body: SubscribeRequestBody): Promise<WebPushSubscribeResult>;

  /**
   * Drop a device's subscription for `/api/webpush/unsubscribe` (issue #119). `ok` whether or not a
   * matching subscription existed. Origin-guarded by the server (ADR-0032).
   */
  webpushUnsubscribe(body: UnsubscribeRequestBody): Promise<WebPushUnsubscribeResult>;
}

/** The domain outcome of a subscribe attempt — the HTTP adapter maps each branch to a status. */
export type WebPushSubscribeResult =
  | { kind: "subscribed"; response: { ok: true; endpoint: string } }
  | { kind: "disabled"; error: string };

/** The domain outcome of an unsubscribe attempt — always succeeds (idempotent). */
export type WebPushUnsubscribeResult = { kind: "unsubscribed" };
