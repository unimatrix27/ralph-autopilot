/**
 * The browser-side API client. Every shape it returns is parsed through the shared
 * **contract leaf** (`@contract`, ADR-0031), so a server/client drift is a parse
 * error here, not a silent mis-render. The foundations slice has one read endpoint
 * (`/api/health`); slices 1+ add fetchers here over the same contract.
 */
import {
  analyticsResponseSchema,
  API_ROUTES,
  answerResponseSchema,
  backlogResponseSchema,
  drainResponseSchema,
  effectiveRoutingResponseSchema,
  forceTickResponseSchema,
  healthResponseSchema,
  healthUsageResponseSchema,
  inboxResponseSchema,
  killRunResponseSchema,
  overviewResponseSchema,
  powerActionResponseSchema,
  routingEditResponseSchema,
  runDetailResponseSchema,
  runsResponseSchema,
  subscribeResponseSchema,
  unsubscribeResponseSchema,
  vapidPublicKeyResponseSchema,
  type AnalyticsResponse,
  type AnswerRequestBody,
  type AnswerResponse,
  type BacklogResponse,
  type DrainResponse,
  type EffectiveRoutingResponse,
  type ForceTickResponse,
  type HealthResponse,
  type HealthUsageResponse,
  type InboxResponse,
  type KillRunResponse,
  type OverviewResponse,
  type PowerActionRequestBody,
  type PowerActionResponse,
  type RoutingEditRequestBody,
  type RoutingEditResponse,
  type RunDetailResponse,
  type RunsResponse,
  type SubscribeRequestBody,
  type SubscribeResponse,
  type UnsubscribeRequestBody,
  type UnsubscribeResponse,
  type VapidPublicKeyResponse,
} from "@contract";

