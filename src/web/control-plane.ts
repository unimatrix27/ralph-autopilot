/**
 * Composition root for the embedded web control plane (ADR-0029). This is the only
 * place the daemon process touches the web layer: it builds the read-only ports,
 * constructs the {@link WebServer}, and starts it — returning a handle whose
 * `stop()` the daemon calls after the reconcile loop has drained.
 *
 * The **isolation contract** lives here: `start()` is awaited once at startup (so a
 * bind failure is logged, never fatal — the daemon runs on), and the reconcile tick
 * never sees any of this. A disabled config, or a failed bind, yields `null` and the
 * daemon proceeds headless.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log/logger";
import type { RalphConfig, TargetConfig } from "../config/schema";
import type { Store } from "../store/store";
import { createLiveFeedPort } from "../store/live-feed";
import { buildSnapshot } from "../projection/snapshot";
import { WebServer } from "./server/server";
import type {
  DaemonControl,
  WebControlPlanePorts,
  WebPushSubscribeResult,
  WebPushUnsubscribeResult,
} from "./server/ports";
import { snapshotToOverview } from "./overview";
import { analyticsWindowStart, computeAnalytics } from "./analytics";
import { resolveWindowDays } from "./contract";
import { buildHealthUsage, type UsageMeterSnapshot } from "./health-usage";
import { snapshotToBacklog } from "./backlog";
import { toRunDetailResponse, toRunsResponse, runIdOf } from "./runs";
import { listOpenQuestions, openQuestionForIssue } from "../hitl/queue";
import { RalphAnswerService } from "../hitl/ralph-answer";
import {
  resolveStructuredAnswer,
  type StructuredAnswerChoice,
} from "../hitl/answer";
import { GhCliClient } from "../github/gh-cli";
import type { GitHubClient } from "../github/types";
import type { AnswerRequestBody, SubscribeRequestBody, UnsubscribeRequestBody } from "./contract";
import {
  toInboxResponse,
  type AnswerPortResult,
  type InboxEntry,
} from "./inbox";
import { consequenceForAnswerableLabel } from "../hitl/labels";
import type { VapidIdentity } from "../notify/webpush";
import { executePowerAction } from "./power-actions";
import { executeRoutingEdit, getEffectiveRouting, type RoutingControlPort } from "./routing-actions";

/**
 * A read-only usage-meter snapshot reader (ADR-0029: the web layer reads only through
 * pure-read ports, never the live meter). The daemon supplies one closing over its
 * `UsageMeter`; when none is wired (a headless/test embed), the control plane falls
 * back to the box-default single login with no streamed state.
 */
export type UsageSnapshotReader = () => UsageMeterSnapshot;

/** The box-default usage picture when no meter is wired: one login, nothing streamed. */
const DEFAULT_USAGE_SNAPSHOT: UsageMeterSnapshot = { activeId: "default", ids: ["default"], states: {}, disabledIds: [] };

type WebTargetMetadata = Pick<TargetConfig, "targetRepo" | "priorityLabels">;

export interface WebControlPlaneHandle {
  /** Stop serving (best-effort, fast). Called after the daemon has drained. */
  stop(): Promise<void>;
  /** The bound base URL, for logging/tests. */
  url: string | null;
}

