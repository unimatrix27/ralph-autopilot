/**
 * The **runtime routing** wire shape (ADR-0037 P4.1, issue #166) — the browser-safe
 * contract for the live routing surface: read the **effective routing** and **set/clear**
 * a per-type `(provider, model)` preference list with no daemon restart. Both the daemon
 * (serialize/parse) and the editor UI (#167) share this leaf, so a drift is a compile
 * error, not a silent mis-fire.
 *
 * Two halves:
 *   - **GET `/api/routing`** — the effective routing (global): every agent type's resolved
 *     preference list, the provider capability matrix (so the editor disables an invalid
 *     pairing instead of hiding it), and the account-pool summary. `?repo=` is accepted for
 *     forward-compatible per-repo deviation (#170) but ignored in v1 — the patch is empty,
 *     so every repo resolves the global routing.
 *   - **POST `/api/routing/edit`** — set or clear one type's preference list. The change lands
 *     in the in-memory overlay route resolution reads each dispatch AND writes through to
 *     `config.yaml`. Effect is the **next** dispatch (≈ next tick); an in-flight container
 *     finishes on the route it started with. Origin-guarded (ADR-0032): a cross-origin POST is
 *     rejected with 403 before it reaches the route; the capability gate rejects an invalid
 *     pairing (e.g. `impl → openai`) at the contract edge.
 *
 * Browser-safe like the rest of the leaf (zod only, zero node imports). The additive-only
 * evolution rule (ADR-0026) applies: extend the `target` discriminated union (a future
 * account / provider edit is a new arm), do not reshape an existing one.
 */
import { z } from "zod";
import { providerName, repoSlug } from "./primitives";

/**
 * The provider KINDs a route entry may name (ADR-0033/0034): `claude` (Claude SDK),
 * `openai` (Codex SDK), `zai` (GLM behind an Anthropic-compatible endpoint). Derived from
 * the canonical wire enum {@link providerName} in the `primitives` leaf — `routeSchema`'s
 * provider and this routing-editor contract share **one** source of truth, so a 4th provider
 * lands in `primitives` once and both move together (no lockstep edit, no silent divergence).
 * Re-exported here under the routing-domain names existing consumers (`web/routing-actions.ts`,
 * the public surface) use. Browser-safe like the rest of the leaf (zod only, no config import).
 */
export const routingProviderSchema = providerName;
export const ROUTING_PROVIDERS = providerName.options;
export type RoutingProviderWire = z.infer<typeof routingProviderSchema>;

/**
 * The four configurable agent-session types (ADR-0033). An open list at the resolver
 * (a future type is additive), but the editable keys are these four in v1. Mirrors
 * `providers/select.ts` `AGENT_TYPES`, kept here so the contract leaf has no node import.
 */
export const ROUTING_AGENT_TYPES = ["impl", "review", "fix", "autoMode"] as const;
export const routingAgentTypeSchema = z.enum(ROUTING_AGENT_TYPES);
export type RoutingAgentTypeWire = z.infer<typeof routingAgentTypeSchema>;

/**
 * The agent types that run as **numbered phases** and so carry per-phase routing (ADR-0037 #169,
 * issue #250): a `base` preference list plus optional `phase1` (normal) / `phase2` (thermo)
 * overrides. Only `review`/`fix` are phased; `impl`/`autoMode` are single-phase (a flat list).
 * The **single source of truth** for this rule: the `routingEditRequestBody` refine below rejects a
 * per-phase body on a non-phaseable type via {@link typeIsPhaseable}, and the editor render-model
 * (`routing-editor.ts`) imports it to decide which types render the base + per-phase form — so the
 * API gate and the UI can't drift (mirrors the {@link ROUTING_PROVIDERS} single-source convention above).
 */
export const ROUTING_PHASEABLE_TYPES = ["review", "fix"] as const satisfies readonly RoutingAgentTypeWire[];

/** Whether `type` runs as numbered phases (`review`/`fix`) — carries a base + optional per-phase routing. */
export function typeIsPhaseable(type: RoutingAgentTypeWire): boolean {
  return (ROUTING_PHASEABLE_TYPES as readonly RoutingAgentTypeWire[]).includes(type);
}

/**
 * One `(provider, model)` preference entry. `model` is the per-type model for that provider
 * (model ids are not portable across providers, so the model travels with the entry, never
 * the account); absent → the provider's default model.
 */
export const routingEntrySchema = z
  .object({
    provider: routingProviderSchema,
    model: z.string().min(1).optional(),
  })
  .strict();
export type RoutingEntryWire = z.infer<typeof routingEntrySchema>;

