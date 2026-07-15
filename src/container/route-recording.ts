/**
 * Recording the resolved route a phase's container was dispatched on (ADR-0037 P3.1, issue #164).
 *
 * The daemon resolves a run's route **pre-dispatch** (#220) and carries it into the container, so
 * at the dispatch call site it already knows what it dispatched — no telemetry round-trip is
 * needed to *record* it. This is the single seam the three container runners (impl, review, fix)
 * share to append the `RouteResolved` business fact at dispatch, mapping the credential-carrying
 * {@link ContainerRoute} down to the read-API-safe {@link PhaseRoute} (the account **id** only,
 * never its credential). The projection folds the latest route onto the run (latest-wins), so the
 * fleet view shows the live phase's route and the run-detail timeline shows it per past phase.
 */
import type { ContainerRoute } from "./assignment";
import type { Logger } from "../log/logger";
import type { PhaseRoute } from "../store/types";

/**
 * The narrow store port a container runner records its resolved route through — one append of the
 * `RouteResolved` fact at dispatch. The daemon's `ScopedStore` satisfies it structurally; tests
 * inject a real memory-DB store or a fake. Optional on the runners (a routing-agnostic setup / a
 * unit test may omit it), so recording is strictly best-effort.
 */
export interface RouteRecordingStore {
  recordRouteResolved(input: {
    runId: number;
    issueNumber: number;
    /** The dispatched phase's label (`impl` / `review-1` / `fix-1` / …, the `setAgentPhase` vocabulary). */
    phase: string;
    /** The resolved route (account **id** only). Always present — a route-less dispatch records nothing. */
    route: PhaseRoute;
  }): Promise<void>;
}

/**
 * Project a resolved {@link ContainerRoute} (which carries the full {@link import("../config/schema").Account})
 * down to the read-model {@link PhaseRoute}: provider + optional model + the account **id** only.
 * The credential never leaves the daemon — the read API / web contract see the id alone (ADR-0031).
 */
export function toPhaseRoute(route: ContainerRoute): PhaseRoute {
  return route.model !== undefined
    ? { provider: route.provider, model: route.model, account: route.account.id }
    : { provider: route.provider, account: route.account.id };
}

/**
 * Record the route a phase's container was dispatched on (ADR-0037 P3.1) — the shared, best-effort
 * recording the impl and review/fix runners call at dispatch. A no-op unless all of `store`,
 * `runId`, and a resolved `route` are present (a box-default / routing-agnostic dispatch records
 * nothing — there is no `{ provider, model, account }` to record). **Visibility must never break a
 * dispatch**: an append failure is logged and swallowed, exactly the best-effort discipline the
 * telemetry pipe uses (a dropped signal degrades the read view, never loses work).
 */
export async function recordDispatchedRoute(input: {
  store?: RouteRecordingStore;
  runId?: number;
  issueNumber: number;
  phase: string;
  route: ContainerRoute | null;
  logger: Logger;
}): Promise<void> {
  const { store, runId, route } = input;
  if (!store || runId == null || !route) {
    return;
  }
  try {
    await store.recordRouteResolved({
      runId,
      issueNumber: input.issueNumber,
      phase: input.phase,
      route: toPhaseRoute(route),
    });
  } catch (err) {
    input.logger.warn("container.route-unrecorded", { issue: input.issueNumber, phase: input.phase, error: String(err) });
  }
}
