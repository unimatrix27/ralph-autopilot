/**
 * The semantic status palette mapped to the daemon's label state machine (DESIGN
 * §9). One tone per lifecycle state, so every surface (badges, cards, the future
 * Live wall) renders state consistently. The label strings are the wire protocol;
 * later slices fold them out of `buildSnapshot`/projections, but the mapping itself
 * lives here as the single UI source of truth.
 *
 * Tones resolve to the `--status-*` design tokens in index.css via Tailwind's
 * `status-*` colours (tailwind.config.js).
 */
export type StatusTone = "eligible" | "running" | "waiting" | "attention" | "danger" | "success" | "neutral";

export interface StatusMeta {
  tone: StatusTone;
  /** Operator-facing label for the state. */
  label: string;
}

/** Map a daemon lifecycle/label state to its display tone + label. */
export const STATUS_BY_STATE: Record<string, StatusMeta> = {
  // Eligible / queued for pickup.
  "ready-for-agent": { tone: "eligible", label: "Eligible" },
  // In-flight agent work.
  "in-flight": { tone: "running", label: "In flight" },
  // Automated waits (not human pauses).
  "awaiting-ci": { tone: "waiting", label: "Awaiting CI" },
  "awaiting-merge": { tone: "waiting", label: "Awaiting merge" },
  // The only non-human pause state (ADR-0042): the daemon is adjudicating it itself, so it
  // renders as running work, never as attention.
  "master-triage": { tone: "running", label: "Master triage" },
  // Needs the operator.
  "awaiting-answer": { tone: "attention", label: "Awaiting answer" },
  // Pre-cutover history only (ADR-0042): no live path produces this status, but a run row
  // written before the cutover still renders — as history, not as an alarm.
  "review-maxed": { tone: "danger", label: "Review maxed (legacy)" },
  "agent-stuck": { tone: "danger", label: "Agent stuck" },
  "daemon-anomaly": { tone: "danger", label: "Daemon anomaly" },
  // Terminal success.
  merged: { tone: "success", label: "Merged" },
};

export function statusFor(state: string): StatusMeta {
  return STATUS_BY_STATE[state] ?? { tone: "neutral", label: state };
}

/** Map a status tone to the matching Badge variant (neutral → outline). */
export function toneVariant(tone: StatusTone) {
  return tone === "neutral" ? ("outline" as const) : tone;
}