/**
 * A type's routing VALUE to set: either a single `(provider, model)` entry (normalised to a
 * one-entry list) or an ordered preference list (first-qualifying wins at route resolution).
 * At least one entry — an empty list is rejected at the edge. Structurally assignable to the
 * config schema's `AgentTypeRouting`, so the overlay can store it verbatim.
 */
export const routingValueSchema = z.union([
  routingEntrySchema,
  z.array(routingEntrySchema).min(1, "preference list must have at least one entry"),
]);
export type RoutingValueWire = z.infer<typeof routingValueSchema>;

/**
 * The **per-phase** routing value for `review`/`fix` (ADR-0037 #169): a required `base`
 * preference list (applies to every phase with no override) plus optional `phase1` (normal) and
 * `phase2` (thermo) overrides — the numbered Phase-1/Phase-2 vocabulary. Each value is a
 * {@link routingValueSchema}; the per-phase list **replaces** `base` for that phase (whole-list
 * replacement). `base` is required so a `phaseN`-only edit can't strand the other phase at
 * permanent `no-provider`. Structurally assignable to the config schema's `PhasedAgentTypeRouting`,
 * so the overlay stores it verbatim. Only valid for `review`/`fix` — the edit body refines that.
 */
export const routingPhasedValueSchema = z
  .object({
    base: routingValueSchema,
    phase1: routingValueSchema.optional(),
    phase2: routingValueSchema.optional(),
  })
  .strict();
export type RoutingPhasedValueWire = z.infer<typeof routingPhasedValueSchema>;

/**
 * A `review`/`fix` type's settable routing (ADR-0037 #169): the {@link routingValueSchema}
 * single/list form (= base-for-all-phases) **or** the per-phase {@link routingPhasedValueSchema}
 * object form. `impl`/`autoMode` accept only the former; the edit body rejects the object form for
 * them (mirroring the config schema's `.strict()`).
 */
export const routingValueOrPhasedSchema = z.union([routingValueSchema, routingPhasedValueSchema]);
export type RoutingValueOrPhasedWire = z.infer<typeof routingValueOrPhasedSchema>;

/** Whether a settable routing value is the per-phase object form (vs a single entry / a list). */
export function isPhasedRoutingValue(
  value: RoutingValueOrPhasedWire,
): value is RoutingPhasedValueWire {
  return !Array.isArray(value) && "base" in value;
}

/**
 * The `/api/routing/edit` request body — a discriminated union on `target` so account /
 * provider edits are additive arms later (#170 / a follow-up), never a reshape of this one.
 * The v1 arm edits a **type's preference list**: `routing` carries the new value, or `null`
 * to **clear** the override (the type falls back to the global default provider). `repo` is
 * accepted for forward-compatible per-repo deviation (#170) but ignored in v1 — the edit is
 * global.
 */
