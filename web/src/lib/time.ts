import * as React from "react";

/**
 * Presentational time helpers for the control plane. The wire carries absolute
 * instants (ADR-0031) so the UI computes elapsed/relative values live — these stay
 * pure (given the reference `nowMs`) and a {@link useNow} ticker re-renders them.
 */

/** Compact duration like `5s`, `3m`, `2h`, `1d` from milliseconds (clamped at 0). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Relative wait like `3m` / `2h` from an ISO instant; `—` when unknown (null). */
export function formatWaited(iso: string | null, nowMs: number): string {
  if (iso === null) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  return formatDuration(nowMs - then);
}

/**
 * Signed relative time from a future-or-past ISO instant: `in 5m` / `5m ago` / `now`
 * (within a second), live against `nowMs`. The future-aware sibling of {@link formatWaited}
 * — for next-tick countdowns, cooldown lifts, and window resets. `—` when unparseable.
 */
export function relativeTo(iso: string, nowMs: number): string {
  const delta = Date.parse(iso) - nowMs;
  if (Number.isNaN(delta)) return "—";
  if (Math.abs(delta) < 1000) return "now";
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

/** Wall-clock `HH:MM` (local, 24h) of an ISO instant, or `—` when unparseable. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * A clock that re-renders the component every `intervalMs` so live elapsed/relative
 * times tick between polls. Returns the current epoch-ms.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
