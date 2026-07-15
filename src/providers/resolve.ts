/**
 * Pure route resolution (ADR-0037 P2.1). A **route** is the concrete
 * `{ provider, model, account }` an agent start runs on; **route resolution** produces
 * one for a `(repo, type)` by reading the *current* routing. This module is the pure
 * decision — it walks the type's `(provider, model)` preference list
 * ({@link import("./select").providerPreferenceList}), applies the
 * {@link import("./select").capabilityOk} gate, and asks the injected {@link RouteWorld}
 * for a headroom account from the first qualifying provider's pool. The stateful headroom
 * meter (rotation, gating) lives behind the port, so this stays a pure, exhaustively
 * testable function with no SDK and no network.
 *
 * Per ADR-0037, no route is a **wait**, not an error: when nothing qualifies it returns
 * `{ wait: "no-provider" }` — never a throw, never a guess onto the wrong backend. The
 * caller (admission, a later slice) keeps the issue `eligible` and re-resolves next tick.
 *
 * The composition-root wiring (backing the port with the real
 * {@link import("../daemon/usage-meter").ProviderPoolMeter}) and the admission/launch
 * integration are later slices (ADR-0037 P2 slices 4–5); this slice is pure and
 * behaviour-preserving.
 */

import type { Account, AgentSettings, ProviderName, ProvidersSettings, TargetConfig } from "../config/schema";
import { capabilityOk, providerPreferenceList, type AgentType, type RoutingPhase, type RoutingTier } from "./select";

/**
 * The routing configuration route resolution reads: the resolved `agent` block (the source
 * of each type's `(provider, model)` preference list) and the `providers` block (the source
 * of the capability gate). Both are already per-target-resolved in `config/load.ts`; the ADR
 * anticipates a per-repo deviation overlaying this, an additive change with the patch empty in v1.
 */
export interface RoutingConfig {
  agent: AgentSettings;
  providers: ProvidersSettings;
}

/**
 * A live source of the current {@link RoutingConfig} — read fresh at every resolution (a thunk,
 * so the runtime routing overlay (ADR-0037 P4.1, issue #166) is a drop-in swap). The reconciler
 * holds one per target for the per-provider `no-provider` admission wait (#161/#163): each tick it
 * resolves the impl route through `routing()` + the headroom {@link RouteWorld}, parking the
 * otherwise-eligible queue when no provider has headroom. The runtime overlay
 * ({@link import("../config/routing-store").RoutingStore}) backs this thunk so a web routing edit
 * is reflected on the next dispatch with no daemon restart.
 */
export type RoutingSource = () => RoutingConfig;

/**
 * The global routing surface (ADR-0037 P4.1) — the runtime-editable slice resolution reads: the
 * resolved `agent` block (each type's `(provider, model)` preference list) and the `providers`
 * block (the capability gate). Daemon-wide; the per-repo deviation the ADR anticipates (#170)
 * overlays this as an additive patch.
 */
export interface GlobalRouting {
  agent: AgentSettings;
  providers: ProvidersSettings;
}

/**
 * A per-repo routing deviation (ADR-0037: "global base ⊕ per-repo deviation"). **Empty in v1**
 * (#170) — modelled as a type so {@link resolveEffectiveRouting} already takes its shape and
 * per-repo deviation is an additive overlay later, not a re-key.
 */
export type RepoRoutingPatch = Record<string, never>;

/**
 * Resolve the effective {@link RoutingConfig} for a repo from the global routing and an optional
 * per-repo patch (ADR-0037 P4.1): the pure `resolve(globalRouting, repoPatch?)` the ADR shapes
 * resolution as. **The patch is empty in v1** (#170), so the effective routing is exactly the
 * global routing — but the seam exists so per-repo deviation drops in without re-keying callers.
 * Pure — no I/O, no SDK.
 */
export function resolveEffectiveRouting(global: GlobalRouting, _repoPatch?: RepoRoutingPatch): RoutingConfig {
  return { agent: global.agent, providers: global.providers };
}

/**
 * The injected headroom port — the seam between the pure resolver and the stateful
 * per-provider account meter (ADR-0028, generalised by ADR-0037). Keyed by `repo` for the
 * per-repo deviation the ADR anticipates ("everything keyed by `?repo=`"); v1 backs it with
 * a single daemon-wide pool that ignores `repo`. The real implementation is the
 * {@link import("../daemon/usage-meter").ProviderPoolMeter}; tests inject a pure fake.
 */
export interface RouteWorld {
  /**
   * Pick a headroom account from `provider`'s pool for `repo` (rotated for even wear,
   * gated accounts skipped), or `null` when the provider has no account with headroom
   * (every account gated, or the provider has no accounts at all).
   */
  acquireAccount(repo: string, provider: ProviderName): Account | null;
}

/**
 * A resolved route — the concrete `{ provider, model, account }` an agent start runs on —
 * or a `{ wait: "no-provider" }` when no preference entry qualifies. `model` is the entry's
 * per-type model override; absent means "the provider's default model" (resolved at wiring,
 * a later slice), so it is omitted rather than guessed here.
 */
export type RouteResolution =
  | { provider: ProviderName; model?: string; account: Account }
  | { wait: "no-provider" };

