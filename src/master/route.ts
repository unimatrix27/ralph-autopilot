/**
 * Master route resolution (ADR-0041) — and, more importantly, its **fail-closed** boundary.
 *
 * The master is the strongest model in the system; that is the entire reason a worker hands
 * its decision up. So there is exactly one thing this module must never do: run a master
 * session on something cheaper because tier 1 was misconfigured. Ordinary route resolution
 * would happily do that — an absent `agent.tiers["1"].routes` normalises to the global
 * `agent.provider`, and a non-tools-capable entry is simply skipped as "no headroom". Both
 * read as transient waits when they are in fact permanent configuration defects.
 *
 * {@link resolveMasterRoute} therefore pre-checks the tier-1 profile *before* consulting the
 * account pool, and distinguishes three outcomes that must never be conflated:
 *
 *  - `route`        — a concrete `{ provider, model, account }` to dispatch on;
 *  - `wait`         — the configuration is sound but every allowed pool is momentarily
 *                     gated (the ordinary ADR-0037 `no-provider` wait: re-resolved next tick,
 *                     no human-attention label, never a stuck);
 *  - `unconfigured` — a configuration defect that no amount of waiting fixes. The caller
 *                     surfaces it as an actionable attention state naming the defect.
 */

import type { RouteResolution, RoutingConfig, RouteWorld } from "../providers/resolve";
import { resolveRoute } from "../providers/resolve";
import {
  GOVERNING_TIER,
  masterPreferenceList,
  providerToolsCapable,
  type RoutingTier,
} from "../providers/select";

/** Why a master session cannot be routed at all — a configuration defect, not a wait. */
export type MasterRouteDefect = "missing-tier-1-profile" | "tier-1-not-tools-capable";

/** The outcome of resolving a master route. */
export type MasterRouteResolution =
  | { kind: "route"; route: Extract<RouteResolution, { account: unknown }> }
  | { kind: "wait" }
  | { kind: "unconfigured"; defect: MasterRouteDefect; detail: string };

/**
 * The tier a master session runs on. Always {@link GOVERNING_TIER}: the first master
 * escalation permanently promotes its issue to `complexity:1`, so by the time a master
 * dispatches, tier 1 *is* the issue's tier. Named rather than inlined so the invariant is
 * greppable and the tests can pin it.
 */
export const MASTER_TIER: RoutingTier = GOVERNING_TIER;

/** Human-readable, actionable text for each defect — this is what an operator will read. */
export function describeMasterRouteDefect(defect: MasterRouteDefect): string {
  switch (defect) {
    case "missing-tier-1-profile":
      return (
        "master escalation cannot dispatch: `agent.tiers.\"1\".routes` is missing or empty. " +
        "The master route is derived from the tier-1 profile (ADR-0041) — there is no " +
        "`agent.types.master` key and no fallback, so a cheaper master is never substituted. " +
        "Configure `agent.tiers.\"1\".routes` in .ralph/config.yaml (e.g. " +
        "`[{ provider: claude, model: claude-fable-5 }]`) and the queued escalation resumes."
      );
    case "tier-1-not-tools-capable":
      return (
        "master escalation cannot dispatch: every provider in `agent.tiers.\"1\".routes` is " +
        "not tools-capable, but a master session requires in-session host-callback tools " +
        "(`ask_human` and the outcome tools — ADR-0037 capability gate). Route tier 1 at a " +
        "tools-capable provider (`claude` or `zai`), or set that provider's `toolsCapable: true` " +
        "once its backend supports them."
      );
  }
}

/**
 * Resolve the route one master session runs on, or say precisely why it cannot.
 *
 * The order is load-bearing: profile presence → capability → account headroom. Checking
 * capability before headroom is what turns "impl is gated to claude/zai and tier 1 points at
 * bare openai" from a silent forever-wait into a named configuration defect.
 */
export function resolveMasterRoute(
  routing: RoutingConfig,
  repo: string,
  world: RouteWorld,
  tier: RoutingTier = MASTER_TIER,
): MasterRouteResolution {
  const preferences = masterPreferenceList(routing.agent, tier);
  if (preferences === null) {
    return {
      kind: "unconfigured",
      defect: "missing-tier-1-profile",
      detail: describeMasterRouteDefect("missing-tier-1-profile"),
    };
  }
  if (!preferences.some((p) => providerToolsCapable(routing.providers, p.provider))) {
    return {
      kind: "unconfigured",
      defect: "tier-1-not-tools-capable",
      detail: describeMasterRouteDefect("tier-1-not-tools-capable"),
    };
  }
  const resolved = resolveRoute(routing, repo, "master", world, undefined, tier);
  if ("wait" in resolved) {
    return { kind: "wait" };
  }
  return { kind: "route", route: resolved };
}
