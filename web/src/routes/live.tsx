import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FleetAgent, LiveLineKind } from "@contract";
import { fetchOverview } from "@/lib/api";
import { formatDuration, useNow } from "@/lib/time";
import { ALL_REPOS, useRepoFilter } from "@/components/repo-filter";
import { fleetLineKey, useLiveLines, useLiveStatus, type FleetLineEntry } from "@/lib/live";
import { githubIssueUrl, issueHeading } from "@/lib/github";
import { PageHeader } from "@/components/page";
import { RouteChip } from "@/components/route-chip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The **Live / Fleet wall** (issue #109, #13): a single-column list — one full-width row per
 * running agent, headed by its GitHub issue title — each streaming its phase, elapsed,
 * fix-attempt, and the latest tool call / assistant line over SSE. The fleet *structure* comes
 * from the Overview projection (refreshed by the live feed's coalesced invalidation on lifecycle
 * changes); the per-row live line and the elapsed clock update continuously without a refetch.
 */
export function LivePage() {
  const { repo } = useRepoFilter();
  const filter = repo === ALL_REPOS ? undefined : repo;
  const now = useNow(1000);
  const status = useLiveStatus();
  const lines = useLiveLines();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["overview", filter ?? null],
    queryFn: () => fetchOverview(filter),
    // The SSE feed drives refreshes; this is only a slow fallback if the stream is down.
    refetchInterval: 30_000,
    retry: false,
  });

  const fleet = data?.fleet ?? [];

  return (
    <>
      <PageHeader title="Live" subtitle="Watch agents work in real time — phase, elapsed, and the latest tool call streaming over SSE." />

      <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
        <LiveIndicator status={status} />
        <span>
          {fleet.length === 0 ? "No agents running" : `${fleet.length} agent${fleet.length === 1 ? "" : "s"} running`}
          {filter ? <> in <span className="font-mono text-foreground">{filter}</span></> : " across all repos"}.
        </span>
      </div>

      {isError && (
        <Card className="border-status-danger/40">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <Badge variant="danger">unreachable</Badge>
            <span className="text-muted-foreground">The control plane did not answer. Is the daemon running?</span>
          </CardContent>
        </Card>
      )}

      {isLoading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && fleet.length === 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 rounded-md py-10 text-sm text-muted-foreground">
            The fleet is idle. Running agents will appear here and stream live.
          </CardContent>
        </Card>
      )}

      {fleet.length > 0 && (
        <div className="space-y-3">
          {fleet.map((agent) => (
            <FleetRow
              key={fleetLineKey(agent.repo, agent.issue)}
              agent={agent}
              entry={lines[fleetLineKey(agent.repo, agent.issue)]}
              now={now}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** A pulsing dot + label reflecting the SSE connection. */
function LiveIndicator({ status }: { status: "connecting" | "open" }) {
  const open = status === "open";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={
          "inline-block h-2 w-2 rounded-full " +
          (open ? "animate-pulse bg-status-success" : "bg-status-waiting")
        }
        aria-hidden
      />
      <span className={open ? "text-status-success" : "text-status-waiting"}>{open ? "Live" : "Reconnecting…"}</span>
    </span>
  );
}

/**
 * One full-width running-agent row (issue #13): headed by the GitHub issue title (fallback to
 * `repo #issue` when the title is null), with the repo + `#issue` reference linking out to the
 * issue on GitHub, plus phase + elapsed + fix-attempt + route and the live tool/assistant line.
 *
 * The row navigates to the run's streaming transcript (issue #111), but the GitHub reference is
 * its own external anchor — an `<a>` nested in a router `Link` is invalid HTML. So the transcript
 * `Link` is a stretched overlay covering the row (below the content), while the GitHub anchor
 * sits above it (`relative z-10`) and stops propagation, so clicking it opens *only* GitHub while
 * clicking anywhere else on the row opens the transcript.
 */
function FleetRow({ agent, entry, now }: { agent: FleetAgent; entry: FleetLineEntry | undefined; now: number }) {
  const heading = issueHeading(agent.title, agent.repo, agent.issue);
  return (
    <Card className="relative overflow-hidden transition-shadow hover:ring-2 hover:ring-ring focus-within:ring-2 focus-within:ring-ring">
      {/* Stretched overlay → the transcript. Non-interactive row area sits below it, so a click
          there navigates; the GitHub anchor below is lifted above it to opt out. */}
      <Link
        to="/run"
        search={{ repo: agent.repo, issue: agent.issue }}
        className="absolute inset-0 z-0 focus:outline-none"
        aria-label={`Open transcript for ${heading}`}
      />
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <CardTitle className="truncate text-sm font-medium text-foreground">{heading}</CardTitle>
            <a
              href={githubIssueUrl(agent.repo, agent.issue)}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 inline-flex font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {agent.repo}
              <span className="text-foreground"> #{agent.issue}</span>
            </a>
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {formatDuration(now - Date.parse(agent.phaseStartedAt))}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="running">{agent.phase}</Badge>
          {agent.fixAttempt > 0 && <span className="text-xs text-muted-foreground">fix #{agent.fixAttempt}</span>}
          {/* The live route of the running phase — provider · model · account (#165). */}
          <RouteChip route={agent.route} />
        </div>
        <LiveLineRow entry={entry} />
      </CardContent>
    </Card>
  );
}

/** Short label + tone for the kind of block a live line came from. */
const LINE_META: Record<LiveLineKind, { label: string; variant: "running" | "outline" | "waiting" }> = {
  tool_use: { label: "tool", variant: "running" },
  tool_result: { label: "result", variant: "waiting" },
  text: { label: "says", variant: "outline" },
  thinking: { label: "thinks", variant: "outline" },
};

/** The latest streamed line for an agent, or a waiting placeholder until one arrives. */
function LiveLineRow({ entry }: { entry: FleetLineEntry | undefined }) {
  if (!entry) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        Waiting for activity…
      </div>
    );
  }
  const meta = LINE_META[entry.line.kind];
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-start gap-2">
        <Badge variant={meta.variant} className="mt-0.5 shrink-0">
          {meta.label}
        </Badge>
        <span className="min-w-0 break-words font-mono text-xs leading-relaxed text-foreground">{entry.line.text}</span>
      </div>
    </div>
  );
}