/**
 * Resolve the route for `(repo, type, phase)` (ADR-0037 P2.1/#169). Walks the type's preference
 * list in order; the **first** entry whose provider is allowed by the capability gate *and* has an
 * account with headroom wins — its provider, its model (if any), and a rotated headroom account
 * from that provider's pool. If no entry qualifies, returns `{ wait: "no-provider" }`.
 *
 * The optional `phase` selects the per-phase routing key for `review`/`fix` (ADR-0037 #169): the
 * object form resolves `perPhase[phase] ?? base` (whole-list replacement), so e.g. a Phase-2 thermo
 * review can route to a stronger provider than the Phase-1 normal pass. `impl`/`autoMode` are
 * single-phase — the daemon passes no phase and the resolution is unchanged.
 *
 * The optional `tier` selects the per-tier impl routing key (issue #278): a `complexity:1|2|3`
 * label's configured `agent.tiers[tier].routes` replaces the impl preference list whole; absent/
 * unconfigured falls back to `types.impl`. Impl-only — every other type ignores it.
 *
 * The capability gate is honoured here as **defence in depth** (it is also enforced at config
 * load and the web edit API): a capability-blocked provider is skipped before the port is even
 * consulted, so route resolution can never hand back a route on the wrong backend. Pure — the
 * only state lives behind {@link RouteWorld}.
 */
export function resolveRoute(
  routing: RoutingConfig,
  repo: string,
  type: AgentType,
  world: RouteWorld,
  phase?: RoutingPhase,
  tier?: RoutingTier | null,
): RouteResolution {
  for (const entry of providerPreferenceList(routing.agent, type, phase, tier)) {
    if (!capabilityOk(type, entry.provider, routing.providers)) {
      continue;
    }
    const account = world.acquireAccount(repo, entry.provider);
    if (account) {
      return entry.modelOverride !== undefined
        ? { provider: entry.provider, model: entry.modelOverride, account }
        : { provider: entry.provider, account };
    }
  }
  return { wait: "no-provider" };
}

/**
 * The route-resolution wrapper shared by every container dispatch (ADR-0037 / issue #220) — the
 * single seam between a container runner's deps and the pure {@link resolveRoute}. When `routing` +
 * `routeWorld` are both wired it resolves a fresh {@link RouteResolution} for `(config.targetRepo,
 * type)`; when either is absent (tests / a routing-agnostic setup) it returns `null`, the signal to
 * dispatch on the box-default credentials. The wiring gate and the `resolveRoute` call live here
 * once so the impl runner and the review/fix runner cannot drift.
 *
 * Each caller branches on the returned union its own way — the only genuine divergence: the impl
 * runner surfaces a `{ wait: "no-provider" }` so its `run()` maps it to `limited` (defer, re-resolve
 * next tick); the review/fix runner translates that same wait to a thrown `UsageLimitError` (the
 * per-phase catch leaves the run resumable). Accepts any deps object carrying the three fields, so
 * both `ContainerAgentRunnerDeps` and `ContainerReviewFixDeps` pass through structurally.
 *
 * `phase` threads the per-phase routing key (ADR-0037 #169) for `review`/`fix` — the review/fix
 * runner passes its `ctx.phase`; the impl runner passes nothing (single-phase). `tier` threads
 * the per-tier impl routing key (issue #278) — the impl runner passes the issue's
 * `complexity:1|2|3` label's tier; review/fix pass nothing (tier-less).
 */
export function resolveDispatchRoute(
  deps: { routing?: RoutingSource; routeWorld?: RouteWorld; config: TargetConfig },
  type: AgentType,
  phase?: RoutingPhase,
  tier?: RoutingTier | null,
): RouteResolution | null {
  if (!deps.routing || !deps.routeWorld) {
    return null;
  }
  const resolved = resolveRoute(deps.routing(), deps.config.targetRepo, type, deps.routeWorld, phase, tier);
  if ("wait" in resolved || resolved.model !== undefined) {
    return resolved;
  }
  // Fill the provider's EFFECTIVE default model when the winning entry carries no per-type
  // override (the "resolved at wiring" slice the RouteResolution doc promises). This is what the
  // session would resolve anyway — claude swaps in `agent.model`, zai/openai use their provider
  // block's model — so dispatch behaviour is unchanged; but the recorded route now always names
  // its model, and the web route chip reads `provider · model · account` on every row instead of
  // dropping the segment whenever the default was in play.
  const model = effectiveDefaultModel(deps.config, resolved.provider);
  return model !== undefined ? { ...resolved, model } : resolved;
}

/**
 * The model a `(provider, no-override)` route actually runs on: the same default the session
 * wiring resolves (`agent.model` for claude; the provider block's `model` for zai/openai — the
 * zai model rides its endpoint, the openai one its Codex backend). Returns `undefined` only when
 * the provider block is absent — a route that could not actually dispatch on that provider.
 */
export function effectiveDefaultModel(config: TargetConfig, provider: ProviderName): string | undefined {
  switch (provider) {
    case "claude":
      return config.agent.model;
    case "zai":
      return config.providers.zai?.model;
    case "openai":
      return config.providers.openai?.model;
  }
}
