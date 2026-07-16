/**
 * The **pure render-model transform** for the global routing editor (ADR-0037 P4.2, issue
 * #167) — the testable heart of the editor, mirroring {@link import("./run-view").buildRunView}'s
 * "wire response → render-model, tested in the node vitest env" convention. It folds the
 * {@link EffectiveRoutingResponse} the editor reads (`GET /api/routing`) into the model the
 * UI renders directly:
 *
 *   - one **row per agent type** carrying its current `(provider, model)` preference list and,
 *     for each provider KIND, a {@link ProviderOption} that is either selectable or
 *     **disabled-with-reason** — the capability gate (ADR-0037: `impl` needs in-session
 *     escalate/stuck tools; bare `openai` doesn't support them yet) and the unconfigured-account
 *     case, surfaced **never silently hidden**;
 *   - the **account pool** grouped by provider (every provider kind, including one with zero
 *     accounts), so the operator sees the configured credentials behind each route.
 *
 * It also builds the **wire-valid edit bodies** the editor posts (`POST /api/routing/edit`):
 * set a type's preference list (normalised to a list, blank models dropped) or clear its
 * override. The capability gate the UI shows is the SAME rule the store enforces on write
 * ({@link import("../../providers/select").capabilityOk}) — `requiresTools ⟹ toolsCapable` — so
 * a choice the editor leaves selectable is one the server will accept (and vice versa).
 *
 * Browser-safe (zod-typed inputs, pure helpers, **zero node imports**) so the UI imports it from
 * `@contract` and the node vitest exercises it without a React harness.
 */
import { ROUTING_PROVIDERS, typeIsPhaseable } from "./routing";
import type {
  EffectiveRoutingPhases,
  EffectiveRoutingProvider,
  EffectiveRoutingResponse,
  EffectiveRoutingType,
  RoutingAgentTypeWire,
  RoutingEditRequestBody,
  RoutingEntryWire,
  RoutingPhasedValueWire,
  RoutingProviderWire,
} from "./routing";

/** One provider choice for a type: selectable, or **disabled-with-reason** (capability/unconfigured). */
export interface ProviderOption {
  provider: RoutingProviderWire;
  /** Whether the provider can host the in-session escalate/stuck tools (the capability gate). */
  toolsCapable: boolean;
  /** Whether the provider has a usable account/credential block. */
  configured: boolean;
  /** `true` when this provider cannot be chosen for the type — render disabled, never hidden. */
  disabled: boolean;
  /** The human reason shown alongside a disabled option; `null` when the option is selectable. */
  reason: string | null;
}

/** One agent type's editor row: its current preference list + the per-provider option states. */
export interface TypeRoutingRow {
  type: RoutingAgentTypeWire;
  /** Whether this type requires in-session host-callback tools (only `impl` does). */
  requiresTools: boolean;
  /**
   * Whether this type's editor renders the per-phase form (`review`/`fix`): a `base` list plus
   * optional `phase1`/`phase2` overrides. `false` (`impl`/`autoMode`) ⇒ a single flat list, and
   * {@link phases} is always empty.
   */
  phaseable: boolean;
  /**
   * The current effective `(provider, model)` preference list route resolution walks in order. For a
   * phaseable type this is the **base** list (the fallback for phases without an override).
   */
  preference: RoutingEntryWire[];
  /**
   * The currently-set per-phase overrides (`review`/`fix` only) — only the phases that deviate from
   * {@link preference}. Empty for a single-phase type or a phaseable type with no override yet.
   */
  phases: EffectiveRoutingPhases;
  /** One option per provider KIND (in {@link ROUTING_PROVIDERS} order), selectable or disabled-with-reason. */
  providerOptions: ProviderOption[];
}

/** One pool account as the editor renders it: the id chip plus its operator-park toggle state. */
export interface AccountPoolEntry {
  id: string;
  /** `false` = operator-parked (invisible to dispatch until re-enabled, issue #10). */
  enabled: boolean;
}

/** One account-pool group: a provider KIND, its capability/config state, and its accounts. */
export interface AccountPoolGroup {
  provider: RoutingProviderWire;
  configured: boolean;
  toolsCapable: boolean;
  /** The configured accounts for this provider (possibly empty), each with its enabled state. */
  accounts: AccountPoolEntry[];
}

