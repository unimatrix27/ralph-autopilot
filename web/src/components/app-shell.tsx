import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { formatRelativeDe, type OverviewResponse } from "@contract";
import { cn } from "@/lib/utils";
import { NAV } from "@/lib/nav";
import { fetchHealth, fetchOverview } from "@/lib/api";
import { useNow } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RepoFilter, RepoFilterProvider } from "@/components/repo-filter";
import { CommandPalette, openCommandPalette } from "@/components/command-palette";
import { SearchIcon } from "@/components/icons";
import { LiveFeedProvider } from "@/lib/live";

/**
 * The app shell (epic #106): a persistent sidebar (aggregate-first navigation), a
 * topbar carrying the repo-filter affordance and the ⌘K trigger, and the routed
 * content area. The command palette is mounted here so it lives inside the router
 * context and is reachable from every route.
 *
 * The live (SSE) feed (issue #109) is mounted here too, so it runs on every route: it
 * merges live data into the query cache and, via its coalesced `overview` refresh, makes
 * the nav's attention/running badges update **without a page refresh**.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  // The repo-filter list is the full, unnarrowed set the read API returns (issue
  // #108). Fetched here, aggregate, so the filter is populated on every route; the
  // selected repo only ever narrows the per-page queries, never this list. The same
  // payload drives the live nav badges (needsYou / fleet); the SSE feed invalidates it
  // on lifecycle changes, so the badges tick live.
  const { data } = useQuery({
    queryKey: ["overview", null],
    queryFn: () => fetchOverview(),
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <LiveFeedProvider>
      <RepoFilterProvider repos={data?.repos ?? []}>
        <div className="min-h-screen bg-background text-foreground">
          <div className="mx-auto flex min-h-screen w-full">
            <Sidebar data={data} />
            <div className="flex min-h-screen w-full flex-1 flex-col">
              <Topbar data={data} />
              <main className="flex-1 p-4 sm:p-6 lg:p-8">
                <div className="mx-auto w-full max-w-6xl">{children}</div>
              </main>
            </div>
          </div>
          <CommandPalette />
        </div>
      </RepoFilterProvider>
    </LiveFeedProvider>
  );
}

/** A live count badge for a nav route, or `null` when there is nothing to flag. */
interface NavBadge {
  count: number;
  variant: "attention" | "running";
}

/**
 * Derive the live badge for a route from the aggregate overview: Overview flags every
 * attention item, Inbox flags escalations awaiting an answer, and Live flags the running
 * fleet. These refresh from the SSE feed, so a new attention item lights up without a
 * manual refresh (issue #109).
 */
function navBadge(path: string, data: OverviewResponse | undefined): NavBadge | null {
  if (!data) {
    return null;
  }
  switch (path) {
    case "/":
      return data.needsYou.length > 0 ? { count: data.needsYou.length, variant: "attention" } : null;
    case "/inbox": {
      const answers = data.needsYou.filter((i) => i.state === "awaiting-answer").length;
      return answers > 0 ? { count: answers, variant: "attention" } : null;
    }
    case "/live":
      return data.fleet.length > 0 ? { count: data.fleet.length, variant: "running" } : null;
    default:
      return null;
  }
}

function Sidebar({ data }: { data: OverviewResponse | undefined }) {
  // The daemon uptime readout (issue #232): anchored on the absolute `startedAt` instant, so a
  // slow poll suffices — the live ticker, not the fetch, drives the per-minute text change.
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
    retry: false,
  });
  const now = useNow(30_000);
  const uptime = health ? formatRelativeDe(health.startedAt, now) : "—";

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/40 md:flex">
      <div className="flex h-16 items-center gap-2 px-5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          r
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">ralph-autopilot</div>
          <div className="text-[11px] text-muted-foreground">control plane</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV.map((item) => {
          const badge = navBadge(item.path, data);
          return (
            <Link
              key={item.path}
              to={item.path}
              activeOptions={{ exact: item.path === "/" }}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
              )}
              activeProps={{ className: "bg-accent text-accent-foreground" }}
            >
              <item.Icon className="h-4 w-4" />
              <span className="flex-1">{item.label}</span>
              {badge && (
                <Badge variant={badge.variant} className="h-5 min-w-5 justify-center px-1.5 tabular-nums">
                  {badge.count}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>
      {uptime !== "—" && (
        <div className="px-4 py-3 text-[11px] text-muted-foreground">
          Gestartet {uptime}
        </div>
      )}
    </aside>
  );
}

function Topbar({ data }: { data: OverviewResponse | undefined }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:px-6">
      {/* Mobile brand (the sidebar is hidden below md). */}
      <div className="flex items-center gap-2 md:hidden">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          r
        </span>
      </div>
      <div className="w-44 sm:w-56">
        <RepoFilter />
      </div>
      <div className="flex-1" />
      <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={openCommandPalette}>
        <SearchIcon className="h-4 w-4" />
        <span className="hidden sm:inline">Search…</span>
        <kbd className="ml-1 hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">⌘K</kbd>
      </Button>
      {/* Compact nav for small screens (the sidebar is hidden). */}
      <MobileNav data={data} />
    </header>
  );
}

function MobileNav({ data }: { data: OverviewResponse | undefined }) {
  return (
    <nav className="flex items-center gap-1 md:hidden">
      {NAV.map((item) => {
        const badge = navBadge(item.path, data);
        return (
          <Link
            key={item.path}
            to={item.path}
            activeOptions={{ exact: item.path === "/" }}
            aria-label={badge ? `${item.label} (${badge.count})` : item.label}
            className="relative rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            activeProps={{ className: "bg-accent text-accent-foreground" }}
          >
            <item.Icon className="h-5 w-5" />
            {badge && (
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white",
                  badge.variant === "attention" ? "bg-status-attention" : "bg-status-running",
                )}
              >
                {badge.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
