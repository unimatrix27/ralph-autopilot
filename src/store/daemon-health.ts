/**
 * Small daemon-health read port over the persisted per-repo backlog snapshots.
 * Notification stall detection needs only the freshest reconcile tick instant, not
 * the full dashboard projection.
 */
import type { Store } from "./store";
import type { DaemonSnapshot } from "./types";

export interface DaemonHealthPort {
  /** Freshest persisted reconcile-tick instant across all target repos, or null before the first tick. */
  lastTickAt(): string | null;
}

export function createDaemonHealthPort(store: Pick<Store, "listBacklogSnapshots">): DaemonHealthPort {
  return {
    lastTickAt: () => latestDaemonTickAt(store.listBacklogSnapshots()),
  };
}

export function latestDaemonTickAt(snapshots: DaemonSnapshot[]): string | null {
  let latestMs: number | null = null;
  for (const snapshot of snapshots) {
    const ms = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(ms)) {
      continue;
    }
    latestMs = latestMs === null ? ms : Math.max(latestMs, ms);
  }
  return latestMs === null ? null : new Date(latestMs).toISOString();
}