export interface StartWebControlPlaneDeps {
  config: RalphConfig;
  /** Resolved target metadata from `resolveTargets`; config fallback/merge logic stays in config/load.ts. */
  targets: readonly WebTargetMetadata[];
  logger: Logger;
  /**
   * The runtime store, read-only here — the overview port projects it through
   * `buildSnapshot` (ADR-0029: the web layer depends only on pure reads, never the
   * reconciler or SDK sessions).
   */
  store: Store;
  /**
   * Read-only snapshot of the daemon's shared {@link import("../daemon/usage-meter").UsageMeter}
   * (ADR-0028), for the Health view's dual-login usage section. Omitted on a headless/test
   * embed → the box-default single login with no streamed state.
   */
  usage?: UsageSnapshotReader;
  /** Injected clock so uptime/started timestamps are testable; defaults to the system clock. */
  now?: () => Date;
  /**
   * A GitHub client per target repo for the Inbox + answer write path (issue #112). Defaults to a
   * `GhCliClient` per repo (the same client the reconciler uses) — OAuth-only, like every GitHub
   * touch in the daemon. Override in tests with a fake.
   */
  githubFor?: (repo: string) => GitHubClient;
  /**
   * Tier-2 daemon control (issue #118, ADR-0032): the orchestrator-implemented port the
   * `/api/daemon/*` routes call — drain / force-tick / kill-run. The web layer never reaches
   * reconciler internals; it only holds this handle. Required whenever the control plane is
   * started, so the mounted daemon-control routes cannot silently no-op.
   */
  control: DaemonControl;
  /**
   * The runtime routing overlay (ADR-0037 P4.1, issue #166): the `RoutingStore` the daemon owns,
   * read by `/api/routing` and written by `/api/routing/edit`. Required whenever the control plane
   * is started, so the mounted routing routes cannot silently no-op.
   */
  routing: RoutingControlPort;
  /**
   * The resolved VAPID identity for web push (issue #119), or `null` when not configured. Served to
   * the browser at `/api/webpush/vapid`; resolved once by the daemon from the env-var NAME in config.
   */
  vapid?: VapidIdentity | null;
}

