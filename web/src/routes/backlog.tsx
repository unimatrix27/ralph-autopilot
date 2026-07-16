import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BACKLOG_PAUSED_STATES,
  type BacklogBlockedItem,
  type BacklogEligibleItem,
  type BacklogManualHoldItem,
  type BacklogModingCandidateItem,
  type BacklogNoProviderItem,
  type BacklogPausedItem,
  type BacklogPausedStateWire,
  type BacklogPriorityColorWire,
  type PowerActionCatalogWire,
} from "@contract";
import { fetchBacklog } from "@/lib/api";
import { formatClock } from "@/lib/time";
import { ALL_REPOS, useRepoFilter } from "@/components/repo-filter";
import { PageHeader } from "@/components/page";
import { RepoIssue } from "@/components/repo-issue";
import { PowerActions } from "@/components/power-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { statusFor, toneVariant } from "@/lib/status";
import { cn } from "@/lib/utils";

/** The priority-colour dot → a concrete swatch from the status palette. */
const PRIORITY_DOT: Record<BacklogPriorityColorWire, string> = {
  red: "bg-status-danger",
  yellow: "bg-status-waiting",
  blue: "bg-status-eligible",
};

export function BacklogPage() {
  const { repo } = useRepoFilter();
  const filter = repo === ALL_REPOS ? undefined : repo;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["backlog", filter ?? null],
    queryFn: () => fetchBacklog(filter),
    refetchInterval: 5_000,
    retry: false,
  });

  const scope = filter ? <span className="font-mono">{filter}</span> : "all repos";

  return (
    <>
      <PageHeader
        title="Backlog"
        subtitle="What is queued, blocked, parked, or misconfigured — aggregate across all repos, in the daemon's pick-order."
      />

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
          <EligibleSection items={data.eligible} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
          <NoProviderSection items={data.noProvider} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
          <BlockedSection items={data.blocked} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
          <PausedSection items={data.paused} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
          <ManualHoldsSection items={data.manualHolds} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
          <ModingSection items={data.modingCandidates} reconcileIntervalSeconds={data.reconcileIntervalSeconds} catalog={data.powerActions} />
        </div>
      )}
    </>
  );
}

function SectionCard({
  title,
  description,
  count,
  countVariant,
  empty,
  children,
}: {
  title: string;
  description: string;
  count: number;
  countVariant?: React.ComponentProps<typeof Badge>["variant"];
  empty: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {count > 0 && <Badge variant={countVariant ?? "outline"}>{count}</Badge>}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : children}
      </CardContent>
    </Card>
  );
}

