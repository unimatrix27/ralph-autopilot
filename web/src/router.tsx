import type { FC } from "react";
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { OverviewPage } from "@/routes/overview";
import { LivePage } from "@/routes/live";
import { RunsPage } from "@/routes/runs";
import { RunDetailPage } from "@/routes/run-detail";
import { InboxPage } from "@/routes/inbox";
import { InboxFocusPage } from "@/routes/inbox-focus";
import { BacklogPage } from "@/routes/backlog";
import { AnalyticsPage } from "@/routes/analytics";
import { RoutingPage } from "@/routes/routing";
import { HealthPage } from "@/routes/health";
import { PageHeader, ComingSoon } from "@/components/page";

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: () => (
    <>
      <PageHeader title="Not found" />
      <ComingSoon title="No such page">That route doesn't exist. Use ⌘K to jump somewhere.</ComingSoon>
    </>
  ),
});

const route = <P extends string>(path: P, component: FC) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

/** The run-detail route is keyed by `?repo=&issue=` search params (one run per issue). */
const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/run",
  component: RunDetailPage,
  validateSearch: (search: Record<string, unknown>): { repo: string; issue: number } => ({
    repo: typeof search.repo === "string" ? search.repo : "",
    issue: Number(search.issue ?? 0) || 0,
  }),
});

const routeTree = rootRoute.addChildren([
  route("/", OverviewPage),
  route("/live", LivePage),
  route("/runs", RunsPage),
  runDetailRoute,
  route("/inbox", InboxPage),
  route("/inbox/focus", InboxFocusPage),
  route("/backlog", BacklogPage),
  route("/analytics", AnalyticsPage),
  route("/routing", RoutingPage),
  route("/health", HealthPage),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