/** `{ name, version }` of the running daemon build, read from its `package.json`. */
function readPackageMeta(): { name: string; version: string } {
  // Works both compiled (dist/web/control-plane.js → repo root is three up) and
  // under vitest (src/web/control-plane.ts → likewise), with a cwd fallback.
  const candidates = [join(__dirname, "..", "..", "package.json"), join(process.cwd(), "package.json")];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
      if (pkg.name) {
        return { name: pkg.name, version: pkg.version ?? "0.0.0" };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { name: "ralph-autopilot", version: "0.0.0" };
}

function answerChoiceFromBody(body: AnswerRequestBody): StructuredAnswerChoice {
  switch (body.kind) {
    case "accept-recommendation":
      return { kind: "accept-recommendation" };
    case "option":
      return { kind: "option", optionIndex: body.optionIndex };
    case "free-text":
      return { kind: "free-text", text: body.text };
  }
}

/**
 * Build the read-only web ports. Process health is computed live so uptime is
 * current at call time; the overview projects the store through `buildSnapshot` +
 * the pure {@link snapshotToOverview} transform on each call (a thin serialization
 * edge — no decision logic, ADR-0029). `repos` (the configured targets) seeds the
 * filter list so even idle repos appear. Later slices add more read/write ports here.
 */
export function createWebPorts(deps: {
  now: () => Date;
  startedAt: Date;
  store: Store;
  /** Resolved target metadata from `resolveTargets`, in configured order. */
  targets: readonly WebTargetMetadata[];
  /** Read-only usage-meter snapshot for the Health view (ADR-0028); defaults to the single box login. */
  usage?: UsageSnapshotReader;
  /** The "stop at N%" plan-budget threshold the usage gate uses (`usageLimit.admitBelowPercent`). */
  admitBelowPercent: number;
  /**
   * A GitHub client per target repo (ADR-0007/0032). The Inbox reads the open-question queue and
   * writes answers through it — `RalphAnswerService` is GitHub-only, so the control plane reaches
   * GitHub only through this seam, never the reconciler or SDK sessions.
   */
  githubFor: (repo: string) => GitHubClient;
  /** The daemon's reconcile interval (s) — the honest "acts next tick (~Ns)" figure the UI states. */
  reconcileIntervalSeconds: number;
  /**
   * Tier-2 daemon control (issue #118): the orchestrator-implemented port the `/api/daemon/*`
   * routes call. Production passes the orchestrator; tests that do not care about control
   * behavior pass an explicit fake. Threaded straight through — the web layer adds no control
   * logic.
   */
  control: DaemonControl;
  /**
   * The runtime routing overlay (ADR-0037 P4.1): the `RoutingStore` the daemon owns. The `routing`
   * read serialises its snapshot; the `applyRouting` write threads an edit to it. Threaded straight
   * through — the web layer adds no routing logic.
   */
  routing: RoutingControlPort;
  /**
   * The resolved VAPID identity for the web-push channel (issue #119), or `null` when push is not
   * configured. The vapid port serves its public key; subscribe/unsubscribe persist to the store.
   * The daemon resolves the identity once from the configured env-var NAME and passes it here.
   * Optional (defaults to null) so a test embed that does not care about push still type-checks.
   */
  vapid?: VapidIdentity | null;
}): WebControlPlanePorts {
  const vapid = deps.vapid ?? null;
  const meta = readPackageMeta();
  const usage = deps.usage ?? ((): UsageMeterSnapshot => DEFAULT_USAGE_SNAPSHOT);
  const control = deps.control;
  // The repos this control plane serves, in configured order; the inbox narrows to one when asked.
  const allRepos = deps.targets.map((target) => target.targetRepo);
  const configuredRepos = new Set(allRepos);
  const priorityLabelsByRepo = new Map(deps.targets.map((target) => [target.targetRepo, target.priorityLabels] as const));
  const priorityLabelsFor = (repo: string): readonly string[] => priorityLabelsByRepo.get(repo) ?? [];
  return {
    health: () => ({
      status: "ok",
      name: meta.name,
      version: meta.version,
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((deps.now().getTime() - deps.startedAt.getTime()) / 1000)),
    }),
    overview: (query) => {
      // A larger outcome window than the legacy default so the recent-activity feed and
      // the funnel's recent-merge throughput are meaningful.
      const snapshot = buildSnapshot(deps.store, { now: deps.now, outcomeLimit: 50 });
      return snapshotToOverview(snapshot, {
        now: deps.now,
        repo: query.repo,
        repos: allRepos,
        reconcileIntervalSeconds: deps.reconcileIntervalSeconds,
        priorityLabelsFor,
      });
    },
    live: createLiveFeedPort(deps.store),
    analytics: (query) => {
      const now = deps.now();
      const windowDays = resolveWindowDays(query.windowDays);
      // Two pure reads over the run-log history: the windowed events (the metrics) and
      // each run's start anchor across all time (time-to-merge needs a pre-window start).
      // `analyticsWindowStart` is the single source of truth both the query bound and the
      // transform's day bucketing use, so they cover the exact same days.
      const events = deps.store.logSince(analyticsWindowStart(now, windowDays));
      const runStarts = deps.store.runStartTimes();
      return computeAnalytics({ events, runStarts, now, windowDays, repo: query.repo, repos: allRepos });
    },
    healthUsage: () => {
      // Absolute instants flow straight through the snapshot to the wire (ADR-0031), so no
      // clock-freeze is needed — the daemon section is a pass-through and the UI counts live
      // against its own render clock. `buildHealthUsage` reads only the snapshot's daemon +
      // anomaly sections, never recentOutcomes, so the default outcome window suffices.
      const snapshot = buildSnapshot(deps.store, { now: deps.now });
      // The anomaly reason is logged once at the edge, so read it unbounded (not via the
      // snapshot's capped recent-outcomes) — see Store.latestAnomalies.
      return buildHealthUsage(snapshot, deps.store.latestAnomalies(), usage(), {
        now: deps.now,
        admitBelowPercent: deps.admitBelowPercent,
      });
    },
    backlog: (query) => {
      // The backlog reads no outcomes feed, so the default outcome window is fine.
      const snapshot = buildSnapshot(deps.store, { now: deps.now });
      return snapshotToBacklog(snapshot, {
        now: deps.now,
        repo: query.repo,
        repos: allRepos,
        reconcileIntervalSeconds: deps.reconcileIntervalSeconds,
        priorityLabelsFor,
      });
    },
    // The run history index (issue #111): every run row, newest-first. A pure read of the
    // run rows — narrowed to one repo, or aggregate across all targets.
    runs: (query) => {
      const runs = query.repo ? deps.store.listRuns(query.repo) : deps.store.listAllRuns();
      return toRunsResponse(runs, { now: deps.now, repos: allRepos, repo: query.repo });
    },
    // One run's detail + transcript (issue #111): the run row keyed by (repo, issue), its
    // permanent issue-stream timeline, and its verbose transcript stream. `null` → 404.
    run: (query) => {
      const run = deps.store.getRunByIssue(query.repo, query.issue);
      if (!run) {
        return null;
      }
      const timeline = deps.store.events.readIssueStream(query.repo, query.issue);
      const transcript = deps.store.events.readTranscript(query.repo, query.issue, runIdOf(run));
      const projection = deps.store.events.readIssueProjection(query.repo, query.issue);
      return toRunDetailResponse({ run, timeline, transcript, projection, now: deps.now });
    },
    // The Inbox (issue #112): the `ralph-answer` queue across repos, oldest-first. Each repo's
    // open questions come straight from GitHub (the queue's source of truth, ADR-0007); the store
    // only enriches each with its run row for deep links. A repo filter narrows the gather; the
    // response still echoes the full configured repo list.
    inbox: async (query) => {
      const repos = query.repo ? allRepos.filter((r) => r === query.repo) : allRepos;
      const perRepoEntries = await Promise.all(
        repos.map(async (repo): Promise<InboxEntry[]> => {
          const items = await listOpenQuestions(deps.githubFor(repo));
          return items.map((item) => ({ item, repo, run: deps.store.getRunByIssue(repo, item.issue.number) }));
        }),
      );
      const entries = perRepoEntries.flatMap((repoEntries) => repoEntries);
      return toInboxResponse(entries, {
        now: deps.now,
        repos: allRepos,
        repo: query.repo,
        reconcileIntervalSeconds: deps.reconcileIntervalSeconds,
        priorityLabelsFor,
      });
    },
    // The first write path (issue #112, ADR-0032): resolve the operator's structured choice
    // against the LIVE question (re-fetched from GitHub so a stale client can't accept a
    // superseded recommendation) and submit through `RalphAnswerService` verbatim. The
    // reconciler resumes/re-admits next tick; this port only writes the durable answer + the
    // label swap. Never throws on a bad request — it returns a domain outcome the HTTP adapter maps.
    answer: async (body: AnswerRequestBody): Promise<AnswerPortResult> => {
      if (!configuredRepos.has(body.repo)) {
        return { kind: "invalid-answer", error: `${body.repo} is not a configured target repo` };
      }
      const github = deps.githubFor(body.repo);
      const issue = await github.getIssue(body.issue);
      if (!issue) {
        return { kind: "no-open-question", error: `no open question for ${body.repo}#${body.issue}` };
      }
      const question = await openQuestionForIssue(github, issue);
      if (question.kind !== "open") {
        return { kind: "no-open-question", error: `no open question for ${body.repo}#${body.issue}` };
      }
      const item = question.item;
      const answer = resolveStructuredAnswer(item.question, answerChoiceFromBody(body));
      if (answer.kind === "invalid-answer") {
        return answer;
      }
      const service = new RalphAnswerService(github);
      await service.submit(item, answer);
      return {
        kind: "answered",
        response: {
          generatedAt: deps.now().toISOString(),
          repo: body.repo,
          issue: body.issue,
          attentionLabel: item.label,
          consequence: consequenceForAnswerableLabel(item.label),
          resumesNextTickSeconds: deps.reconcileIntervalSeconds,
        },
      };
    },
    // The Tier-1 power actions (issue #114, ADR-0032) live in `power-actions.ts`; the composition
    // root only supplies the configured repo guard and GitHub/config dependencies.
    powerAction: (body) =>
      executePowerAction(body, {
        now: deps.now,
        isConfiguredRepo: (repo) => configuredRepos.has(repo),
        githubFor: deps.githubFor,
        priorityLabelsFor,
        reconcileIntervalSeconds: deps.reconcileIntervalSeconds,
      }),
    // Runtime routing (ADR-0037 P4.1, issue #166): the read serialises the overlay snapshot; the
    // write threads the edit through to the overlay (validate + write-through). Both are thin
    // adapters over `routing-actions.ts` — the composition root only supplies the store + clock.
    routing: (query) =>
      getEffectiveRouting(query, {
        now: deps.now,
        reconcileIntervalSeconds: deps.reconcileIntervalSeconds,
        routing: deps.routing,
      }),
    applyRouting: (body) =>
      executeRoutingEdit(body, {
        now: deps.now,
        reconcileIntervalSeconds: deps.reconcileIntervalSeconds,
        routing: deps.routing,
      }),
    // Tier-2 daemon control (issue #118, ADR-0032): threaded straight through — the web layer
    // adds no control logic, it only hands the orchestrator-implemented port to the routes.
    control,
    // The web-push VAPID public key (issue #119): a read-only lookup of the resolved identity.
    // `enabled: false` + null key when the daemon has no VAPID identity — the UI hides the
    // subscribe affordance rather than failing.
    webpushVapid: () =>
      vapid === null ? { enabled: false, publicKey: null } : { enabled: true, publicKey: vapid.publicKey },
    // Register a device's push subscription (issue #119): persist it so pushes survive a daemon
    // restart. `disabled` (→ 503) when push is not configured; otherwise it is a durable store write.
    webpushSubscribe: async (body: SubscribeRequestBody): Promise<WebPushSubscribeResult> => {
      if (vapid === null) {
        return { kind: "disabled", error: "web push is not configured (set notifications.webpush on the daemon)" };
      }
      deps.store.upsertPushSubscription({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      });
      return { kind: "subscribed", response: { ok: true, endpoint: body.endpoint } };
    },
    // Drop a device's subscription (issue #119): idempotent — `ok` whether or not one existed.
    webpushUnsubscribe: async (body: UnsubscribeRequestBody): Promise<WebPushUnsubscribeResult> => {
      deps.store.deletePushSubscription(body.endpoint);
      return { kind: "unsubscribed" };
    },
  };
}

