/**
 * Public barrel for the embedded server (daemon-side; node imports allowed here,
 * unlike the contract leaf). Re-exports the server, its ports, and the two security
 * seams so the composition root and tests import from one place.
 */
export { WebServer } from "./server";
export type { WebServerDeps } from "./server";
export type {
  WebControlPlanePorts,
  DaemonControl,
  OverviewQuery,
  AnalyticsQuery,
  LiveFeedPort,
  BacklogQuery,
  InboxQuery,
  RoutingQuery,
} from "./ports";
export { handleLiveSse } from "./sse";
export { allowAllAuth } from "./auth";
export type { AuthMiddleware, AuthVerdict } from "./auth";
export { isOriginAllowed, isSafeMethod } from "./origin-guard";
export type { OriginCheckContext } from "./origin-guard";
export { safeResolve, serveStatic, contentTypeFor } from "./static";