/** The whole render-model the editor consumes (ADR-0037 P4.2). */
export interface RoutingEditorModel {
  /** ISO-8601 instant the routing was read (echoed from the response). */
  generatedAt: string;
  /** The repo the routing resolved for, or `null` for the global view (v1: always global). */
  repo: string | null;
  /** The global default provider a type without an override falls back to. */
  defaultProvider: RoutingProviderWire;
  /** The global default model. */
  defaultModel: string;
  /** One row per agent type, in response order. */
  rows: TypeRoutingRow[];
  /** The account pool grouped by provider (every provider kind, never hidden). */
  pool: AccountPoolGroup[];
}

/**
 * The disabled-with-reason for choosing `provider` for `type`, or `null` when selectable. The
 * **capability gate** (ADR-0037) is the principled, primary constraint — a type that requires
 * in-session escalate/stuck tools cannot route to a non-tools-capable provider — so it is
 * reported first when both it and the unconfigured case apply. Mirrors `capabilityOk` exactly:
 * `requiresTools ⟹ toolsCapable`. The unconfigured case is the secondary gate (a provider with
 * no account/block would be rejected on write too), surfaced with its own reason.
 */
export function providerDisabledReason(
  type: EffectiveRoutingType,
  provider: EffectiveRoutingProvider,
): string | null {
  if (type.requiresTools && !provider.toolsCapable) {
    return `${type.type} needs in-session escalate/stuck tools; ${provider.provider} doesn't support them yet`;
  }
  if (!provider.configured) {
    return `${provider.provider} has no configured account`;
  }
  return null;
}

/** Build the per-provider option list for a type, every provider KIND present and ordered. */
export function providerOptionsFor(
  type: EffectiveRoutingType,
  providers: EffectiveRoutingProvider[],
): ProviderOption[] {
  const byProvider = new Map(providers.map((p) => [p.provider, p]));
  return ROUTING_PROVIDERS.map((provider) => {
    const p: EffectiveRoutingProvider = byProvider.get(provider) ?? {
      provider,
      configured: false,
      toolsCapable: false,
    };
    const reason = providerDisabledReason(type, p);
    return {
      provider,
      toolsCapable: p.toolsCapable,
      configured: p.configured,
      disabled: reason !== null,
      reason,
    };
  });
}

/** Fold the effective-routing response into the editor render-model (pure, browser-safe). */
export function buildRoutingEditorModel(res: EffectiveRoutingResponse): RoutingEditorModel {
  const rows: TypeRoutingRow[] = res.types.map((type) => ({
    type: type.type,
    requiresTools: type.requiresTools,
    phaseable: typeIsPhaseable(type.type),
    preference: type.preference,
    phases: type.phases ?? {},
    providerOptions: providerOptionsFor(type, res.providers),
  }));
  const byProvider = new Map(res.providers.map((p) => [p.provider, p]));
  const pool: AccountPoolGroup[] = ROUTING_PROVIDERS.map((provider) => ({
    provider,
    configured: byProvider.get(provider)?.configured ?? false,
    toolsCapable: byProvider.get(provider)?.toolsCapable ?? false,
    accounts: res.accounts
      .filter((a) => a.provider === provider)
      .map((a) => ({ id: a.id, enabled: a.enabled })),
  }));
  return {
    generatedAt: res.generatedAt,
    repo: res.repo,
    defaultProvider: res.defaultProvider,
    defaultModel: res.defaultModel,
    rows,
    pool,
  };
}

/** A model entry whose `model` is present is only valid when it is a non-blank string. */
function entryModelOk(entry: RoutingEntryWire): boolean {
  return entry.model === undefined || entry.model.trim().length > 0;
}

/**
 * Whether `entries` is a postable preference list for `row`: non-empty, every provider
 * selectable (not disabled-with-reason for this type), and any present model non-blank. The
 * editor disables Save when this is false, so it never posts an edit the store would reject
 * (the capability gate is the same rule on both sides).
 */
