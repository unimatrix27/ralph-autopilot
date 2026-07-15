import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API_ROUTES,
  classifyLiveEvent,
  liveEventSchema,
  transcriptLatestLine,
  transcriptMessageDataSchema,
  type LiveLine,
  type TranscriptEntry,
} from "@contract";

/**
 * The browser side of the live (SSE) control plane (ADR-0029, issue #109). A single
 * `EventSource` to `/api/live` replaces polling: it auto-reconnects on drop and resumes
 * from the last `global_position` it saw (the browser resends `Last-Event-ID`
 * automatically), so the catch-up is transparent.
 *
 * Each frame **merges into the TanStack Query cache** rather than triggering a refetch
 * storm:
 *   - a **transcript** frame updates the per-agent live line cache ({@link LIVE_LINES_KEY})
 *     directly — the high-frequency stream never hits the network, and
 *   - a sparse **domain** frame (a phase / fix-attempt / lifecycle change) schedules one
 *     coalesced `overview` invalidation, so the Fleet wall's structure and the attention
 *     badges refresh without per-event polling.
 *
 * The feed is mounted once, app-wide, by {@link LiveFeedProvider} (so badges update on
 * every route); pages read its connection status with {@link useLiveStatus} and the live
 * lines with {@link useLiveLines}.
 */

/** TanStack Query key under which the per-agent live lines are merged (keyed `repo#issue`). */
export const LIVE_LINES_KEY = ["live", "lines"] as const;

/** The latest live line for one running agent, with the cursor it was derived from. */
export interface FleetLineEntry {
  line: LiveLine;
  /** ISO instant the underlying transcript message was captured, or null. */
  at: string | null;
  runId: string;
  /** The frame's global position — used to ignore out-of-order/stale updates. */
  globalPosition: number;
}

/** The live-line cache: `repo#issue` → its latest line. */
export type FleetLines = Record<string, FleetLineEntry>;

