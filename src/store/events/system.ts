/**
 * The **system stream** vocabulary (ADR-0022): daemon-lifecycle events that belong to
 * no issue — startup, drain, self-update — folded over their own stream
 * ({@link import("./streams").SYSTEM_STREAM_ID}) so they never pollute issue streams.
 *
 * The additive-only evolution rule (ADR-0026) documented in
 * {@link import("./event-types")} applies here verbatim: never mutate or remove a
 * field; add optional fields or mint a new type.
 */

import type { Event } from "@event-driven-io/emmett";

/** The daemon process started (a fresh boot or a post-self-update relaunch). */
export type DaemonStarted = Event<"DaemonStarted", { version: string | null; at: string }>;
/** The daemon began draining (starting nothing new, letting in-flight runs finish). */
export type DaemonDrained = Event<"DaemonDrained", { reason: string; at: string }>;
/** The daemon adopted new commits on its own branch (ADR-0018 self-update). */
export type DaemonSelfUpdated = Event<"DaemonSelfUpdated", { fromSha: string; toSha: string; at: string }>;

/** The discriminated union of every system-stream event. */
export type SystemEvent = DaemonStarted | DaemonDrained | DaemonSelfUpdated;

/** Every system-event `type` discriminant. */
export type SystemEventType = SystemEvent["type"];

/**
 * The canonical list of system-event types. Derived exhaustively from a
 * {@link SystemEventType}-keyed record so omitting a newly minted type is a **compile
 * error** (`satisfies Record<SystemEventType, true>`) rather than a silent drift from
 * the union. Additive — never remove an entry.
 */
export const SYSTEM_EVENT_TYPES = Object.keys({
  DaemonStarted: true,
  DaemonDrained: true,
  DaemonSelfUpdated: true,
} satisfies Record<SystemEventType, true>) as SystemEventType[];

/** The daemon-lifecycle actual state, folded from the system stream. */
export interface SystemState {
  /** Whether the daemon is currently running (started and not draining). */
  running: boolean;
  /** Whether the daemon is draining. */
  draining: boolean;
  /** The most recent lifecycle event type, or null before any. */
  lastEvent: SystemEventType | null;
  /** When the most recent lifecycle event occurred (ISO), or null. */
  lastEventAt: string | null;
}

/** The empty system state. */
export const initialSystemState = (): SystemState => ({
  running: false,
  draining: false,
  lastEvent: null,
  lastEventAt: null,
});

/**
 * Fold one system event into the daemon-lifecycle state. Pure and total; unknown
 * types are ignored (tolerant reader, ADR-0026).
 */
export function evolveSystem(state: SystemState, event: SystemEvent): SystemState {
  switch (event.type) {
    case "DaemonStarted":
      return { ...state, running: true, draining: false, lastEvent: "DaemonStarted", lastEventAt: event.data.at };
    case "DaemonDrained":
      return { ...state, draining: true, lastEvent: "DaemonDrained", lastEventAt: event.data.at };
    case "DaemonSelfUpdated":
      return { ...state, lastEvent: "DaemonSelfUpdated", lastEventAt: event.data.at };
    default:
      return state;
  }
}