function EligibleSection({ items, reconcileIntervalSeconds, catalog }: { items: BacklogEligibleItem[]; reconcileIntervalSeconds: number; catalog: PowerActionCatalogWire }) {
  return (
    <SectionCard
      title="Eligible"
      description="Passed the gate and queued — listed top-to-bottom in the daemon's actual pick-order."
      count={items.length}
      countVariant="eligible"
      empty="Nothing eligible. The queue is empty."
    >
      <ol className="divide-y rounded-md border">
        {items.map((item, i) => (
          <li key={`${item.repo}#${item.issue}`} className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-6 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <RepoIssue repo={item.repo} issue={item.issue} />
                  <p className="truncate text-sm">{item.title}</p>
                </div>
              </div>
              {item.priority && (
                <span className="flex shrink-0 items-center gap-1.5" title={`priority: ${item.priority}`}>
                  {item.priorityColor && (
                    <span className={cn("h-2 w-2 rounded-full", PRIORITY_DOT[item.priorityColor])} />
                  )}
                  <span className="font-mono text-xs text-muted-foreground">{item.priority}</span>
                </span>
              )}
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
      </ol>
    </SectionCard>
  );
}

/**
 * The ADR-0037 no-provider wait (issue #165): eligible issues parked because no allowed provider
 * has headroom this tick — rendered **distinctly** from the eligible "queued for a slot" section.
 * Each row reads "waiting — no provider with headroom", appending "(resets ~HH:MM)" only when a
 * reset ETA is present, so a missing ETA degrades gracefully.
 */
function NoProviderSection({ items, reconcileIntervalSeconds, catalog }: { items: BacklogNoProviderItem[]; reconcileIntervalSeconds: number; catalog: PowerActionCatalogWire }) {
  return (
    <SectionCard
      title="Waiting — no provider"
      description="Eligible, but no provider has an account with headroom this tick — re-resolved automatically once a usage window resets."
      count={items.length}
      countVariant="waiting"
      empty="None waiting on a provider. Every eligible issue has a provider with headroom."
    >
      <ul className="divide-y rounded-md border">
        {items.map((item) => (
          <li key={`${item.repo}#${item.issue}`} className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <RepoIssue repo={item.repo} issue={item.issue} />
                <p className="truncate text-sm">{item.title}</p>
              </div>
              <span className="shrink-0 whitespace-nowrap text-xs text-status-waiting" title={item.resetsAt ?? undefined}>
                waiting — no provider with headroom
                {item.resetsAt && <span className="ml-1 text-muted-foreground">(resets ~{formatClock(item.resetsAt)})</span>}
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
    </SectionCard>
  );
}

function BlockedSection({ items, reconcileIntervalSeconds, catalog }: { items: BacklogBlockedItem[]; reconcileIntervalSeconds: number; catalog: PowerActionCatalogWire }) {
  return (
    <SectionCard
      title="Blocked"
      description="Held on an unsatisfied “## Blocked by” dependency — each dep marked satisfied (closed + merged) or outstanding."
      count={items.length}
      countVariant="waiting"
      empty="Nothing blocked. No unmet dependencies."
    >
      <ul className="divide-y rounded-md border">
        {items.map((item) => {
          const satisfied = item.blockers.filter((b) => b.satisfied).length;
          return (
            <li key={`${item.repo}#${item.issue}`} className="space-y-2 px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <RepoIssue repo={item.repo} issue={item.issue} />
                  <p className="truncate text-sm">{item.title}</p>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                  {satisfied}/{item.blockers.length} deps satisfied
                </span>
              </div>
              <DependencyGraph blockers={item.blockers} />
              <PowerActions
                repo={item.repo}
                issue={item.issue}
                reconcileIntervalSeconds={reconcileIntervalSeconds}
                catalog={catalog}
                surface={item.powerActionSurface}
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

/** The dependency mini-graph: one chip per “## Blocked by” ref, satisfied vs outstanding. */
function DependencyGraph({ blockers }: { blockers: BacklogBlockedItem["blockers"] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">blocked by</span>
      {blockers.map((dep) => (
        <span
          key={dep.ref}
          title={dep.satisfied ? "satisfied (closed + merged)" : "outstanding"}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs",
            dep.satisfied
              ? "border-status-success/40 text-status-success line-through opacity-70"
              : "border-status-danger/50 text-status-danger",
          )}
        >
          {/* A string ref is a verbatim cross-repo `owner/repo#n` the gate cannot evaluate. */}
          <span aria-hidden>{dep.satisfied ? "✓" : "○"}</span>
          {typeof dep.ref === "number" ? `#${dep.ref}` : dep.ref}
        </span>
      ))}
    </div>
  );
}

function PausedSection({ items, reconcileIntervalSeconds, catalog }: { items: BacklogPausedItem[]; reconcileIntervalSeconds: number; catalog: PowerActionCatalogWire }) {
  return (
    <SectionCard
      title="Paused / stuck"
      description="Issues carrying a human-attention label — grouped by attention state, most urgent first."
      count={items.length}
      countVariant="attention"
      empty="Nothing paused. No issue is waiting on a human."
    >
      <div className="space-y-4">
        {BACKLOG_PAUSED_STATES.map((state) => {
          const group = items.filter((i) => i.state === state);
          if (group.length === 0) return null;
          return <PausedGroup key={state} state={state} items={group} reconcileIntervalSeconds={reconcileIntervalSeconds} catalog={catalog} />;
        })}
      </div>
    </SectionCard>
  );
}

function PausedGroup({
  state,
  items,
  reconcileIntervalSeconds,
  catalog,
}: {
  state: BacklogPausedStateWire;
  items: BacklogPausedItem[];
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
            <div className="min-w-0">
              <RepoIssue repo={item.repo} issue={item.issue} />
              <p className="truncate text-sm">{item.title}</p>
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

function ManualHoldsSection({
  items,
  reconcileIntervalSeconds,
  catalog,
}: {
  items: BacklogManualHoldItem[];
  reconcileIntervalSeconds: number;
  catalog: PowerActionCatalogWire;
}) {
  return (
    <SectionCard
      title="Manual holds"
      description="Ready issues held by hitl — return them to afk when they should re-enter admission."
      count={items.length}
      countVariant="waiting"
      empty="No manual holds. Nothing is paused by the operator."
    >
      <ul className="divide-y rounded-md border">
        {items.map((item) => (
          <li key={`${item.repo}#${item.issue}`} className="space-y-2 px-4 py-3">
            <div className="min-w-0">
              <RepoIssue repo={item.repo} issue={item.issue} />
              <p className="truncate text-sm">{item.title}</p>
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
    </SectionCard>
  );
}

function ModingSection({ items, reconcileIntervalSeconds, catalog }: { items: BacklogModingCandidateItem[]; reconcileIntervalSeconds: number; catalog: PowerActionCatalogWire }) {
  return (
    <SectionCard
      title="Moding-pass candidates"
      description="Marked ready-for-agent + afk but missing a mode:* label — what the auto-mode pass fills in next."
      count={items.length}
      countVariant="outline"
      empty="None. Every ready issue carries a mode."
    >
      <ul className="divide-y rounded-md border">
        {items.map((item) => (
          <li key={`${item.repo}#${item.issue}`} className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <RepoIssue repo={item.repo} issue={item.issue} />
                <p className="truncate text-sm">{item.title}</p>
              </div>
              <Badge variant="outline" className="shrink-0">
                no mode
              </Badge>
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
    </SectionCard>
  );
}