export function preferenceIsPostable(row: TypeRoutingRow, entries: RoutingEntryWire[]): boolean {
  if (entries.length === 0) {
    return false;
  }
  const selectable = new Set(row.providerOptions.filter((o) => !o.disabled).map((o) => o.provider));
  return entries.every((entry) => selectable.has(entry.provider) && entryModelOk(entry));
}

/** Normalise a UI entry: drop a blank/absent model so the entry falls back to the provider default. */
export function normaliseEntry(entry: RoutingEntryWire): RoutingEntryWire {
  const model = entry.model?.trim();
  return model ? { provider: entry.provider, model } : { provider: entry.provider };
}

/**
 * Build the `POST /api/routing/edit` body that **sets** a type's preference list (ADR-0037 P4.2),
 * normalised to a list with blank models dropped. The edit is global in v1 (no `repo`).
 */
export function buildSetRoutingEdit(
  type: RoutingAgentTypeWire,
  entries: RoutingEntryWire[],
): RoutingEditRequestBody {
  return { target: "type", type, routing: entries.map(normaliseEntry) };
}

/** Build the `POST /api/routing/edit` body that **clears** a type's override (falls back to default). */
export function buildClearRoutingEdit(type: RoutingAgentTypeWire): RoutingEditRequestBody {
  return { target: "type", type, routing: null };
}

/**
 * Build the `POST /api/routing/edit` body that **parks / un-parks** one pool account by resolved
 * pool id (issue #10, the account arm). Reversible with next-dispatch effect only — in-flight
 * runs finish on the route they were dispatched with (ADR-0038) — so no confirm escalation; the
 * origin guard applies by construction (ADR-0032). The server rejects a toggle that would leave
 * a provider any preference list selects with zero enabled accounts.
 */
export function buildAccountToggleEdit(id: string, enabled: boolean): RoutingEditRequestBody {
  return { target: "account", id, enabled };
}

/** A per-phase draft for a phaseable type (`review`/`fix`): a required base list + optional overrides. */
export interface PhasedDraft {
  /** The base preference list — the fallback for any phase without an override (always present). */
  base: RoutingEntryWire[];
  /** The Phase-1 (normal review/fix) override, or `undefined` when the phase inherits `base`. */
  phase1?: RoutingEntryWire[];
  /** The Phase-2 (thermo) override, or `undefined` when the phase inherits `base`. */
  phase2?: RoutingEntryWire[];
}

/**
 * Whether a {@link PhasedDraft} is postable for `row`: the base list and every present per-phase
 * override are each a postable preference list ({@link preferenceIsPostable} — non-empty, every
 * provider selectable, models non-blank). The editor disables Save when this is false, so it never
 * posts an edit the store would reject (the capability gate is the same rule on both sides).
 */
export function phasedPreferenceIsPostable(row: TypeRoutingRow, draft: PhasedDraft): boolean {
  // base is always present, so its undefined arm never fires; an absent phase override is postable.
  return [draft.base, draft.phase1, draft.phase2].every(
    (list) => list === undefined || preferenceIsPostable(row, list),
  );
}

/**
 * Build the `POST /api/routing/edit` body for a phaseable type (`review`/`fix`, ADR-0037 #169).
 * When neither phase carries an override the draft **collapses to the flat list form** (the plain
 * base list, same body {@link buildSetRoutingEdit} produces) so config.yaml stays unphased until a
 * per-phase override is actually set; otherwise it posts the per-phase object form
 * ({@link RoutingPhasedValueWire}) with `base` + the present overrides, each list normalised
 * (blank models dropped) exactly like the single-list path.
 */
export function buildPhasedRoutingEdit(type: RoutingAgentTypeWire, draft: PhasedDraft): RoutingEditRequestBody {
  if (draft.phase1 === undefined && draft.phase2 === undefined) {
    return buildSetRoutingEdit(type, draft.base);
  }
  const routing: RoutingPhasedValueWire = { base: draft.base.map(normaliseEntry) };
  if (draft.phase1 !== undefined) {
    routing.phase1 = draft.phase1.map(normaliseEntry);
  }
  if (draft.phase2 !== undefined) {
    routing.phase2 = draft.phase2.map(normaliseEntry);
  }
  return { target: "type", type, routing };
}
