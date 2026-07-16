/**
 * API route paths — the URL contract shared by daemon and UI (ADR-0031). Naming
 * them once here means a renamed endpoint is a compile error on both sides, not a
 * silent 404. Mutating routes (the future write tier, ADR-0032) sit under
 * {@link API_BASE} too and are the ones the Origin guard fronts.
 */

/** Everything the control plane serves lives under this prefix; the SPA owns the rest. */
export const API_BASE = "/api" as const;

/** The read endpoints exposed so far. Slices 1+ extend this object, never the prefix. */
export const API_ROUTES = {
  /** Liveness + identity of the daemon process serving the SPA. */
  health: `${API_BASE}/health`,
  /**
   * The operator Overview: "needs you" band, fleet, funnel, recent activity —
   * aggregate across all repos. A `?repo=<owner/name>` query narrows every section
   * (the response still carries the full repo list for the filter).
   */
  overview: `${API_BASE}/overview`,
  /**
   * The live SSE stream (ADR-0029, issue #109): one `text/event-stream` frame per
   * committed log event ({@link import("./live").LiveEvent}). A client (re)connects with
   * a `global_position` cursor — `?cursor=<n>` or the `Last-Event-ID` header — to catch
   * up from there, then receives live events; no cursor starts "from now". Replaces
   * polling for the Fleet wall + live attention badges.
   */
  live: `${API_BASE}/live`,
  /**
   * Trends over time (issue #115): throughput, mean-time-to-merge, anomaly trend, and
   * the fix-attempt / escalation / review-maxed distributions. Aggregate across all
   * repos; `?repo=<owner/name>` narrows every metric and `?window=<days>` selects the
   * window (the response echoes the resolved window + the full repo list).
   */
  analytics: `${API_BASE}/analytics`,
  /**
   * Daemon health + usage (issue #116): liveness (uptime, ticks, stale, in-flight,
   * cap), surfaced anomalies with their logged reason, and the ADR-0028 dual-login
   * usage / plan-budget / cooldowns. The richer companion to the liveness `health`
   * probe — daemon-wide, so it takes no `?repo=` filter.
   */
  healthUsage: `${API_BASE}/health/usage`,
  /**
   * The account panel (issue #11): every resolved pool account with its identity (claude
   * OAuth email/name/org, read daemon-side and omitted on graceful absence), operator-park
   * state (#10), and live plan usage joined by account id. Daemon-wide — a credential is a
   * box credential, not per-target — so it takes no `?repo=` filter. Carries no secret material.
   */
  accounts: `${API_BASE}/accounts`,
  /**
   * The Backlog: eligible (in pick-order), blocked (with a dependency mini-graph),
   * paused (grouped by attention state), and moding-pass candidates — aggregate
   * across all repos. A `?repo=<owner/name>` query narrows every section.
   */
  backlog: `${API_BASE}/backlog`,
  /**
   * The run history index (issue #111): every run across all repos, newest-first, each a
   * link into the run-detail viewer. A `?repo=<owner/name>` query narrows the list; the
   * response still carries the full repo list for the filter.
   */
  runs: `${API_BASE}/runs`,
  /**
   * One run's detail + transcript (issue #111): the run header, the domain timeline (the
   * permanent issue-stream events for the run), and the verbose captured transcript (or a
   * pruned marker once it has aged out). A run is keyed by `?repo=<owner/name>&issue=<n>`
   * — there is exactly one run row per issue, so its `runId` is derived server-side and
   * echoed back for live-tail correlation. A 404 means no such run.
   */
  run: `${API_BASE}/run`,
  /**
   * The Inbox (issue #112): every open `ralph-answer` question across all repos, oldest-first,
   * each a structured card (stakes emphasized, recommendation highlighted). Aggregate across all
   * repos; a `?repo=<owner/name>` query narrows the list. The read side of the first write path.
   */
  inbox: `${API_BASE}/inbox`,
  /**
   * Answer one open question (issue #112): the first write path. A same-origin POST carries an
   * {@link import("./inbox").AnswerRequestBody}; the server resolves it against the live question
   * (re-fetched from GitHub) and submits through `RalphAnswerService` verbatim — posting the
   * `ralph-answer` comment + swapping the human-attention label back to `ready-for-agent`. The
   * reconciler resumes/re-admits next tick (ADR-0032). Origin-guarded (ADR-0032): a cross-origin
   * POST is rejected with 403 before it reaches this route.
   */
  answer: `${API_BASE}/inbox/answer`,
  /**
   * Apply one Tier-1 power action (issue #114, ADR-0032): re-admit / close / set `mode:*` /
   * set priority / pause / unpause. A same-origin POST carries a
   * {@link import("./power-actions").PowerActionRequestBody}; the server applies the on-protocol
   * label effect through the `gh` client port and the reconciler acts on it next tick (eventually
   * consistent — the UI never fakes immediacy). The destructive `close` requires `confirm: true` in
   * the body. Origin-guarded (ADR-0032): a cross-origin POST is rejected with 403 before it reaches
   * this route.
   */
  action: `${API_BASE}/backlog/action`,
  /**
   * Begin a graceful drain (issue #118, ADR-0032): no new pickups/resumes, in-flight runs
   * finish (review + merge), then the daemon exits. A same-origin POST carries `{ confirm: true }`
   * and the server calls `DaemonControl.drain()` — the orchestrator's drain trigger, the same
   * graceful drain a SIGTERM runs. Fire-and-forget: the request returns immediately, the drain
   * settles under the loop. Origin-guarded (a cross-origin POST is 403) AND confirm-gated (no
   * `confirm: true` ⇒ 400) — a destructive action that cannot fire by accident.
   */
  drain: `${API_BASE}/daemon/drain`,
  /**
   * Force a reconcile round now (issue #118): cut the inter-tick sleep short so the next tick
   * runs immediately. A same-origin POST carries `{}` and the server calls
   * `DaemonControl.forceTick()`. Origin-guarded; NOT confirm-gated (non-destructive).
   */
  forceTick: `${API_BASE}/daemon/force-tick`,
  /**
   * Kill one in-flight run (issue #118, ADR-0032): tear down a specific run's live session by
   * run id. A same-origin POST carries `{ runId, confirm: true }`; the server calls
   * `DaemonControl.killRun(runId)` — the orchestrator aborts the run's controller via the runId
   * → AbortController registry (each run registers its own, so one kill never touches another).
   * Origin-guarded AND confirm-gated — destructive, never fires by accident.
   */
  killRun: `${API_BASE}/daemon/kill-run`,
  /**
   * The effective routing (ADR-0037 P4.1, issue #166): every agent type's resolved
   * `(provider, model)` preference list, the provider capability matrix, and the account-pool
   * summary — the read side of the runtime routing surface the editor (#167) consumes. A GET;
   * `?repo=<owner/name>` is accepted for forward-compatible per-repo deviation (#170) but ignored
   * in v1 (the patch is empty, so every repo resolves the global routing).
   */
  routing: `${API_BASE}/routing`,
  /**
   * Set or clear one agent type's `(provider, model)` preference list (ADR-0037 P4.1): a
   * same-origin POST carrying a {@link import("./routing").RoutingEditRequestBody}. The change
   * lands in the in-memory overlay route resolution reads each dispatch AND writes through to
   * `config.yaml` (gitignored → survives the self-update reset). Effect is the **next** dispatch;
   * an in-flight container finishes on the route it started with. Origin-guarded (ADR-0032): a
   * cross-origin POST is 403; a capability-invalid pairing (e.g. `impl → openai`) is rejected 400.
   */
  routingEdit: `${API_BASE}/routing/edit`,
  /**
   * The VAPID public key (issue #119): the base64url uncompressed P-256 application-server key the
   * browser passes to `pushManager.subscribe({ applicationServerKey })`. A GET; the response carries
   * `enabled: false` (with a null key) when the daemon has no VAPID identity wired.
   */
  webpushVapid: `${API_BASE}/webpush/vapid`,
  /**
   * Register a device's push subscription (issue #119): a same-origin POST carrying the browser's
   * `PushSubscription.toJSON()` (endpoint + keys), persisted so pushes survive a daemon restart.
   * Origin-guarded (ADR-0032): a cross-origin POST is rejected with 403.
   */
  webpushSubscribe: `${API_BASE}/webpush/subscribe`,
  /**
   * Drop a device's push subscription (issue #119): a same-origin POST carrying the endpoint to
   * remove. Origin-guarded (ADR-0032). `ok` even if the subscription was already gone.
   */
  webpushUnsubscribe: `${API_BASE}/webpush/unsubscribe`,
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