/**
 * Start the control plane, or return `null` if it is disabled or fails to bind.
 * Never throws — a web fault must not abort daemon startup (ADR-0029).
 */
export async function startWebControlPlane(
  deps: StartWebControlPlaneDeps,
): Promise<WebControlPlaneHandle | null> {
  const { config, logger } = deps;
  if (!config.web.enabled) {
    logger.info("web.disabled", {});
    return null;
  }
  const now = deps.now ?? ((): Date => new Date());
  // A memoized GitHub client per repo: `GhCliClient` construction is cheap (it only stores the
  // repo + options; the `gh` shell-out happens on a method call), and memoizing keeps the Inbox
  // and the answer write path on one client per repo rather than re-spawning context per request.
  const clientCache = new Map<string, GitHubClient>();
  const githubFor =
    deps.githubFor ??
    ((repo: string): GitHubClient => {
      const cached = clientCache.get(repo);
      if (cached) {
        return cached;
      }
      const client = new GhCliClient(repo, { logger });
      clientCache.set(repo, client);
      return client;
    });
  const ports = createWebPorts({
    now,
    startedAt: now(),
    store: deps.store,
    targets: deps.targets,
    usage: deps.usage,
    admitBelowPercent: config.usageLimit.admitBelowPercent,
    githubFor,
    reconcileIntervalSeconds: config.scheduler.reconcileIntervalSeconds,
    control: deps.control,
    routing: deps.routing,
    vapid: deps.vapid ?? null,
  });
  const server = new WebServer({ config: config.web, logger, ports });
  try {
    await server.start();
  } catch (err) {
    // EADDRINUSE is the singleton backstop (issue #240): the control-plane port is a
    // single-daemon resource, so a bind collision means another daemon is already
    // listening — the exact two-daemon condition the startup singleton guard exists
    // to prevent. The guard reaps a verified incumbent before we get here, so reaching
    // this branch means something the guard could not reap holds the port (an
    // unidentifiable/foreign process). Fail fast rather than run on headless and race:
    // the daemon exits non-zero and the supervisor surfaces a daemon-anomaly.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      logger.error("web.port-in-use", {
        host: config.web.host,
        port: config.web.port,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    // Any other bind failure stays non-fatal: the web edge is best-effort and the
    // daemon must keep reconciling even if the SPA cannot be served.
    logger.warn("web.start-failed", {
      host: config.web.host,
      port: config.web.port,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return { stop: () => server.stop(), url: server.url() };
}
