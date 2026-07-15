/**
 * The pure provider-selection seam (issue #131, ADR-0033). One function maps a
 * resolved {@link AgentSettings} block + an {@link AgentType} to the provider that
 * should back that session and an optional per-type model override. It is the single
 * definition of "which backend runs this agent type", shared by both config/load.ts
 * (load-time validation that an `openai` selection has a configured provider) and the
 * daemon composition root (wiring the Codex vs Claude runners) — so the two can never
 * disagree about what a config means.
 *
 * This module imports only the config types: it is the leaf the wiring layers depend
 * on, never the other way around.
 */

import type {
  AgentSettings,
  AgentTypeRouting,
  PhasedAgentTypeRouting,
  ProviderName,
  ProvidersSettings,
  ReviewFixRouting,
  TierProfile,
} from "../config/schema";

/**
 * The four configurable agent-session types (issue #131 background taxonomy):
 * - `impl`     — the full agentic impl/resume/stuck-heal runner (Claude-only for now).
 * - `review`   — the structured review pass (Phase 1 normal AND Phase 2 thermo).
 * - `fix`      — the structured fix attempt (Phase-1/2 fixes, CI/rebase fixes, review resume).
 * - `autoMode` — the bounded moding classifier (opt-in, ADR-0021).
 *
 * "Thermo review" and "answered questions" are NOT separate types: thermo is `review`/`fix`
 * at Phase 2, and an answered escalation resumes whichever type paused.
 */
export type AgentType = "impl" | "review" | "fix" | "autoMode";

/** Every configurable agent type, in a stable order (load-time validation iterates it). */
export const AGENT_TYPES: readonly AgentType[] = ["impl", "review", "fix", "autoMode"];

/**
 * Which review/fix **phase** a dispatch is for, as the per-phase routing-key selector
 * (ADR-0037 #169): phase `1` = normal review/fix, phase `2` = behaviour-preserving thermo,
 * phase `0` = the CI-gate/merge fix — which has **no per-phase key** and resolves to `base`.
 * Mirrors `store/types` `Phase` structurally, so a call site can pass `ctx.phase` verbatim;
 * defined here (not imported) so this provider leaf stays config-only. Single-phase types
 * (`impl`/`autoMode`) never carry a phase — the resolver passes nothing.
 */
export type RoutingPhase = 0 | 1 | 2;

/**
 * An issue's complexity tier as the **impl routing-key selector** (issue #278): `1` =
 * hard/architectural, `2` = standard, `3` = routine/mechanical (lower = more demanding, the
 * `priority:p0` convention). Mirrors `store/types` `ComplexityTier` structurally — defined
 * here (not imported) so this provider leaf stays config-only, exactly as {@link RoutingPhase}
 * mirrors `Phase`. Only `impl` carries a tier (a tier is an impl agent profile); the resolver
 * ignores it for every other type.
 */
export type RoutingTier = 1 | 2 | 3;

/**
 * The tier's agent profile from `agent.tiers`, or `undefined` when the tier is absent/
 * unconfigured (issue #278). The one lookup shared by route resolution (`routes`) and the
 * dispatch profile fold (`effort` / `wallClockSeconds`), so the two can never disagree
 * about what a tier means. Pure.
 */
export function tierProfile(agent: AgentSettings, tier: RoutingTier | null | undefined): TierProfile | undefined {
  return tier == null ? undefined : agent.tiers[`${tier}`];
}

/** The provider chosen for one agent type, plus any per-type model override. */
export interface ProviderSelection {
  /** Which backend runs this agent type. */
  provider: ProviderName;
  /**
   * The per-type `model` override, if set. Interpreted against the chosen provider's
   * default: for `claude` it swaps `agent.model`; for `openai` it swaps
   * `providers.openai.model`. Absent → the provider's default model.
   */
  modelOverride?: string;
}

/**
 * Whether a `review`/`fix` routing value is the **per-phase object form** ({@link
 * PhasedAgentTypeRouting}) rather than the legacy single / ordered-list form (ADR-0037 #169). The
 * object form is the only non-array member carrying a `base` key. The config schema guarantees
 * only `review`/`fix` can hold it (impl/autoMode reject it via `.strict()`), so this trusts the
 * parsed shape rather than re-checking the type.
 */
function isPhasedRouting(routing: ReviewFixRouting): routing is PhasedAgentTypeRouting {
  return !Array.isArray(routing) && "base" in routing;
}

