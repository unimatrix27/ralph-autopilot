import * as React from "react";
import { useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { buildRunView, searchRunView, isLiveRunStatus } from "@contract";
import { fetchRunDetail } from "@/lib/api";
import { useRunLiveTranscript } from "@/lib/live";
import { useNow } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConversationItemView, RunHeaderCard, TimelineSpine } from "@/components/run-transcript";
import { KillRunButton } from "@/components/daemon-controls";

function scrollToId(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * The **run detail + transcript viewer** (issue #111): opens any run — past or live — and
 * renders its conversation readably. The pure `buildRunView` transform (`@contract`) folds
 * the fetched detail (+ any live-tailed frames) into the render model; this component is the
 * thin shell that fetches, live-tails, searches, and navigates it.
 */
export function RunDetailPage() {
  const search = useSearch({ strict: false }) as { repo?: string; issue?: number | string };
  const repo = typeof search.repo === "string" ? search.repo : "";
  const issue = Number(search.issue ?? 0) || 0;
  const valid = repo.length > 0 && issue > 0;
  const nowMs = useNow(1000);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["run", repo, issue],
    queryFn: () => fetchRunDetail(repo, issue),
    enabled: valid,
    // The SSE tail drives live updates; this is a slow fallback that also refreshes the
    // header/timeline (domain facts the transcript stream does not carry).
    refetchInterval: 15_000,
    retry: false,
  });

  // A run streams until it terminalizes — `awaiting-merge` (integration) and the other
  // non-terminal waits keep the live tail open, not just `running` (issue #111 review).
  const isLive = data ? isLiveRunStatus(data.run.status) : false;

  // Live frames newer than what the fetch already returned, deduped against the history.
  const maxFetchedGp = React.useMemo(
    () => (data ? data.transcript.reduce((m, e) => Math.max(m, e.globalPosition), 0) : 0),
    [data],
  );
  // Seed the live tail's SSE cursor at the highest global position the snapshot already
  // covers — across BOTH the permanent timeline and the transcript — so any frame
  // committed between the /api/run read and the SSE connection opening is caught up from
  // the durable log instead of dropped until the slow poll. `run()` reads both streams in
  // one synchronous store pass, so their combined max is a consistent, gap-free cursor;
  // folding the timeline in keeps a started-but-silent run (empty transcript) from seeding
  // cursor 0, which the server would read as "replay the entire global log".
  const seedGp = React.useMemo(
    () => (data ? data.timeline.reduce((m, e) => Math.max(m, e.globalPosition), maxFetchedGp) : 0),
    [data, maxFetchedGp],
  );
  // Tail by the *selected* run's id, not just repo + issue: the live feed carries every
  // run's transcript stream, so without the runId another run's frames (a re-picked run
  // after a transient drop) could splice onto this conversation (issue #111 review).
  const runId = data ? data.run.runId : "";
  const spanStartGlobalPosition = data ? data.run.spanStartGlobalPosition : 0;
  const live = useRunLiveTranscript(
    repo,
    issue,
    runId,
    spanStartGlobalPosition,
    Boolean(valid && isLive),
    seedGp,
  );
  const freshLive = React.useMemo(
    () => live.entries.filter((e) => e.globalPosition > maxFetchedGp),
    [live.entries, maxFetchedGp],
  );

  // The full live transcript = the polled history plus the SSE tail beyond it. BOTH grow while
  // live — the 15s poll advances `data.transcript`, the SSE streams `freshLive` — so Pause has
  // to freeze the tail as a whole, not just its SSE slice, or the next poll would advance the
  // transcript behind the Pause control. `freshLive` is strictly newer than every fetched entry
  // (filtered by `maxFetchedGp`), so the concatenation stays global-position ordered.
  const liveTranscript = React.useMemo(
    () => (data ? [...data.transcript, ...freshLive] : []),
    [data, freshLive],
  );
  const liveHeadGp = React.useMemo(
    () => liveTranscript.reduce((m, e) => Math.max(m, e.globalPosition), 0),
    [liveTranscript],
  );

  // Pause / jump-to-latest: pausing freezes the rendered tail at the head captured on Pause
  // (`frozenHeadGp`); everything past it accumulates as the "pending" count behind the
  // jump-to-latest control. Freezing by global position — not array length — keeps the frozen
  // view stable even as the slow poll back-fills SSE entries into `data.transcript`.
  const [frozenHeadGp, setFrozenHeadGp] = React.useState<number | null>(null);
  // The freeze only applies while the run is live (the Pause/Jump controls render only then).
  // Once it terminalizes the final poll carries the whole transcript, including any tail that
  // streamed while paused — show it all, never a frozen-and-unreleasable truncation.
  const paused = isLive && frozenHeadGp !== null;
  const shownTranscript = React.useMemo(
    () => (paused && frozenHeadGp !== null ? liveTranscript.filter((e) => e.globalPosition <= frozenHeadGp) : liveTranscript),
    [liveTranscript, paused, frozenHeadGp],
  );
  const pending = liveTranscript.length - shownTranscript.length;

  const view = React.useMemo(
    () => (data ? buildRunView({ ...data, transcript: shownTranscript }) : null),
    [data, shownTranscript],
  );

  // Search.
  const [query, setQuery] = React.useState("");
  const matches = React.useMemo(() => (view ? searchRunView(view, query) : []), [view, query]);
  const [matchIdx, setMatchIdx] = React.useState(0);
  const activeMatchId = matches.length > 0 ? matches[Math.min(matchIdx, matches.length - 1)]?.itemId ?? null : null;

  const goToMatch = React.useCallback(
    (idx: number) => {
      if (matches.length === 0) return;
      const next = ((idx % matches.length) + matches.length) % matches.length;
      setMatchIdx(next);
      const id = matches[next]?.itemId;
      if (id) scrollToId(id);
    },
    [matches],
  );
  React.useEffect(() => {
    setMatchIdx(0);
    if (query && matches.length > 0) {
      const id = matches[0]?.itemId;
      if (id) scrollToId(id);
    }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to the latest while live and not paused: fire when the tail head advances (a
  // new frame), never on the initial history load (`prev === null`) or for a historical run.
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const lastHeadRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const prev = lastHeadRef.current;
    lastHeadRef.current = liveHeadGp;
    if (prev !== null && isLive && !paused && liveHeadGp > prev) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [liveHeadGp, isLive, paused]);

  const onPause = (): void => setFrozenHeadGp(liveHeadGp);
  const onJumpLatest = (): void => {
    setFrozenHeadGp(null);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 0);
  };

  if (!valid) {
    return (
      <>
        <PageHeader title="Run" />
        <Card>
          <CardContent className="py-10 text-sm text-muted-foreground">
            No run selected. Open a run from the <span className="text-foreground">Runs</span> page or a live Fleet card.
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={`Run · ${repo} #${issue}`} subtitle="The agent's conversation — tool calls, diffs, and output, live or historical." />

      {isError && (
        <Card className="border-status-danger/40">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <Badge variant="danger">not found</Badge>
            <span className="text-muted-foreground">No such run, or the control plane is unreachable.</span>
          </CardContent>
        </Card>
      )}
      {isLoading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {view && (
        <div className="space-y-4">
          <RunHeaderCard header={view.header} nowMs={nowMs} />

          {isLive && runId.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <KillRunButton runId={runId} />
              <span className="text-xs text-muted-foreground">
                Tears down this run&apos;s live session; it terminalizes to agent-stuck and frees its slot next tick.
              </span>
            </div>
          )}

          {view.pruned && (
            <Card className="border-status-waiting/40">
              <CardContent className="flex flex-wrap items-center gap-2 py-3 text-sm">
                <Badge variant="waiting">transcript pruned</Badge>
                <span className="text-muted-foreground">
                  The verbose conversation aged out ({view.pruned.reason}, {view.pruned.prunedMessageCount} messages). The
                  timeline below is preserved.
                </span>
              </CardContent>
            </Card>
          )}

          {/* search + live controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goToMatch(matchIdx + (e.shiftKey ? -1 : 1));
                }}
                placeholder="Search transcript — a command, file, or error…"
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              {query && (
                <>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {matches.length === 0 ? "0/0" : `${Math.min(matchIdx, matches.length - 1) + 1}/${matches.length}`}
                  </span>
                  <Button variant="outline" size="sm" disabled={matches.length === 0} onClick={() => goToMatch(matchIdx - 1)}>
                    ↑
                  </Button>
                  <Button variant="outline" size="sm" disabled={matches.length === 0} onClick={() => goToMatch(matchIdx + 1)}>
                    ↓
                  </Button>
                </>
              )}
            </div>
            {isLive && (
              <div className="flex shrink-0 items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={
                      "inline-block h-2 w-2 rounded-full " +
                      (live.connected ? "animate-pulse bg-status-success" : "bg-status-waiting")
                    }
                    aria-hidden
                  />
                  {live.connected ? "Live" : "Reconnecting…"}
                </span>
                {paused ? (
                  <Button variant="outline" size="sm" onClick={onJumpLatest}>
                    Jump to latest{pending > 0 ? ` (${pending})` : ""}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={onPause}>
                    Pause
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* timeline spine + conversation */}
          <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <aside className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-auto">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Timeline</h2>
              <TimelineSpine nodes={view.timeline} onJump={scrollToId} />
            </aside>

            <div className="min-w-0 space-y-2">
              {view.items.length === 0 && !view.pruned && (
                <Card>
                  <CardContent className="py-10 text-sm text-muted-foreground">
                    No transcript captured yet. {isLive ? "Activity will stream in here." : "This run produced no captured conversation."}
                  </CardContent>
                </Card>
              )}
              {view.items.map((item) => (
                <ConversationItemView key={item.id} item={item} active={item.id === activeMatchId} />
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
