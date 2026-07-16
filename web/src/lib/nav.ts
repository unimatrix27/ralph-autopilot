/**
 * The control-plane's primary navigation, shared by the app-shell sidebar and the
 * ⌘K command palette so the two never drift. Routes are stubs in the foundations
 * slice; each later slice fills one in (epic #106).
 */
import type { ComponentType, SVGProps } from "react";
import {
  ActivityIcon,
  BarChartIcon,
  HeartPulseIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
  ListIcon,
  RouteIcon,
  UsersIcon,
} from "@/components/icons";

export interface NavItem {
  path: string;
  label: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Overview", description: "What needs you, fleet & pipeline", Icon: HomeIcon },
  { path: "/live", label: "Live", description: "Watch agents work in real time", Icon: ActivityIcon },
  { path: "/runs", label: "Runs", description: "Run history & transcripts", Icon: ListIcon },
  { path: "/inbox", label: "Inbox", description: "Answer escalations", Icon: InboxIcon },
  { path: "/backlog", label: "Backlog", description: "Eligible, blocked & paused issues", Icon: LayersIcon },
  { path: "/analytics", label: "Analytics", description: "Throughput, time-to-merge & quality trends", Icon: BarChartIcon },
  { path: "/routing", label: "Routing", description: "Per-type provider·model & account pool", Icon: RouteIcon },
  { path: "/accounts", label: "Accounts", description: "Pool identity, live usage & park state", Icon: UsersIcon },
  { path: "/health", label: "Health", description: "Daemon health & usage", Icon: HeartPulseIcon },
];