/** The object-form key for a phase, or `null` for phase 0 / no phase (→ `base`). */
function phaseKey(phase: RoutingPhase | undefined): "phase1" | "phase2" | null {
  return phase === 1 ? "phase1" : phase === 2 ? "phase2" : null;
}

/**
 * The effective {@link AgentTypeRouting} for `(type-routing, phase)` (ADR-0037 #169): for the
 * per-phase object form, `perPhase[phase] ?? base` — **whole-list replacement**, so a phase's
 * preference list is self-contained, never concatenated with `base`. For the legacy/list form (or
 * an absent override) the value applies to every phase, so it is returned verbatim. Pure.
 */
function effectiveRouting(
  routing: ReviewFixRouting | undefined,
  phase: RoutingPhase | undefined,
): AgentTypeRouting | undefined {
  if (routing !== undefined && isPhasedRouting(routing)) {
    const key = phaseKey(phase);
    return (key !== null ? routing[key] : undefined) ?? routing.base;
  }
  return routing;
}

/** Normalise an {@link AgentTypeRouting} (legacy single / ordered list / absent) to a preference list. */
function normaliseRouting(routing: AgentTypeRouting | undefined, defaultProvider: ProviderName): ProviderSelection[] {
  if (routing === undefined) {
    return [{ provider: defaultProvider }];
  }
  if (Array.isArray(routing)) {
    return routing.map((entry) =>
      entry.model ? { provider: entry.provider, modelOverride: entry.model } : { provider: entry.provider },
    );
  }
  const provider = routing.provider ?? defaultProvider;
  return [routing.model ? { provider, modelOverride: routing.model } : { provider }];
}

/**
 * Resolve a type's ordered **`(provider, model)` preference list** (ADR-0037 P1.2/#169). The
 * legacy single `{provider?, model?}` form normalises to a one-entry list (provider defaulting to
 * the global `agent.provider`); an explicit list is returned in order with each entry's model
 * travelling as its `modelOverride`. An absent `agent.types[type]` yields a one-entry list of the
 * global provider. Always non-empty. Pure — no I/O, no SDK.
 *
 * For `review`/`fix`, an optional `phase` selects the per-phase routing key (ADR-0037 #169): the
 * object form resolves `perPhase[phase] ?? base` (whole-list replacement); the legacy/list form
 * and phase 0 / no phase resolve `base`. `impl`/`autoMode` are single-phase and never carry the
 * object form, so passing a phase to them is a no-op — they resolve identically with or without it.
 *
 * For `impl`, an optional `tier` selects the per-tier routing key (issue #278): a configured
 * `agent.tiers[tier].routes` **replaces** the impl list whole (the same whole-list-replacement
 * semantics as the per-phase merge); an absent tier / unconfigured profile / profile with no
 * `routes` falls back to `types.impl`. A tier is impl-only — the resolver ignores it for every
 * other type (review/fix budgets stay uniform regardless of tier, ADR-0014).
 */
export function providerPreferenceList(
  agent: AgentSettings,
  type: AgentType,
  phase?: RoutingPhase,
  tier?: RoutingTier | null,
): ProviderSelection[] {
  const tierRoutes = type === "impl" ? tierProfile(agent, tier)?.routes : undefined;
  return normaliseRouting(tierRoutes ?? effectiveRouting(agent.types[type], phase), agent.provider);
}

/**
 * The **explicitly-overridden** per-phase preference lists for a `review`/`fix` type (ADR-0037
 * #169) — the per-phase deltas the read API surfaces so the editor can show `base` plus each
 * phase that deviates. Returns `{}` for a single-phase / unphased type (absent, legacy single, or
 * flat list); the base list is `providerPreferenceList(agent, type)`. Pure.
 */
export function perPhasePreferenceLists(
  agent: AgentSettings,
  type: AgentType,
): { phase1?: ProviderSelection[]; phase2?: ProviderSelection[] } {
  const routing = agent.types[type];
  if (routing === undefined || !isPhasedRouting(routing)) {
    return {};
  }
  const out: { phase1?: ProviderSelection[]; phase2?: ProviderSelection[] } = {};
  if (routing.phase1 !== undefined) {
    out.phase1 = normaliseRouting(routing.phase1, agent.provider);
  }
  if (routing.phase2 !== undefined) {
    out.phase2 = normaliseRouting(routing.phase2, agent.provider);
  }
  return out;
}

