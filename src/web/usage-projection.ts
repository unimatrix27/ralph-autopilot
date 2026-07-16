/**
 * The one backend usage-projection both read leaves fold a {@link UsageState} through: the
 * type-ordered plan `windows`, the active-cooldown instant, and — via {@link toWireUsage} — the
 * full per-login wire-usage fold (`active`/`gated`/`cooldownUntil`/`windows`) that
 * `/api/health/usage` (per login) and `/api/accounts` (per account) both emit. Extracted so the
 * projection lives in one leaf and the two live endpoints can never silently diverge — the backend
 * twin of the frontend `UsageWindows` component the refactor extracted for the same reason (commit
 * 4ad718e). Pure: every field derives from the `UsageState` plus the injected `nowMs` and threshold.
 */
import { EMPTY_USAGE, isTokenGated, type UsageState } from "../core/usage";
import type { UsageWindow } from "./contract";

/**
 * The wire-usage fields common to a `/api/health/usage` login and an `/api/accounts` account:
 * `AccountUsage` is exactly this shape, and `UsageLogin` is this plus its `id`/`disabled` markers.
 */
export interface WireUsage {
  /** Is this the login/account new sessions currently bind to? */
  active: boolean;
  /** Would the proactive gate refuse NEW work on it right now? */
  gated: boolean;
  /** ISO-8601 instant an active cooldown lifts, or null when none is active. */
  cooldownUntil: string | null;
  /** Per-window utilization + reset instant, type-ordered. */
  windows: UsageWindow[];
}

/** A login's plan windows as wire rows, type-ordered; epoch-ms resets become absolute ISO instants. */
export function toWindows(state: UsageState | undefined): UsageWindow[] {
  const windows = (state ?? EMPTY_USAGE).windows;
  return Object.entries(windows)
    .map(([type, w]) => ({
      type,
      utilization: w.utilization,
      resetsAt: w.resetsAtMs === null ? null : new Date(w.resetsAtMs).toISOString(),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/** The ISO instant an *active* (future) cooldown lifts, or null — a lapsed cooldown is not surfaced. */
export function activeCooldown(state: UsageState | undefined, nowMs: number): string | null {
  const until = state?.cooldownUntilMs ?? null;
  return until !== null && until > nowMs ? new Date(until).toISOString() : null;
}

/**
 * Fold one login's {@link UsageState} into the shared wire-usage shape: the `active` pointer
 * (passed in — the caller knows which id is active), the proactive `gated` gate (the same
 * {@link isTokenGated} predicate admission uses, so the UI's "would this admit?" read can't drift
 * from the daemon's), the active-cooldown instant, and the type-ordered windows. `/api/accounts`
 * emits this verbatim; `/api/health/usage` wraps its `id`/`disabled` markers around it.
 */
export function toWireUsage(
  state: UsageState | undefined,
  opts: { active: boolean; nowMs: number; admitBelowPercent: number },
): WireUsage {
  return {
    active: opts.active,
    gated: isTokenGated(state, opts.nowMs, opts.admitBelowPercent),
    cooldownUntil: activeCooldown(state, opts.nowMs),
    windows: toWindows(state),
  };
}
