import { formatRoute, type Route } from "@contract";
import { cn } from "@/lib/utils";

/**
 * The dispatched **route** of a phase (ADR-0037 P3.2, issue #165), rendered as
 * `provider · model · account` (e.g. `claude · opus · A`) through the shared {@link formatRoute}
 * — the live fleet row and the run-detail per-phase timeline render it identically.
 *
 * Degrades gracefully: a `null`/absent route (a box-default or unrecorded dispatch) renders
 * nothing, and a default-model route (`model === null`) drops the model segment inside
 * {@link formatRoute}. The `↳` glyph marks it as the route the row ran on.
 */
export function RouteChip({ route, className }: { route: Route | null | undefined; className?: string }) {
  if (!route) {
    return null;
  }
  const line = formatRoute(route);
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-mono text-xs text-muted-foreground", className)}
      title={`route: ${line}`}
    >
      <span aria-hidden>↳</span>
      <span className="text-foreground">{line}</span>
    </span>
  );
}
