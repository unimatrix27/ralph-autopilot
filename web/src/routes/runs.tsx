import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunStatusWire, RunSummary } from "@contract";
import { fetchRuns } from "@/lib/api";
import { ALL_REPOS, useRepoFilter } from "@/components/repo-filter";
import { formatWaited, useNow } from "@/lib/time";
import { githubIssueUrl, issueHeading } from "@/lib/github";
import { PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type BadgeVariant = "outline" | "success" | "danger" | "running" | "waiting" | "attention";

/** Status → (label, badge tone), mirroring the daemon's label state machine. */
const STATUS_META: Record<RunStatusWire, { label: string; variant: BadgeVariant }> = {
  running: { label: "Running", variant: "running" },
  "awaiting-answer": { label: "Awaiting answer", variant: "attention" },
  "agent-stuck": { label: "Agent stuck", variant: "danger" },
  "review-maxed": { label: "Review maxed", variant: "danger" },
  "awaiting-ci": { label: "Awaiting CI", variant: "waiting" },
  "awaiting-merge": { label: "Awaiting merge", variant: "waiting" },
  merged: { label: "Merged", variant: "success" },
  closed: { label: "Closed", variant: "outline" },
};

/**
 * The **Runs** history index (issue #111): every run across all repos, newest-first, each a
 * link into the run-detail + transcript viewer. The repo filter narrows the list.
 */
export function RunsPage() {
  const { repo } = useRepoFilter();
  const filter = repo === ALL_REPOS ? undefined : repo;
  const nowMs = useNow(1000);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["runs", filter ?? null],
    queryFn: () => fetchRuns(filter),
    refetchInterval: 30_000,
    retry: false,
  });

  const runs = data?.runs ?? [];

  return (
    <>
      <PageHeader title="Runs" subtitle="Run history and readable transcripts — open any run to read its conversation." />

      {isError && (
        <Card className="border-status-danger/40">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <Badge variant="danger">unreachable</Badge>
            <span className="text-muted-foreground">The control plane did not answer. Is the daemon running?</span>
          </CardContent>
        </Card>
      )}

      {isLoading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && runs.length === 0 && (
        <Card>
          <CardContent className="py-10 text-sm text-muted-foreground">
            No runs yet{filter ? <> in <span className="font-mono text-foreground">{filter}</span></> : ""}. Runs appear
            here as the daemon picks up issues.
          </CardContent>
        </Card>
      )}

      {runs.length > 0 && (
        <div className="divide-y rounded-lg border">
          {runs.map((run) => (
            <RunRow key={`${run.repo}#${run.issue}`} run={run} nowMs={nowMs} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One run-history row (issue #13): the GitHub issue title is the row's primary text (fallback
 * to `repo #issue` when the title is null — durable even for a finished run whose issue has
 * since closed), with the repo + `#issue` reference linking out to the issue on GitHub.
 *
 * The row navigates to the transcript, but the GitHub reference is its own external anchor — an
 * `<a>` nested in a router `Link` is invalid HTML. So the transcript `Link` is a stretched
 * overlay covering the row and the GitHub anchor sits above it (`relative z-10`) with propagation
 * stopped, so clicking it opens *only* GitHub while a click anywhere else opens the transcript.
 */
function RunRow({ run, nowMs }: { run: RunSummary; nowMs: number }) {
  const meta = STATUS_META[run.status];
  const heading = issueHeading(run.title, run.repo, run.issue);
  return (
    <div className="relative flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40">
      <Link
        to="/run"
        search={{ repo: run.repo, issue: run.issue }}
        className="absolute inset-0 z-0 focus:outline-none"
        aria-label={`Open transcript for ${heading}`}
      />
      <Badge variant={meta.variant} className="shrink-0">
        {meta.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground">{heading}</div>
        <a
          href={githubIssueUrl(run.repo, run.issue)}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 inline-flex font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {run.repo}
          <span className="text-foreground"> #{run.issue}</span>
        </a>
      </div>
      <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
        {run.mode}
      </Badge>
      {run.prNumber !== null && (
        <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">PR #{run.prNumber}</span>
      )}
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatWaited(run.updatedAt, nowMs)} ago</span>
    </div>
  );
}