/** The cache key for a fleet agent's live line (matches a `FleetAgent`'s repo + issue). */
export function fleetLineKey(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

/** SSE connection status, surfaced to the UI as a live/reconnecting indicator. */
export type LiveStatus = "connecting" | "open";

const LiveStatusContext = React.createContext<LiveStatus>("connecting");

/** The current `/api/live` connection status (for a live/reconnecting indicator). */
export function useLiveStatus(): LiveStatus {
  return React.useContext(LiveStatusContext);
}

/**
 * Read the live-line cache reactively. It is populated by {@link LiveFeedProvider} via
 * `setQueryData` (never fetched), so the query is permanently fresh; a component
 * re-renders when a new line merges in.
 */
export function useLiveLines(): FleetLines {
  const { data } = useQuery<FleetLines>({
    queryKey: LIVE_LINES_KEY,
    queryFn: () => ({}),
    initialData: {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? {};
}

/** Read an ISO `at` field from an opaque frame payload, if present. */
function readAt(data: unknown): string | null {
  const at = (data as { at?: unknown } | null)?.at;
  return typeof at === "string" ? at : null;
}

/**
 * Mount the app-wide live feed. Renders its children inside a status context. Opens one
 * `EventSource`, merges frames into the query cache, and tears the connection down on
 * unmount. Coalesces domain-driven `overview` refreshes so the structural refresh never
 * storms.
 */
export function LiveFeedProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<LiveStatus>("connecting");

  React.useEffect(() => {
    let overviewTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleOverviewRefresh = (): void => {
      if (overviewTimer !== null) {
        return; // already pending — coalesce
      }
      overviewTimer = setTimeout(() => {
        overviewTimer = null;
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
      }, 300);
    };

    const source = new EventSource(API_ROUTES.live);
    source.onopen = () => setStatus("open");
    // The browser auto-reconnects (honouring the server's `retry:`), resending
    // Last-Event-ID so the feed resumes from where it left off — we just reflect status.
    source.onerror = () => setStatus("connecting");
    source.onmessage = (message: MessageEvent<string>) => {
      let parsed;
      try {
        parsed = liveEventSchema.parse(JSON.parse(message.data));
      } catch {
        return; // ignore a frame that does not match the contract
      }
      const classified = classifyLiveEvent(parsed);
      if (classified.kind === "transcript") {
        const line = transcriptLatestLine(parsed.data);
        if (!line) {
          return;
        }
        const key = fleetLineKey(classified.ref.repo, classified.ref.issueNumber);
        const entry: FleetLineEntry = {
          line,
          at: readAt(parsed.data),
          runId: classified.ref.runId,
          globalPosition: parsed.globalPosition,
        };
        queryClient.setQueryData<FleetLines>(LIVE_LINES_KEY, (prev) => {
          const current = prev ?? {};
          const existing = current[key];
          if (existing && existing.globalPosition >= parsed.globalPosition) {
            return current; // ignore an out-of-order / duplicate frame
          }
          return { ...current, [key]: entry };
        });
      } else {
        // A sparse lifecycle/phase/fix-attempt change — refresh the aggregate (fleet
        // structure + attention badges) with one coalesced invalidation.
        scheduleOverviewRefresh();
      }
    };

    return () => {
      source.close();
      if (overviewTimer !== null) {
        clearTimeout(overviewTimer);
      }
    };
  }, [queryClient]);

  return <LiveStatusContext.Provider value={status}>{children}</LiveStatusContext.Provider>;
}

/** The live-tail state for one run's streaming transcript (issue #111). */
export interface RunLiveTranscript {
  /** TranscriptMessage entries that arrived live, oldest-first, deduped by global position. */
  entries: TranscriptEntry[];
  /** Whether this run's dedicated SSE connection is open. */
  connected: boolean;
}

/**
 * Live-tail one run's transcript over its own SSE connection (issue #111). It opens a
 * dedicated `EventSource` to `/api/live` seeded at `sinceGlobalPosition` (the head of the
 * fetched snapshot), keeps only the `TranscriptMessage` frames for *this* run — matched by
 * repo + issue **and `runId`** — and accumulates them deduped by global position. The
 * run-detail page merges these onto the fetched history and the browser auto-reconnects on
 * drop (resuming via `Last-Event-ID`), so the tail is gap-free.
 *
 * Matching `runId` (not just repo + issue) is what isolates run identity: an issue stream
 * can carry more than one transcript stream — a re-picked run after a transient drop mints
 * a fresh `transcript:<repo>#<issue>:<runId>`. Without the `runId` check the viewer would
 * splice another run's frames onto this run's conversation. It mirrors the snapshot read,
 * which is already keyed by the same per-run transcript stream id.
 *
 * Seeding the cursor matters: a cursorless connection starts at the *live head*, so any
 * frame committed between the snapshot read and the connection opening would be silently
 * dropped until the slow poll. Passing `?cursor=<head>` makes the server catch those up
 * from the durable log. The seed is captured in a ref so the slow poll advancing it does
 * not tear down and reopen the connection (resetting the accumulated tail) — it only needs
 * to be right for the first connect; reconnects resume via `Last-Event-ID`.
 *
 * `enabled` gates the connection: a terminal run (merged/stuck/…) opens none — its
 * transcript is fully historical.
 */
export function useRunLiveTranscript(
  repo: string,
  issue: number,
  runId: string,
  spanStartGlobalPosition: number,
  enabled: boolean,
  sinceGlobalPosition: number,
): RunLiveTranscript {
  const [entries, setEntries] = React.useState<TranscriptEntry[]>([]);
  const [connected, setConnected] = React.useState(false);

  // Latest snapshot head, read at connect time only (see the doc comment). Assigned during
  // render so the connect effect — which depends only on repo/issue/enabled — sees the
  // value current at the render that enabled it.
  const sinceRef = React.useRef(sinceGlobalPosition);
  sinceRef.current = sinceGlobalPosition;

  React.useEffect(() => {
    setEntries([]);
    if (!enabled) {
      setConnected(false);
      return;
    }
    const seen = new Set<number>();
    // `cursor=0` is omitted: the server reads it as "replay the entire global log", and an
    // empty snapshot has nothing to bridge, so "from now" is the right start there.
    const since = sinceRef.current;
    const url = since > 0 ? `${API_ROUTES.live}?cursor=${since}` : API_ROUTES.live;
    const source = new EventSource(url);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message: MessageEvent<string>) => {
      let parsed;
      try {
        parsed = liveEventSchema.parse(JSON.parse(message.data));
      } catch {
        return;
      }
      if (parsed.type !== "TranscriptMessage" || seen.has(parsed.globalPosition)) {
        return;
      }
      if (parsed.globalPosition < spanStartGlobalPosition) {
        return;
      }
      const classified = classifyLiveEvent(parsed);
      if (
        classified.kind !== "transcript" ||
        classified.ref.repo !== repo ||
        classified.ref.issueNumber !== issue ||
        classified.ref.runId !== runId
      ) {
        return;
      }
      const data = transcriptMessageDataSchema.safeParse(parsed.data);
      if (!data.success) {
        return;
      }
      seen.add(parsed.globalPosition);
      const entry: TranscriptEntry = {
        type: "TranscriptMessage",
        globalPosition: parsed.globalPosition,
        streamPosition: parsed.globalPosition,
        data: data.data,
      };
      setEntries((prev) => [...prev, entry]);
    };
    return () => source.close();
  }, [repo, issue, runId, spanStartGlobalPosition, enabled]);

  return { entries, connected };
}
