/**
 * The web adapter for the runtime **routing** surface (ADR-0037 P4.1, issue #166) — the
 * node-side port behind `/api/routing` (read the effective routing) and `/api/routing/edit`
 * (set/clear a type's preference list). It is a thin shell over the {@link RoutingStore}
 * overlay: the read serialises the store's snapshot into the wire shape (resolving each type's
 * preference list + the provider capability matrix), and the write threads the edit to the
 * store and maps its outcome to a domain result the HTTP adapter turns into a status.
 *
 * Kept node-side (it references `providers/select` + the config-side store, not browser-safe),
 * mirroring `power-actions.ts`. The validation that matters (the capability gate) lives in the
 * store's `applyEdit`, the single place the gate is enforced for runtime edits; this module only
 * shapes the wire contract.
 */
import type {
  EffectiveRoutingPhases,
  EffectiveRoutingResponse,
  RoutingEditRequestBody,
  RoutingEditResponse,
  RoutingEntryWire,
} from "./contract";
import { ROUTING_PROVIDERS } from "./contract";
import {
  AGENT_TYPES,
  perPhasePreferenceLists,
  providerPreferenceList,
  providerToolsCapable,
  requiresTools,
  type ProviderSelection,
} from "../providers/select";
import type { RoutingEdit, RoutingEditOutcome, RoutingSnapshot } from "../config/routing-store";

/**
 * The store-shaped capability the routing port reads through (ADR-0029: the web layer depends
 * only on a port). Backed in production by the {@link RoutingStore}; tests inject a fake.
 */
export interface RoutingControlPort {
  /** The global routing snapshot to serialise (agent + providers + resolved account pool). */
  snapshot(): RoutingSnapshot;
  /** Apply one routing edit (validate + write-through + commit overlay); returns the outcome. */
  applyEdit(edit: RoutingEdit): RoutingEditOutcome;
}

export interface RoutingActionDeps {
  now: () => Date;
  /** The reconcile interval — the honest "takes effect next dispatch (~Ns)" figure. */
  reconcileIntervalSeconds: number;
  routing: RoutingControlPort;
}

/**
 * The domain outcome of a routing edit — the HTTP adapter maps each branch to a status:
 *   - `applied` → 200 (the overlay + config.yaml were updated);
 *   - `bad-request` → 400 (a capability-invalid pairing, or a config the edit would un-loadable).
 */
export type RoutingEditPortResult =
  | { kind: "applied"; response: RoutingEditResponse }
  | { kind: "bad-request"; error: string };

/** Serialise a resolved `(provider, model)` preference list into the wire `(provider, model?)` shape. */
function toWireEntries(list: ProviderSelection[]): RoutingEntryWire[] {
  return list.map((entry) =>
    entry.modelOverride !== undefined
      ? { provider: entry.provider, model: entry.modelOverride }
      : { provider: entry.provider },
  );
}

/**
 * Serialise the effective routing (global) for `/api/routing` (ADR-0037 P4.1/#169): every agent
 * type's resolved **base** `(provider, model)` preference list, its per-phase overrides (review/fix
 * object form — only the phases that deviate from base), the provider capability matrix (configured
 * + tools-capable), and the account-pool summary. `query.repo` is accepted for forward-compatible
 * per-repo deviation (#170) but echoed verbatim — v1 resolves the global routing for every repo.
 */
export function getEffectiveRouting(query: { repo?: string }, deps: RoutingActionDeps): EffectiveRoutingResponse {
  const snap = deps.routing.snapshot();
  const types = AGENT_TYPES.map((type) => {
    // The per-phase overrides (review/fix object form, ADR-0037 #169) the read surfaces alongside
    // the base list; absent for a single-phase / unphased type → no `phases` key.
    const perPhase = perPhasePreferenceLists(snap.agent, type);
    const phases: EffectiveRoutingPhases = {};
    if (perPhase.phase1 !== undefined) {
      phases.phase1 = toWireEntries(perPhase.phase1);
    }
    if (perPhase.phase2 !== undefined) {
      phases.phase2 = toWireEntries(perPhase.phase2);
    }
    return {
      type,
      requiresTools: requiresTools(type),
      preference: toWireEntries(providerPreferenceList(snap.agent, type)),
      ...(phases.phase1 !== undefined || phases.phase2 !== undefined ? { phases } : {}),
    };
  });
  const providers = ROUTING_PROVIDERS.map((provider) => ({
    provider,
    // `claude` is always available (box-default login); `openai`/`zai` need a configured block.
    configured: provider === "claude" || snap.providers[provider] !== undefined,
    toolsCapable: providerToolsCapable(snap.providers, provider),
  }));
  // The pool with each account's operator-park state (issue #10): the registry stays whole —
  // a disabled account is marked, never hidden, so the editor can offer the re-enable toggle.
  const disabledAccounts = new Set(snap.disabledAccounts);
  const accounts = snap.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    enabled: !disabledAccounts.has(account.id),
  }));
  return {
    generatedAt: deps.now().toISOString(),
    repo: query.repo ?? null,
    defaultProvider: snap.agent.provider,
    defaultModel: snap.agent.model,
    types,
    providers,
    accounts,
  };
}

/**
 * Apply one routing edit for `/api/routing/edit` (ADR-0037 P4.1): set or clear a type's preference
 * list, or park / un-park one pool account (issue #10, the account arm). `body.repo` is accepted
 * (forward-compat #170) but ignored — the edit is global in v1. The store validates (capability
 * gate + full load-time validation — an account edit that would strand a selected provider with
 * zero enabled accounts is rejected there) and writes through to config.yaml; a rejected edit
 * returns `bad-request` with a clear reason. Never throws on a bad edit.
 */
export function executeRoutingEdit(body: RoutingEditRequestBody, deps: RoutingActionDeps): RoutingEditPortResult {
  if (body.target === "account") {
    const outcome = deps.routing.applyEdit({ target: "account", id: body.id, enabled: body.enabled });
    if (!outcome.ok) {
      return { kind: "bad-request", error: outcome.error };
    }
    return {
      kind: "applied",
      response: {
        generatedAt: deps.now().toISOString(),
        target: "account",
        id: body.id,
        enabled: body.enabled,
        appliesNextDispatchSeconds: deps.reconcileIntervalSeconds,
      },
    };
  }
  const outcome = deps.routing.applyEdit({ target: "type", type: body.type, routing: body.routing });
  if (!outcome.ok) {
    return { kind: "bad-request", error: outcome.error };
  }
  return {
    kind: "applied",
    response: {
      generatedAt: deps.now().toISOString(),
      target: "type",
      type: body.type,
      cleared: outcome.cleared,
      appliesNextDispatchSeconds: deps.reconcileIntervalSeconds,
    },
  };
}
