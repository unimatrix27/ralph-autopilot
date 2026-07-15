/**
 * Pure render helpers for a dispatched **route** (ADR-0037 P3.2, issue #165) — the browser-safe
 * formatter both the fleet/overview row and the run-detail per-phase timeline render through, so
 * the live route and the historical per-phase route are written the same way and can never drift.
 *
 * The wire {@link Route} (`./primitives`) carries `provider` + `account` always and `model`
 * nullable (null = the provider's default model). The formatter degrades gracefully on the one
 * optional field: a default-model route drops the model segment rather than rendering an empty
 * one. Zero node imports, like the rest of the leaf.
 */
import type { Route } from "./primitives";

/** The middot used to join a route's segments (`claude · opus · A`). */
export const ROUTE_SEPARATOR = " · ";

/**
 * Render a route as `provider · model · account` (e.g. `claude · opus · A`). When `model` is null
 * — the provider's default model — the segment is dropped, so the line reads `provider · account`
 * (e.g. `zai · z3`) rather than carrying an empty middot. `provider` and `account` are always
 * present on the wire, so they always render. Pure and total.
 */
export function formatRoute(route: Route): string {
  const segments = route.model === null ? [route.provider, route.account] : [route.provider, route.model, route.account];
  return segments.join(ROUTE_SEPARATOR);
}