export const routingEditRequestBodySchema = z
  .discriminatedUnion("target", [
    z
      .object({
        target: z.literal("type"),
        /** Forward-compat per-repo key (#170); ignored in v1 — the edit applies globally. */
        repo: repoSlug.optional(),
        /** The agent type whose preference list is being set or cleared. */
        type: routingAgentTypeSchema,
        /**
         * The new routing, or `null` to clear the override. A single entry / preference list
         * (base-for-all-phases), or — for `review`/`fix` only — the per-phase object form
         * ({@link routingPhasedValueSchema}); a per-phase object on a single-phase type is rejected
         * by the refine below (ADR-0037 #169).
         */
        routing: routingValueOrPhasedSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((body, ctx) => {
    // Per-phase routing (base/phase1/phase2) is only meaningful for review/fix — impl/autoMode are
    // single-phase. Reject the object form for them at the contract edge, mirroring the config
    // schema's `.strict()` rejection so the API and the file agree (ADR-0037 #169).
    if (body.routing !== null && isPhasedRoutingValue(body.routing) && !typeIsPhaseable(body.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["routing"],
        message: `per-phase routing (base/phase1/phase2) is only valid for review/fix, not '${body.type}' (single-phase)`,
      });
    }
  });
export type RoutingEditRequestBody = z.infer<typeof routingEditRequestBodySchema>;

/**
 * The `/api/routing/edit` response: which type was edited, whether it was cleared, and the
 * honest "the new route takes effect next dispatch (~Ns)" figure — the UI states this so the
 * operator knows an in-flight container is unaffected and the effect is the next agent start.
 */
export const routingEditResponseSchema = z
  .object({
    /** ISO-8601 instant the edit was written to the overlay + config.yaml. */
    generatedAt: z.string(),
    /** The edit target (always `"type"` in v1). */
    target: z.literal("type"),
    /** The agent type whose routing was changed. */
    type: routingAgentTypeSchema,
    /** `true` when the override was cleared (the type now uses the global default). */
    cleared: z.boolean(),
    /**
     * The reconcile interval — the honest "the new route takes effect on the next dispatch
     * (~Ns)" figure. An in-flight container finishes on the route it started with (ADR-0038).
     */
    appliesNextDispatchSeconds: z.number().int().positive(),
  })
  .strict();
export type RoutingEditResponse = z.infer<typeof routingEditResponseSchema>;

/**
 * One agent type's effective routing: its `base` resolved preference list + whether it needs tools,
 * plus — for `review`/`fix` with a per-phase override (ADR-0037 #169) — the explicitly-overridden
 * `phase1`/`phase2` lists. `preference` is always the **base** list (the all-phases default);
 * `phases` carries only the phases that deviate (absent / empty for a single-phase or unphased
 * type). The per-phase visual editor (#170 / Scope C) renders base + these; the resolver applies
 * `perPhase[phase] ?? base`.
 */
export const effectiveRoutingPhasesSchema = z
  .object({
    /** The Phase-1 (normal review/fix) override list, if the config sets one. */
    phase1: z.array(routingEntrySchema).optional(),
    /** The Phase-2 (thermo / behaviour-preserving) override list, if the config sets one. */
    phase2: z.array(routingEntrySchema).optional(),
  })
  .strict();
export type EffectiveRoutingPhases = z.infer<typeof effectiveRoutingPhasesSchema>;

export const effectiveRoutingTypeSchema = z
  .object({
    type: routingAgentTypeSchema,
    /**
     * Whether this type requires in-session host-callback tools (`escalate`/`stuck`). Only
     * `impl` does — so the editor knows to disable a non-tools-capable provider for it.
     */
    requiresTools: z.boolean(),
    /** The resolved **base** `(provider, model)` preference list (the all-phases default). */
    preference: z.array(routingEntrySchema),
    /**
     * The per-phase overrides for `review`/`fix` (ADR-0037 #169): only the phases that deviate
     * from `base`. Absent for a single-phase (`impl`/`autoMode`) or unphased type.
     */
    phases: effectiveRoutingPhasesSchema.optional(),
  })
  .strict();
export type EffectiveRoutingType = z.infer<typeof effectiveRoutingTypeSchema>;

/** One provider's capability state for the editor: configured + tools-capable. */
export const effectiveRoutingProviderSchema = z
  .object({
    provider: routingProviderSchema,
    /**
     * Whether the provider is usable: `claude` is always available (box-default login);
     * `openai`/`zai` need a configured `providers.*` block.
     */
    configured: z.boolean(),
    /** Whether the provider can host the in-session `escalate`/`stuck` tools (the gate). */
    toolsCapable: z.boolean(),
  })
  .strict();
export type EffectiveRoutingProvider = z.infer<typeof effectiveRoutingProviderSchema>;

/** One account-pool entry, model-free (ADR-0037). Read-only in this slice (#166). */
export const effectiveRoutingAccountSchema = z
  .object({
    id: z.string(),
    provider: routingProviderSchema,
  })
  .strict();
export type EffectiveRoutingAccount = z.infer<typeof effectiveRoutingAccountSchema>;

/**
 * The `/api/routing` response — the effective routing (global) the editor reads. In v1 the
 * per-repo patch is empty, so this is the global routing for every `?repo=`. Carries the
 * global default provider/model, every type's resolved preference list, the provider
 * capability matrix, and the account-pool summary.
 */
export const effectiveRoutingResponseSchema = z
  .object({
    /** ISO-8601 instant the routing was read. */
    generatedAt: z.string(),
    /** The repo the routing was resolved for, or `null` for the global/aggregate view (v1: always global). */
    repo: repoSlug.nullable(),
    /** The global default provider every type without an override falls back to. */
    defaultProvider: routingProviderSchema,
    /** The global default model (the claude default; per-type/per-provider overrides travel with entries). */
    defaultModel: z.string(),
    /** Every agent type's effective routing. */
    types: z.array(effectiveRoutingTypeSchema),
    /** The provider capability matrix (configured + tools-capable per provider). */
    providers: z.array(effectiveRoutingProviderSchema),
    /** The account-pool summary (read-only in this slice; runtime pool edits are a later slice). */
    accounts: z.array(effectiveRoutingAccountSchema),
  })
  .strict();
export type EffectiveRoutingResponse = z.infer<typeof effectiveRoutingResponseSchema>;
