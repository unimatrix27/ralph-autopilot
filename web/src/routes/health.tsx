import { useQuery } from "@tanstack/react-query";
import type { AnomalyItem, DaemonHealth, UsageLogin, UsageSummary } from "@contract";
import { fetchHealthUsage } from "@/lib/api";
import { formatDuration, relativeTo, useNow } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { PushCard } from "@/components/push-card";
import { RepoIssue } from "@/components/repo-issue";
import { DaemonControls } from "@/components/daemon-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function HealthPage() {
  const now = useNow(1000);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health-usage"],
    queryFn: fetchHealthUsage,
    refetchInterval: 5_000,
    retry: false,
  });

  return (
    <>
      <PageHeader title="Health" subtitle="Daemon liveness, anomalies, and plan usage — is it alive, and why might it be holding back?" />

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
          <DaemonHealthCard daemon={data.daemon} now={now} />
          <DaemonControls />
          <AnomaliesCard anomalies={data.anomalies} now={now} />
          <UsageCard usage={data.usage} now={now} />
          <PushCard />
        </div>
      )}
    </>
  );
}

/** One labelled metric tile in the daemon-health grid. */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function DaemonHealthCard({ daemon, now }: { daemon: DaemonHealth | null; now: number }) {
  return (
    <Card className={daemon?.stale ? "border-status-danger/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Daemon
          {daemon?.stale && <Badge variant="danger">stale</Badge>}
        </CardTitle>
        <CardDescription>
          {daemon ? <span className="font-mono">{daemon.targets}</span> : "Liveness, ticks, and build-pool capacity."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {daemon === null ? (
          <p className="text-sm text-muted-foreground">The daemon has not completed its first tick yet.</p>
        ) : (
          <div className="space-y-4">
            {daemon.stale && (
              <div className="rounded-md border border-status-danger/40 bg-status-danger/5 p-3 text-sm">
                Last tick was <span className="font-medium">{relativeTo(daemon.lastTickAt, now)}</span> — the daemon may be down or stalled.
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Uptime" value={formatDuration(now - Date.parse(daemon.startedAt))} />
              <Metric label="In flight" value={`${daemon.inFlight} / ${daemon.cap}`} hint="agents / build-pool cap" />
              <Metric label="Last tick" value={relativeTo(daemon.lastTickAt, now)} />
              <Metric label="Next tick" value={Date.parse(daemon.nextTickAt) <= now ? "due" : relativeTo(daemon.nextTickAt, now)} />
            </div>
            {daemon.lastError && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="danger">last error</Badge>
                <span className="font-mono">{daemon.lastError.event}</span>
                <span title={daemon.lastError.at}>{relativeTo(daemon.lastError.at, now)}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AnomaliesCard({ anomalies, now }: { anomalies: AnomalyItem[]; now: number }) {
  return (
    <Card className={anomalies.length > 0 ? "border-status-danger/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Anomalies
          {anomalies.length > 0 && <Badge variant="danger">{anomalies.length}</Badge>}
        </CardTitle>
        <CardDescription>Completeness islands the daemon parked, with the reason it logged — so they can be repaired.</CardDescription>
      </CardHeader>
      <CardContent>
        {anomalies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No anomalies. The daemon can classify every open issue.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {anomalies.map((a) => (
              <li key={`${a.repo}#${a.issue}`} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <RepoIssue repo={a.repo} issue={a.issue} />
                  {a.title && <p className="truncate text-sm">{a.title}</p>}
                  <p className="mt-0.5 font-mono text-xs text-status-danger">{a.reason}</p>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" title={a.since ?? undefined}>
                  {a.since ? `${relativeTo(a.since, now)}` : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function UsageCard({ usage, now }: { usage: UsageSummary; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Plan usage
          {usage.paused ? <Badge variant="danger">paused</Badge> : <Badge variant="success">admitting</Badge>}
        </CardTitle>
        <CardDescription>
          Dual-login utilization &amp; cooldowns — new work is held above{" "}
          <span className="font-medium">{usage.admitBelowPercent}%</span>, paused only when every login is spent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {usage.logins.map((login) => (
            <UsageLoginRow key={login.id} login={login} threshold={usage.admitBelowPercent} now={now} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function UsageLoginRow({ login, threshold, now }: { login: UsageLogin; threshold: number; now: number }) {
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{login.id}</span>
          {login.active && <Badge variant="running">active</Badge>}
          {login.gated ? <Badge variant="danger">gated</Badge> : <Badge variant="success">headroom</Badge>}
        </div>
        {login.cooldownUntil && (
          <span className="text-xs text-muted-foreground" title={login.cooldownUntil}>
            cooldown {relativeTo(login.cooldownUntil, now)}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-1">
        {login.windows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No plan signal yet — utilization unknown.</p>
        ) : (
          login.windows.map((w) => {
            const pct = w.utilization;
            const over = pct !== null && pct >= threshold;
            return (
              <div key={w.type} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 font-mono text-muted-foreground">{w.type}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={over ? "h-full bg-status-danger" : "h-full bg-status-running"}
                    style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right tabular-nums">{pct === null ? "—" : `${pct}%`}</span>
                <span className="w-24 shrink-0 text-right text-muted-foreground" title={w.resetsAt ?? undefined}>
                  {w.resetsAt ? `resets ${relativeTo(w.resetsAt, now)}` : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </li>
  );
}
