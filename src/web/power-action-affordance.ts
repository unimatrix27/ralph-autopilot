/**
 * Pure affordance policy for Tier-1 power actions (issue #114, ADR-0029/0032).
 * Read-model transforms use this to derive the static UI affordances without depending
 * on the live GitHub write port in `power-actions.ts`.
 *
 * The affordance for a (surface, repo) pair is the same for every row of that pair, so the
 * transforms emit it **once** into the response's {@link PowerActionCatalogWire}
 * ({@link buildPowerActionCatalog}) and each row carries only its `repo` + surface tag —
 * never the full descriptor (issue #114 phase-2 P1). The server stays the single authority
 * for the policy (ADR-0029); deduping it does not move policy to the client.
 */
import type {
  PowerActionAffordanceWire,
  PowerActionCatalogWire,
  PowerActionKindWire,
  PowerActionSurfaceWire,
} from "./contract";

/** A read-model surface a row can belong to — the per-row state that selects its affordance. */
export type PowerActionSurface = PowerActionSurfaceWire;

const POWER_ACTIONS_BY_SURFACE: Record<PowerActionSurface, readonly PowerActionKindWire[]> = {
  queued: ["pause", "set-mode", "set-priority", "close"],
  attention: ["readmit", "close"],
  "manual-hold": ["unpause", "set-mode", "set-priority", "close"],
  moding: ["set-mode", "close"],
};

export function powerActionAffordance(
  surface: PowerActionSurface,
  configuredPriorityLabels: readonly string[],
): PowerActionAffordanceWire {
  const priorityLabels = [...configuredPriorityLabels];
  return {
    actions: POWER_ACTIONS_BY_SURFACE[surface].filter(
      (action) => action !== "set-priority" || priorityLabels.length > 0,
    ),
    priorityLabels,
  };
}

/** One row's reference into the catalog: its repo and the surface it sits in. */
export interface PowerActionRef {
  repo: string;
  surface: PowerActionSurface;
}

/**
 * Fold every row's (repo, surface) reference into the deduplicated affordance catalog the
 * response carries once. Each distinct (repo, surface) pair is computed a single time via
 * {@link powerActionAffordance}, so the static descriptor is never repeated per row.
 */
export function buildPowerActionCatalog(
  refs: Iterable<PowerActionRef>,
  priorityLabelsFor: (repo: string) => readonly string[],
): PowerActionCatalogWire {
  const catalog: PowerActionCatalogWire = {};
  for (const { repo, surface } of refs) {
    const perRepo = (catalog[repo] ??= {});
    if (!perRepo[surface]) {
      perRepo[surface] = powerActionAffordance(surface, priorityLabelsFor(repo));
    }
  }
  return catalog;
}
