/**
 * Shared types for the out-of-app **notification sink** (epic #106, issue #117).
 *
 * The sink is the live broadcast channel's second subscriber (the first is the SSE
 * feed): it rides the same after-commit event stream (ADR-0029) and fires best-effort
 * ntfy / webhook notifications when the daemon needs the operator and the UI is not
 * open. These types are the boundary between the pure **event → notification decision**
 * ({@link import("./decide").decideNotifications}) and the side-effecting dispatch edge.
 *
 * They carry no node imports so the pure transform stays exhaustively unit-testable.
 */

/** The attention state a notification surfaces — the human-attention label families. */
export type NotificationKind = "escalation" | "heal" | "stuck" | "anomaly" | "stall";

/** Delivery urgency, mapped to an ntfy priority (or echoed in a webhook payload) on the wire. */
export type NotificationSeverity = "default" | "high" | "max";

/**
 * One notification the sink dispatches: what happened, where (repo/issue, both `null`
 * for a daemon-wide stall), and a short title + message for the wire payloads. Produced
 * by the pure {@link import("./decide").decideNotifications} for event-driven kinds, and
 * by the sink's stall probe for the `stall` kind.
 */
export interface NotificationRequest {
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** A short one-line summary (the ntfy `Title` / the webhook `title`). */
  title: string;
  /** The body text (the ntfy message body / the webhook `message`). */
  message: string;
  /** The repo the event landed on, or `null` for a daemon-wide (stall) notification. */
  repo: string | null;
  /** The issue number, or `null` for a daemon-wide notification. */
  issueNumber: number | null;
  /** ISO-8601 instant of the triggering event (or the probe time, for a stall). */
  at: string;
}