async function getJson<T>(path: string, parse: (raw: unknown) => T): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${res.statusText}`);
  }
  return parse(await res.json());
}

async function postJson<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Error responses carry `{ error: <reason> }` (the server's clear edge message — e.g. why a
    // routing/account edit was rejected); surface that reason rather than a bare status line.
    const reason = await res
      .json()
      .then((raw: unknown) =>
        raw !== null && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string"
          ? (raw as { error: string }).error
          : null,
      )
      .catch(() => null);
    throw new Error(reason ?? `${path} → ${res.status} ${res.statusText}`);
  }
  return parse(await res.json());
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson(API_ROUTES.health, (raw) => healthResponseSchema.parse(raw));
}

/**
 * Fetch the operator Overview, aggregate across all repos (or narrowed to `repo`).
 * Parsed through the shared contract leaf so a server/client drift surfaces here.
 */
export function fetchOverview(repo?: string): Promise<OverviewResponse> {
  const path = repo ? `${API_ROUTES.overview}?repo=${encodeURIComponent(repo)}` : API_ROUTES.overview;
  return getJson(path, (raw) => overviewResponseSchema.parse(raw));
}

/**
 * Fetch the analytics trends, aggregate across all repos (or narrowed to `repo`) over a
 * `windowDays`-day window. Parsed through the shared contract leaf so a server/client
 * drift surfaces here.
 */
export function fetchAnalytics(repo: string | undefined, windowDays: number): Promise<AnalyticsResponse> {
  const params = new URLSearchParams({ window: String(windowDays) });
  if (repo) {
    params.set("repo", repo);
  }
  return getJson(`${API_ROUTES.analytics}?${params.toString()}`, (raw) => analyticsResponseSchema.parse(raw));
}

/**
 * Fetch the daemon health + usage view (issue #116): liveness, surfaced anomalies with
 * their logged reason, and the ADR-0028 dual-login usage. Daemon-wide — no repo filter.
 * Parsed through the shared contract leaf so a server/client drift surfaces here.
 */
export function fetchHealthUsage(): Promise<HealthUsageResponse> {
  return getJson(API_ROUTES.healthUsage, (raw) => healthUsageResponseSchema.parse(raw));
}

/**
 * Fetch the operator Backlog, aggregate across all repos (or narrowed to `repo`):
 * eligible (in pick-order), blocked (with dep mini-graph), paused, and moding-pass
 * candidates. Parsed through the shared contract leaf so a drift surfaces here.
 */
export function fetchBacklog(repo?: string): Promise<BacklogResponse> {
  const path = repo ? `${API_ROUTES.backlog}?repo=${encodeURIComponent(repo)}` : API_ROUTES.backlog;
  return getJson(path, (raw) => backlogResponseSchema.parse(raw));
}

/**
 * Fetch the run history index (issue #111), newest-first, aggregate across all repos (or
 * narrowed to `repo`). Parsed through the shared contract leaf so a drift surfaces here.
 */
export function fetchRuns(repo?: string): Promise<RunsResponse> {
  const path = repo ? `${API_ROUTES.runs}?repo=${encodeURIComponent(repo)}` : API_ROUTES.runs;
  return getJson(path, (raw) => runsResponseSchema.parse(raw));
}

/**
 * Fetch one run's detail + transcript (issue #111), keyed by its (repo, issue). Parsed
 * through the shared contract leaf so a server/client drift surfaces here.
 */
export function fetchRunDetail(repo: string, issue: number): Promise<RunDetailResponse> {
  const params = new URLSearchParams({ repo, issue: String(issue) });
  return getJson(`${API_ROUTES.run}?${params.toString()}`, (raw) => runDetailResponseSchema.parse(raw));
}

/**
 * Fetch the Inbox (issue #112): every open escalation across repos, oldest-first. Parsed through
 * the shared contract leaf so a server/client drift surfaces here.
 */
export function fetchInbox(repo?: string): Promise<InboxResponse> {
  const path = repo ? `${API_ROUTES.inbox}?repo=${encodeURIComponent(repo)}` : API_ROUTES.inbox;
  return getJson(path, (raw) => inboxResponseSchema.parse(raw));
}

/**
 * Submit an answer to one open question (issue #112): the first write path. Same-origin by
 * construction (the SPA is served by the control plane itself), so the browser's automatic
 * `Origin` header clears the Origin guard; a cross-site page POSTing here is rejected by the
 * server. Parsed through the shared contract leaf so a drift surfaces here.
 */
export async function submitAnswer(body: AnswerRequestBody): Promise<AnswerResponse> {
  return postJson(API_ROUTES.answer, body, (raw) => answerResponseSchema.parse(raw));
}

/**
 * Force a reconcile round now (issue #118): cuts the daemon's inter-tick sleep short so the
 * next tick runs immediately. Non-destructive, so no confirm. Same-origin by construction.
 */
export async function forceTickDaemon(): Promise<ForceTickResponse> {
  return postJson(API_ROUTES.forceTick, {}, (raw) => forceTickResponseSchema.parse(raw));
}

/**
 * Begin a graceful drain (issue #118): no new pickups, in-flight runs finish, then the daemon
 * exits. Destructive — the UI confirms before firing, and the server requires `confirm: true`.
 */
export async function drainDaemon(): Promise<DrainResponse> {
  return postJson(API_ROUTES.drain, { confirm: true }, (raw) => drainResponseSchema.parse(raw));
}

/**
 * Kill one in-flight run by run id (issue #118): tears down its live session. Destructive —
 * the UI confirms, and the server requires `confirm: true`. Returns whether a live session was
 * found and aborted (`killed: false` means the run had already settled).
 */
export async function killRun(runId: string): Promise<KillRunResponse> {
  return postJson(API_ROUTES.killRun, { runId, confirm: true }, (raw) => killRunResponseSchema.parse(raw));
}

/** Fetch the daemon's VAPID identity: whether push is configured + the public key to subscribe with. */
export function fetchVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  return getJson(API_ROUTES.webpushVapid, (raw) => vapidPublicKeyResponseSchema.parse(raw));
}

/** Register this device's browser PushSubscription with the daemon so it can page this device. */
export function subscribeWebPush(body: SubscribeRequestBody): Promise<SubscribeResponse> {
  return postJson(API_ROUTES.webpushSubscribe, body, (raw) => subscribeResponseSchema.parse(raw));
}

/** Drop this device's browser PushSubscription from the daemon. Idempotent server-side. */
export function unsubscribeWebPush(body: UnsubscribeRequestBody): Promise<UnsubscribeResponse> {
  return postJson(API_ROUTES.webpushUnsubscribe, body, (raw) => unsubscribeResponseSchema.parse(raw));
}

/**
 * Apply one Tier-1 power action (issue #114, ADR-0032): re-admit / close / set `mode:*` / set
 * priority / pause / unpause. Same-origin by construction (the SPA is served by the control plane
 * itself), so the browser's automatic `Origin` header clears the Origin guard. The action is an
 * on-protocol label effect the reconciler acts on next tick — parsed through the shared contract
 * leaf so a server/client drift surfaces here. A non-2xx (e.g. a 400 for an unconfigured priority,
 * a 404 for a missing issue) throws so the caller can surface it.
 */
export async function postPowerAction(body: PowerActionRequestBody): Promise<PowerActionResponse> {
  const res = await fetch(API_ROUTES.action, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${API_ROUTES.action} → ${res.status} ${res.statusText}`);
  }
  return powerActionResponseSchema.parse(await res.json());
}

/**
 * Fetch the effective routing (ADR-0037 P4.2, issue #167): every agent type's resolved
 * `(provider, model)` preference list, the provider capability matrix, and the account-pool
 * summary — the read side of the global routing editor. `?repo=` is accepted for forward-compatible
 * per-repo deviation (#170) but ignored in v1 (the patch is empty, so every repo resolves the global
 * routing). Parsed through the shared contract leaf so a server/client drift surfaces here.
 */
export function fetchRouting(repo?: string): Promise<EffectiveRoutingResponse> {
  const path = repo ? `${API_ROUTES.routing}?repo=${encodeURIComponent(repo)}` : API_ROUTES.routing;
  return getJson(path, (raw) => effectiveRoutingResponseSchema.parse(raw));
}

/**
 * Set or clear one agent type's `(provider, model)` preference list (ADR-0037 P4.2). Same-origin by
 * construction (the SPA is served by the control plane itself), so the browser's automatic `Origin`
 * header clears the Origin guard; a cross-site page POSTing here is rejected by the server. The edit
 * lands in the runtime overlay AND writes through to `config.yaml`; effect is the **next** dispatch
 * (the response carries the honest `appliesNextDispatchSeconds`). A capability-invalid pairing (e.g.
 * `impl → openai`) is rejected 400 by the store's gate, which throws here so the caller can surface it.
 */
export async function postRoutingEdit(body: RoutingEditRequestBody): Promise<RoutingEditResponse> {
  return postJson(API_ROUTES.routingEdit, body, (raw) => routingEditResponseSchema.parse(raw));
}
