import { useQuery } from "@tanstack/react-query";
import {
  NEEDS_YOU_STATES,
  type ActivityItem,
  type FleetAgent,
  type NeedsYouItem,
  type NeedsYouState,
  type PipelineFunnel,
  type PowerActionCatalogWire,
} from "@contract";
import { fetchOverview } from "@/lib/api";
import { formatDuration, formatWaited, useNow } from "@/lib/time";
import { ALL_REPOS, useRepoFilter } from "@/components/repo-filter";
import { PageHeader } from "@/components/page";
import { RepoIssue } from "@/components/repo-issue";
import { RouteChip } from "@/components/route-chip";
import { PowerActions } from "@/components/power-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { statusFor, toneVariant, type StatusTone } from "@/lib/status";

export function OverviewPage() {
  const { repo } = useRepoFilter();
  const filter = repo === ALL_REPOS ? undefined : repo;
  const now = useNow(1000);

  const { data, isLoading, isError } = useQuery({
    // `null` keys the aggregate so it shares the app-shell's repo-list fetch.
    queryKey: ["overview", filter ?? null],
    queryFn: () => fetchOverview(filter),
    refetchInterval: 5_000,
    retry: false,
  });

  const scope = filter ? <span className="font-mono">{filter}</span> : "all repos";

  return (
    <>
      <PageHeader title="Overview" subtitle="Does anything need you? Aggregate across all repos, in flight, and just-merged." />

      {isError && (
        <Card className="border-status-danger/40">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <Badge variant="danger">unreachable</Badge>
            <span className="text-muted-foreground">The control plane did not answer. Is the daemon running?</span>
          </CardContent>
        </Card>
      )}

      {isLoading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">
            Showing <span className="text-foreground">{scope}</span>.
          </p>
          <NeedsYouBand items={data.needsYou} now={now} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
          <div className="grid gap-6 lg:grid-cols-2">
            <FleetSummary agents={data.fleet} now={now} />
            <PipelineFunnelCard funnel={data.funnel} />
          </div>
          <RecentActivity items={data.activity} now={now} />
        </div>
      )}
    </>
  );
}

function NeedsYouBand({
  items,
  now,
  reconcileIntervalSeconds,
  catalog,
}: {
  items: NeedsYouItem[];
  now: number;
  reconcileIntervalSeconds: number;
  catalog: PowerActionCatalogWire;
}) {
  return (
    <Card className={items.length > 0 ? "border-status-attention/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Needs you
          {items.length > 0 && <Badge variant="attention">{items.length}</Badge>}
        </CardTitle>
        <CardDescription>Escalations, review-maxed, stuck agents, and anomalies — triage-ordered by urgency.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            Nothing needs you. The fleet is healthy.
          </div>
        ) : (
          <div className="space-y-4">
            {NEEDS_YOU_STATES.map((state) => {
              const group = items.filter((i) => i.state === state);
              if (group.length === 0) return null;
              return (
                <NeedsYouGroup
                  key={state}
                  state={state}
                  items={group}
                  now={now}
                  reconcileIntervalSeconds={reconcileIntervalSeconds}
                  catalog={catalog}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NeedsYouGroup({
  state,
  items,
  now,
  reconcileIntervalSeconds,
  catalog,
}: {
  state: NeedsYouState;
  items: NeedsYouItem[];
  now: number;
  reconcileIntervalSeconds: number;
  catalog: PowerActionCatalogWire;
}) {
  const meta = statusFor(state);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Badge variant={toneVariant(meta.tone)}>{meta.label}</Badge>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      <ul className="divide-y rounded-md border">
        {items.map((item) => (
          <li key={`${item.repo}#${item.issue}`} className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <RepoIssue repo={item.repo} issue={item.issue} />
                <p className="truncate text-sm">{item.summary}</p>
              </div>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" title={item.waitingSince ?? undefined}>
                waiting {formatWaited(item.waitingSince, now)}
              </span>
            </div>
            <PowerActions
              repo={item.repo}
              issue={item.issue}
              reconcileIntervalSeconds={reconcileIntervalSeconds}
              catalog={catalog}
              surface={item.powerActionSurface}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FleetSummary({ agents, now }: { agents: FleetAgent[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Fleet
          {agents.length > 0 && <Badge variant="running">{agents.length}</Badge>}
        </CardTitle>
        <CardDescription>Running agents with phase and elapsed time.</CardDescription>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents running.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {agents.map((a) => (
              <li key={`${a.repo}#${a.issue}`} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <RepoIssue repo={a.repo} issue={a.issue} />
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant="running">{a.phase}</Badge>
                    {a.fixAttempt > 0 && <span className="text-xs text-muted-foreground">fix #{a.fixAttempt}</span>}
                    {/* The live route of the running phase — provider · model · account (#165). */}
                    <RouteChip route={a.route} />
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {formatDuration(now - Date.parse(a.phaseStartedAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The pipeline funnel stages, in flow order, mapped to their tones. */
const FUNNEL_STAGES: { key: keyof PipelineFunnel; label: string; tone: StatusTone }[] = [
  { key: "eligible", label: "Eligible", tone: "eligible" },
  { key: "inFlight", label: "In flight", tone: "running" },
  { key: "awaitingCi", label: "Awaiting CI", tone: "waiting" },
  { key: "awaitingMerge", label: "Awaiting merge", tone: "waiting" },
  { key: "merged", label: "Merged", tone: "success" },
];

function PipelineFunnelCard({ funnel }: { funnel: PipelineFunnel }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline</CardTitle>
        <CardDescription>Flow from eligible to merged (merged = recent throughput).</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-stretch gap-1">
          {FUNNEL_STAGES.map((stage, i) => (
            <div key={stage.key} className="flex flex-1 items-center gap-1">
              <div className="flex-1 rounded-md border p-3 text-center">
                <div className="text-2xl font-semibold tabular-nums">{funnel[stage.key]}</div>
                <div className="mt-1 text-[11px] leading-tight text-muted-foreground">{stage.label}</div>
              </div>
              {i < FUNNEL_STAGES.length - 1 && <span className="text-muted-foreground">→</span>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Activity events that have no daemon-state equivalent in the status palette, so
 * they cannot resolve through {@link statusFor}. Every other event name is a label
 * state and reuses the shared palette — keeping one source of truth for tones.
 */
const ACTIVITY_TONE_OVERRIDE: Record<string, StatusTone> = {
  escalated: "attention",
  "pr-opened": "eligible",
};

/** Tone for a recent-activity event, reusing the status palette where it maps. */
function activityTone(event: string): StatusTone {
  return ACTIVITY_TONE_OVERRIDE[event] ?? statusFor(event).tone;
}

function RecentActivity({ items, now }: { items: ActivityItem[]; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>Merges, escalations, and outcomes — newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent activity.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((item, i) => (
              <li key={`${item.ts}-${item.event}-${i}`} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge variant={toneVariant(activityTone(item.event))}>{item.event}</Badge>
                  <span className="truncate text-sm">{item.summary}</span>
                  {item.repo && item.issue && <RepoIssue repo={item.repo} issue={item.issue} />}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" title={item.ts}>
                  {formatWaited(item.ts, now)} ago
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