/**
 * Every `(provider, model)` preference list a type can resolve to **across all phases and
 * complexity tiers** (ADR-0037 #169; issue #278) — the base list, each explicitly-overridden
 * per-phase list (review/fix), and each configured tier's `routes` (impl). Load-time validation
 * walks this (not just the base) so a per-phase or per-tier entry naming an unconfigured/
 * capability-blocked provider fails loud at startup, not at the first matching dispatch hours
 * in. Single-phase, tier-less types yield just the base list. Pure.
 */
export function allPreferenceLists(agent: AgentSettings, type: AgentType): ProviderSelection[] {
  const perPhase = perPhasePreferenceLists(agent, type);
  const perTier =
    type === "impl"
      ? ([1, 2, 3] as const).flatMap((tier) =>
          agent.tiers[`${tier}`]?.routes ? providerPreferenceList(agent, type, undefined, tier) : [],
        )
      : [];
  return [
    ...providerPreferenceList(agent, type),
    ...(perPhase.phase1 ?? []),
    ...(perPhase.phase2 ?? []),
    ...perTier,
  ];
}

/**
 * Resolve the provider + optional model override for one agent type — the **head** of its
 * preference list ({@link providerPreferenceList}). A per-type override in `agent.types[type]`
 * wins over the global `agent.provider`; an absent override inherits the default. This is the
 * single provider the composition root wires today; falling through to later preference
 * entries (fallback at route resolution) is ADR-0037 slice 3+. Pure — no I/O, no SDK — so
 * both load.ts and the daemon can call it.
 */
export function providerForAgentType(agent: AgentSettings, type: AgentType): ProviderSelection {
  // The list is guaranteed non-empty, so the head is always present.
  return providerPreferenceList(agent, type)[0]!;
}

/**
 * The derived **in-session host-callback tools** capability per provider KIND (ADR-0037).
 * The capability is precisely: the agent invoking our host code mid-session (`escalate`,
 * `stuck`). `claude`/`zai` ride a tools-capable SDK path; bare `openai` (Codex SDK) does
 * **not** — yet (a self-clearing maturity flag, flipped when those tools are re-hosted as
 * an out-of-process MCP server). A provider's `toolsCapable` config overrides its default.
 */
export const PROVIDER_TOOLS_CAPABLE_DEFAULTS: Record<ProviderName, boolean> = {
  claude: true,
  openai: false,
  zai: true,
};

/**
 * Whether `provider` can host the in-session `escalate`/`stuck` tools, reading the
 * per-provider `toolsCapable` override from the `providers.*` block if set, else the
 * derived default ({@link PROVIDER_TOOLS_CAPABLE_DEFAULTS}). Pure — the single definition
 * of the capability the gate (a later slice) consults at config load, the web edit API,
 * and route resolution, so the three can never disagree about a provider's capability.
 */
export function providerToolsCapable(providers: ProvidersSettings, provider: ProviderName): boolean {
  return providers[provider]?.toolsCapable ?? PROVIDER_TOOLS_CAPABLE_DEFAULTS[provider];
}

/**
 * The agent types that **require in-session host-callback tools** (ADR-0037). The capability
 * is precisely the agent invoking our host code mid-session (`escalate`/`stuck`): only `impl`
 * needs it. `review`/`fix`/`autoMode` read(/edit) the worktree and emit one JSON object — no
 * tool call (`fix`'s escalate is a structured-output field, not a tool). A **Set**, not a
 * hardcoded four-way switch, so the type set is an **open list**: a future type defaults to
 * "no tools required" until it opts in here.
 */
const TYPES_REQUIRING_TOOLS: ReadonlySet<string> = new Set<AgentType>(["impl"]);

/**
 * Whether `type` requires in-session host-callback tools (ADR-0037 capability gate). `impl`
 * does; the structured types do not. **Open list**: an unknown type defaults to `false` (no
 * tools required), so new agent types are additive without touching the gate. Pure.
 */
export function requiresTools(type: AgentType): boolean {
  return TYPES_REQUIRING_TOOLS.has(type);
}

/**
 * The **capability gate** (ADR-0037), as one pure function: a type may route to a provider
 * iff `requiresTools(type) ⟹ provider is tools-capable`. Tools-capability is resolved via
 * {@link providerToolsCapable} (the per-provider `toolsCapable` override, else the derived
 * default). This single definition is consulted at config load (reject), the web edit API
 * (disable-with-reason), and route resolution (defence in depth), so the three can never
 * disagree about whether a `(type, provider)` pairing is allowed.
 */
export function capabilityOk(type: AgentType, provider: ProviderName, providers: ProvidersSettings): boolean {
  return !requiresTools(type) || providerToolsCapable(providers, provider);
}
