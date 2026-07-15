/**
 * The browser-safe contract leaf (ADR-0031) — the single import surface for both
 * the daemon (`src/web/server`) and the UI (`@contract`). Re-exports every wire
 * schema/type and route constant. **Zero node imports**: this module and
 * everything it pulls in must stay browser-safe (see ./README.md).
 */
export { API_BASE, API_ROUTES } from "./routes";
export type { ApiRoute } from "./routes";
export { repoSlug, issueNumber, providerName, routeSchema } from "./primitives";
export type { ProviderNameWire, Route } from "./primitives";
export { formatRoute, ROUTE_SEPARATOR } from "./route-view";
export { healthResponseSchema } from "./health";
export type { HealthResponse } from "./health";
export {
  daemonHealthSchema,
  anomalyItemSchema,
  usageWindowSchema,
  usageLoginSchema,
  usageSummarySchema,
  healthUsageResponseSchema,
} from "./health-usage";
export type {
  DaemonHealth,
  AnomalyItem,
  UsageWindow,
  UsageLogin,
  UsageSummary,
  HealthUsageResponse,
} from "./health-usage";
export {
  NEEDS_YOU_STATES,
  needsYouStateSchema,
  needsYouItemSchema,
  fleetAgentSchema,
  pipelineFunnelSchema,
  activityItemSchema,
  overviewResponseSchema,
} from "./overview";
export type {
  NeedsYouState,
  NeedsYouItem,
  FleetAgent,
  PipelineFunnel,
  ActivityItem,
  OverviewResponse,
} from "./overview";
export {
  liveEventSchema,
  TRANSCRIPT_STREAM_PREFIX,
  isTranscriptStreamId,
  parseTranscriptStreamRef,
  classifyLiveEvent,
  transcriptLatestLine,
} from "./live";
export type {
  LiveEvent,
  TranscriptStreamRef,
  ClassifiedLiveEvent,
  TranscriptLiveEvent,
  DomainLiveEvent,
  LiveLine,
  LiveLineKind,
} from "./live";
export {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  MIN_ANALYTICS_WINDOW_DAYS,
  MAX_ANALYTICS_WINDOW_DAYS,
  resolveWindowDays,
  analyticsDailyPointSchema,
  distributionBucketSchema,
  analyticsDistributionsSchema,
  analyticsSummarySchema,
  analyticsResponseSchema,
} from "./analytics";
export type {
  AnalyticsDailyPoint,
  DistributionBucket,
  AnalyticsDistributions,
  AnalyticsSummary,
  AnalyticsResponse,
} from "./analytics";
export {
  BACKLOG_PAUSED_STATES,
  backlogPausedStateSchema,
  backlogPriorityColorSchema,
  backlogEligibleItemSchema,
  backlogBlockerSchema,
  backlogBlockedItemSchema,
  backlogPausedItemSchema,
  backlogManualHoldItemSchema,
  backlogModingCandidateItemSchema,
  backlogNoProviderItemSchema,
  backlogResponseSchema,
} from "./backlog";
export type {
  BacklogPausedStateWire,
  BacklogPriorityColorWire,
  BacklogEligibleItem,
  BacklogBlocker,
  BacklogBlockedItem,
  BacklogPausedItem,
  BacklogManualHoldItem,
  BacklogModingCandidateItem,
  BacklogNoProviderItem,
  BacklogResponse,
} from "./backlog";
export {
  RUN_STATUSES,
  runStatusSchema,
  TERMINAL_RUN_STATUSES,
  isLiveRunStatus,
  runModeSchema,
  transcriptPruneReasonSchema,
  transcriptBlockSchema,
  transcriptMessageDataSchema,
  transcriptPrunedDataSchema,
  transcriptEntrySchema,
  timelineEntrySchema,
  runHeaderSchema,
  runDetailResponseSchema,
  runSummarySchema,
  runsResponseSchema,
} from "./run-detail";
export type {
  RunStatusWire,
  RunModeWire,
  TranscriptPruneReasonWire,
  TranscriptBlockWire,
  TranscriptMessageData,
  TranscriptPrunedData,
  TranscriptEntry,
  TimelineEntry,
  RunHeader,
  RunDetailResponse,
  RunSummary,
  RunsResponse,
} from "./run-detail";
export {
  buildRunView,
  searchRunView,
  parseAnsiLines,
  stripAnsi,
  computeLineDiff,
  highlightCode,
  languageForPath,
  extractResultText,
  summariseToolInput,
} from "./run-view";
export { formatRelativeDe } from "./relative-time";
export {
  INBOX_ATTENTION_LABELS,
  INBOX_CONSEQUENCES,
  ANSWER_KINDS,
  inboxAttentionLabelSchema,
  inboxConsequenceSchema,
  escalationQuestionWireSchema,
  inboxCardSchema,
  inboxResponseSchema,
  inboxPhaseLabel,
  inboxResumeTargetText,
  answerKindSchema,
  answerRequestBodySchema,
  answerResponseSchema,
} from "./inbox";
export type {
  InboxAttentionLabelWire,
  InboxConsequenceWire,
  EscalationQuestionWire,
  InboxCard,
  InboxResponse,
  AnswerKindWire,
  AnswerRequestBody,
  AnswerResponse,
} from "./inbox";
export {
  POWER_ACTION_KINDS,
  POWER_ACTION_MODES,
  POWER_ACTION_SURFACES,
  powerActionKindSchema,
  powerActionModeSchema,
  powerActionSurfaceSchema,
  powerActionAffordanceSchema,
  powerActionCatalogSchema,
  powerActionRequestBodySchema,
  powerActionResponseSchema,
} from "./power-actions";
export type {
  PowerActionKindWire,
  PowerActionModeWire,
  PowerActionSurfaceWire,
  PowerActionAffordanceWire,
  PowerActionCatalogWire,
  PowerActionRequestBody,
  PowerActionResponse,
} from "./power-actions";
export {
  drainRequestBodySchema,
  drainResponseSchema,
  forceTickRequestBodySchema,
  forceTickResponseSchema,
  killRunRequestBodySchema,
  killRunResponseSchema,
} from "./control";
export {
  ROUTING_PROVIDERS,
  ROUTING_AGENT_TYPES,
  ROUTING_PHASEABLE_TYPES,
  typeIsPhaseable,
  routingProviderSchema,
  routingAgentTypeSchema,
  routingEntrySchema,
  routingValueSchema,
  routingPhasedValueSchema,
  routingValueOrPhasedSchema,
  isPhasedRoutingValue,
  routingEditRequestBodySchema,
  routingEditResponseSchema,
  effectiveRoutingPhasesSchema,
  effectiveRoutingTypeSchema,
  effectiveRoutingProviderSchema,
  effectiveRoutingAccountSchema,
  effectiveRoutingResponseSchema,
} from "./routing";
export type {
  RoutingProviderWire,
  RoutingAgentTypeWire,
  RoutingEntryWire,
  RoutingValueWire,
  RoutingPhasedValueWire,
  RoutingValueOrPhasedWire,
  RoutingEditRequestBody,
  RoutingEditResponse,
  EffectiveRoutingPhases,
  EffectiveRoutingType,
  EffectiveRoutingProvider,
  EffectiveRoutingAccount,
  EffectiveRoutingResponse,
} from "./routing";
export {
  buildRoutingEditorModel,
  buildClearRoutingEdit,
  buildSetRoutingEdit,
  buildPhasedRoutingEdit,
  preferenceIsPostable,
  phasedPreferenceIsPostable,
  providerDisabledReason,
  providerOptionsFor,
  normaliseEntry,
} from "./routing-editor";
export type {
  ProviderOption,
  TypeRoutingRow,
  PhasedDraft,
  AccountPoolGroup,
  RoutingEditorModel,
} from "./routing-editor";
export {
  vapidPublicKeyResponseSchema,
  subscribeRequestBodySchema,
  subscribeResponseSchema,
  unsubscribeRequestBodySchema,
  unsubscribeResponseSchema,
} from "./push";
export type {
  DrainRequestBody,
  DrainResponse,
  ForceTickRequestBody,
  ForceTickResponse,
  KillRunRequestBody,
  KillRunResponse,
} from "./control";
export type {
  VapidPublicKeyResponse,
  SubscribeRequestBody,
  SubscribeResponse,
  UnsubscribeRequestBody,
  UnsubscribeResponse,
} from "./push";
export type {
  RenderTone,
  ToolStatus,
  CodeToken,
  CodeTokenKind,
  DiffRow,
  AnsiSpan,
  ToolResultView,
  ToolRenderBlock,
  DiffRenderBlock,
  BashRenderBlock,
  EscalationRenderBlock,
  RenderBlock,
  MessageItem,
  PhaseDividerItem,
  RunViewItem,
  TimelineNode,
  RunHeaderView,
  PrunedView,
  RunView,
  SearchMatch,
} from "./run-view";
