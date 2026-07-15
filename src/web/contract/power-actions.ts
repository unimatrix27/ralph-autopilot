/**
 * The **Tier-1 power actions** wire shape (ADR-0032, issue #114) — the browser-safe
 * contract for steering the backlog from the UI. These are **on-protocol GitHub
 * effects**: each action posts through the `gh` client port, and the reconciler
 * acts on it next tick (eventually-consistent — the UI never fakes immediacy).
 * Most are label swaps; readmitting an answerable question also posts a
 * `ralph-answer` comment so resumable pauses keep their correlation payload.
 * The five actions:
 *
 *   - `readmit`        — swap a paused/stuck human-attention label back to
 *                        `ready-for-agent` (re-arms the daemon);
 *   - `close`          — close the issue (destructive → **`confirm: true` required**);
 *   - `set-mode`       — swap the existing `mode:*` for `tdd` / `infra`;
 *   - `set-priority`   — swap any existing priority label for the chosen one (the
 *                        chosen label must be in the repo's configured `priorityLabels`);
 *   - `pause`/`unpause`— the `afk` ↔ `hitl` swap that holds an issue out of / returns
 *                        it to autonomous admission.
 *
 * Browser-safe like the rest of the leaf (zod only, zero node imports). The
 * additive-only evolution rule (ADR-0026) applies: extend the discriminated union, do
 * not reshape an existing arm.
 */
import { z } from "zod";
import { issueNumber, repoSlug } from "./primitives";

/**
 * The five action kinds. Surfaced as a literal list so the UI and the daemon share one
 * vocabulary (the response echoes the kind that was applied).
 */
export const POWER_ACTION_KINDS = [
  "readmit",
  "close",
  "set-mode",
  "set-priority",
  "pause",
  "unpause",
] as const;
export const powerActionKindSchema = z.enum(POWER_ACTION_KINDS);
export type PowerActionKindWire = z.infer<typeof powerActionKindSchema>;

/** The implementation modes (CONTEXT: Mode) — the value a `set-mode` carries. */
export const POWER_ACTION_MODES = ["tdd", "infra", "ui"] as const;
export const powerActionModeSchema = z.enum(POWER_ACTION_MODES);
export type PowerActionModeWire = z.infer<typeof powerActionModeSchema>;

/**
 * The power-action controls one read-model item may offer. The backend computes this
 * from the item's contract state and the repo's configured priority labels, so the UI
 * renders an explicit affordance instead of scattering its own action policy.
 */
export const powerActionAffordanceSchema = z
  .object({
    /** Action kinds the row/card may render, in display order. */
    actions: z.array(powerActionKindSchema),
    /** Configured priority labels for this repo; empty means no priority menu is offered. */
    priorityLabels: z.array(z.string()),
  })
  .strict();
export type PowerActionAffordanceWire = z.infer<typeof powerActionAffordanceSchema>;

/**
 * The read-model *surfaces* a row/card can belong to — the per-row state that selects
 * which affordance applies (CONTEXT: the eligibility-gate states a row sits in). The
 * affordance for any (repo, surface) pair is static across rows, so a row carries only
 * this tag and looks its affordance up in the response's one {@link powerActionCatalogSchema}
 * — the static descriptor is emitted once per (repo, surface), never per row.
 *   - `queued`      — an eligible/blocked issue (pause / set-mode / set-priority / close);
 *   - `attention`   — a paused/stuck human-attention row (readmit / close);
 *   - `manual-hold` — a `hitl`-held ready issue (unpause / set-mode / set-priority / close);
 *   - `moding`      — a ready+afk issue missing a `mode:*` (set-mode / close).
 */
export const POWER_ACTION_SURFACES = ["queued", "attention", "manual-hold", "moding"] as const;
export const powerActionSurfaceSchema = z.enum(POWER_ACTION_SURFACES);
export type PowerActionSurfaceWire = z.infer<typeof powerActionSurfaceSchema>;

/**
 * The per-response affordance catalog: the one place the static power-action descriptors
 * are serialized (issue #114 phase-2 P1 — stop repeating them on every row). Keyed by repo
 * (priority labels are repo-scoped) then by the surfaces that repo's rows actually use, each
 * mapping to its {@link powerActionAffordanceSchema}. A row carries its `repo` + a
 * {@link powerActionSurfaceSchema} tag and resolves `catalog[repo]?.[surface]`; the server is
 * still the single authority for the affordance policy (ADR-0029), it just emits it once.
 */
export const powerActionCatalogSchema = z.record(
  repoSlug,
  z.partialRecord(powerActionSurfaceSchema, powerActionAffordanceSchema),
);
export type PowerActionCatalogWire = z.infer<typeof powerActionCatalogSchema>;

const powerActionBaseShape = {
  repo: repoSlug,
  issue: issueNumber,
} as const;

/**
 * The `/api/backlog/action` request body — a discriminated variant at the wire edge:
 *   - `readmit` / `pause` / `unpause` carry no payload;
 *   - `close` carries a **required `confirm: true`** — the destructive-action guard
 *     (AC2). A close with `confirm` absent or `false` fails the schema parse at the
 *     contract edge and never reaches the port, so the issue cannot be closed without
 *     an explicit affirmative;
 *   - `set-mode` carries the target mode;
 *   - `set-priority` carries the target priority label (validated against the repo's
 *     configured `priorityLabels` in the port — the contract leaf cannot know it).
 *
 * `.strict()` on every arm means an unknown key (a typo) is rejected, not silently
 * dropped.
 */
export const powerActionRequestBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...powerActionBaseShape,
      kind: z.literal("readmit"),
    })
    .strict(),
  z
    .object({
      ...powerActionBaseShape,
      kind: z.literal("close"),
      /** Explicit operator confirmation — required to fire the destructive close (AC2). */
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...powerActionBaseShape,
      kind: z.literal("set-mode"),
      mode: powerActionModeSchema,
    })
    .strict(),
  z
    .object({
      ...powerActionBaseShape,
      kind: z.literal("set-priority"),
      /** The priority label to set; must be in the repo's configured `priorityLabels`. */
      priority: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...powerActionBaseShape,
      kind: z.literal("pause"),
    })
    .strict(),
  z
    .object({
      ...powerActionBaseShape,
      kind: z.literal("unpause"),
    })
    .strict(),
]);
export type PowerActionRequestBody = z.infer<typeof powerActionRequestBodySchema>;

/**
 * The `/api/backlog/action` response: which action was applied, and when the daemon acts
 * on it. `appliesNextTickSeconds` is the honest "the daemon acts next tick (~Ns)" figure —
 * the UI states this so the operator knows the effect is eventual, not immediate (ADR-0032:
 * no faked immediacy; the reconciler, not the write, moves the state).
 */
export const powerActionResponseSchema = z
  .object({
    /** ISO-8601 instant the action was written back to GitHub. */
    generatedAt: z.string(),
    repo: repoSlug,
    issue: issueNumber,
    /** The action kind that was applied (echoed so the UI can confirm what fired). */
    action: powerActionKindSchema,
    /**
     * The daemon's reconcile interval — the honest "acts next tick (~Ns)" figure. The UI
     * states this so the operator knows the action is eventual, not immediate (ADR-0032).
     */
    appliesNextTickSeconds: z.number().int().positive(),
  })
  .strict();
export type PowerActionResponse = z.infer<typeof powerActionResponseSchema>;
