import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  type AnalyticsDailyPoint,
  type AnalyticsResponse,
  type DistributionBucket,
} from "@contract";
import { fetchAnalytics } from "@/lib/api";
import { formatDuration } from "@/lib/time";
import { ALL_REPOS, useRepoFilter } from "@/components/repo-filter";
import { PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Analytics / history (issue #115): trends over time so the operator can gauge
 * productivity and quality — throughput (merges/day), mean-time-to-merge, the
 * fix-attempt / escalation / review-maxed distributions, and an anomaly trend that
 * confirms the completeness invariant stays healthy. Aggregate across all repos with
 * the shared repo filter applied, over a selectable window. The charts are
 * dependency-free (Tailwind-styled SVG/divs), reading the pure server-side projection.
 */
export function AnalyticsPage() {
  const { repo } = useRepoFilter();
  const filter = repo === ALL_REPOS ? undefined : repo;
  const [windowDays, setWindowDays] = React.useState<number>(DEFAULT_ANALYTICS_WINDOW_DAYS);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["analytics", filter ?? null, windowDays],
    queryFn: () => fetchAnalytics(filter, windowDays),
    refetchInterval: 30_000,
    retry: false,
  });

  const scope = filter ? <span className="font-mono">{filter}</span> : "all repos";

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Throughput, time-to-merge, and quality trends — aggregate across all repos, over a selectable window."
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Showing <span className="text-foreground">{scope}</span>
          {data && (
            <>
              {" "}
              · last <span className="text-foreground">{data.windowDays}</span> days
            </>
          )}
          .
        </p>
        <WindowPicker value={windowDays} onChange={setWindowDays} />
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

      {data && (
        <div className="space-y-6">
          <SummaryCards data={data} />
          <div className="grid gap-6 lg:grid-cols-3">
            <DailyChart
              title="Throughput"
              description="Merges per day."
              points={data.daily}
              value={(d) => d.merges}
              tone="success"
              format={(v) => String(v)}
            />
            <DailyChart
              title="Time to merge"
              description="Mean run-start → merge, per day (gaps = no merge)."
              points={data.daily}
              value={(d) => d.meanTimeToMergeMs}
              tone="running"
              format={(v) => formatDuration(v)}
            />
            <DailyChart
              title="Anomaly trend"
              description="Completeness anomalies per day — should stay flat at zero."
              points={data.daily}
              value={(d) => d.anomalies}
              tone="danger"
              format={(v) => String(v)}
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <DistributionChart
              title="Fix attempts"
              description="Fix attempts consumed when review gave up (per review-maxout)."
              unit="maxouts"
              buckets={data.distributions.fixAttempts}
            />
            <DistributionChart
              title="Escalations"
              description="Escalations per issue in the window."
              unit="issues"
              buckets={data.distributions.escalations}
            />
            <DistributionChart
              title="Review-maxed"
              description="Review maxouts per issue in the window."
              unit="issues"
              buckets={data.distributions.reviewMaxed}
            />
          </div>
        </div>
      )}
    </>
  );
}

function WindowPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Select window">
      {ANALYTICS_WINDOWS.map((days) => (
        <Button
          key={days}
          size="sm"
          variant={days === value ? "default" : "outline"}
          aria-pressed={days === value}
          onClick={() => onChange(days)}
        >
          {days}d
        </Button>
      ))}
    </div>
  );
}

/** The fill/text tokens for a chart tone (kept off `StatusTone` so the chart owns its palette). */
type ChartTone = "success" | "running" | "danger";
const TONE_FILL: Record<ChartTone, string> = {
  success: "bg-status-success",
  running: "bg-status-running",
  danger: "bg-status-danger",
};

function SummaryCards({ data }: { data: AnalyticsResponse }) {
  const { summary } = data;
  const cards: { label: string; value: string; highlight?: boolean }[] = [
    { label: "Merges", value: String(summary.totalMerges) },
    {
      label: "Mean time to merge",
      value: summary.meanTimeToMergeMs === null ? "—" : formatDuration(summary.meanTimeToMergeMs),
    },
    { label: "Escalations", value: String(summary.totalEscalations) },
    { label: "Review-maxed", value: String(summary.totalReviewMaxed) },
    { label: "Anomalies", value: String(summary.totalAnomalies), highlight: summary.totalAnomalies > 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4">
            <div
              className={cn(
                "text-2xl font-semibold tabular-nums",
                c.highlight && "text-status-danger",
              )}
            >
              {c.value}
            </div>
            <div className="mt-1 text-[11px] leading-tight text-muted-foreground">{c.label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * A contiguous daily bar chart over the window. `value` extracts the day's metric (a
 * number, or `null` to leave a gap so a sparse line reads as "no data" not "zero").
 * Bars scale to the window's max; an all-zero/empty window renders an empty baseline.
 */
function DailyChart({
  title,
  description,
  points,
  value,
  tone,
  format,
}: {
  title: string;
  description: string;
  points: AnalyticsDailyPoint[];
  value: (d: AnalyticsDailyPoint) => number | null;
  tone: ChartTone;
  format: (v: number) => string;
}) {
  const values = points.map(value);
  const max = values.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  const first = points[0]?.date ?? "";
  const last = points[points.length - 1]?.date ?? "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-1 text-right text-[11px] text-muted-foreground tabular-nums">
          {max > 0 ? `peak ${format(max)}` : "no data"}
        </div>
        <div className="flex h-28 items-end gap-px">
          {points.map((d) => {
            const v = value(d);
            const hasValue = v !== null && v > 0;
            const heightPct = hasValue && max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0;
            return (
              <div
                key={d.date}
                className="group relative flex-1"
                style={{ height: "100%" }}
                title={`${d.date}: ${v === null ? "—" : format(v)}`}
              >
                <div className="absolute bottom-0 flex w-full items-end" style={{ height: "100%" }}>
                  <div
                    className={cn("w-full rounded-sm", hasValue ? TONE_FILL[tone] : "bg-transparent")}
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>{first}</span>
          <span>{last}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** A histogram bar chart for one distribution: `bucket` on the x-axis, `count` as the bar. */
function DistributionChart({
  title,
  description,
  unit,
  buckets,
}: {
  title: string;
  description: string;
  unit: string;
  buckets: DistributionBucket[];
}) {
  const max = buckets.reduce((m, b) => (b.count > m ? b.count : m), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No data in this window.</p>
        ) : (
          <div className="space-y-1.5">
            {buckets.map((b) => (
              <div key={b.bucket} className="flex items-center gap-2 text-xs">
                <span className="w-6 shrink-0 text-right font-mono text-muted-foreground">{b.bucket}</span>
                <div className="h-4 flex-1 rounded-sm bg-muted">
                  <div
                    className="h-4 rounded-sm bg-status-running"
                    style={{ width: max > 0 ? `${Math.max(b.count > 0 ? 6 : 0, Math.round((b.count / max) * 100))}%` : "0%" }}
                  />
                </div>
                <span className="w-6 shrink-0 tabular-nums">{b.count}</span>
              </div>
            ))}
            <p className="pt-1 text-[10px] text-muted-foreground">bucket → {unit}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
