/**
 * ralph-autopilot — public surface: the foundation substrate (configuration, the
 * SQLite runtime-state store, the structured logger) plus the core loop (the
 * GitHub window, admission — the eligibility gate + scheduling, the per-issue
 * executor, and the reconciler). Later slices (review loop, CLIs, TUI) build on these.
 */

export { loadConfig, parseConfig, resolveTargets, resolveAccountPool, groupAccountsByProvider, ConfigError, DEFAULT_CONFIG_PATH } from "./config/load";
export { configSchema } from "./config/schema";
export type {
  RalphConfig,
  RalphConfigInput,
  TargetConfig,
  TargetInput,
  AgentSettings,
  MergeSettings,
  ReviewSettings,
  AutoModeSettings,
  UsageLimitSettings,
  ProviderName,
  ProvidersSettings,
  Account,
  AgentTypeOverride,
  AgentTypeEntry,
  AgentTypeRouting,
  PhasedAgentTypeRouting,
  ReviewFixRouting,
  EffortLevel,
  TierProfile,
  AgentTiers,
} from "./config/schema";

export { openStore, Store, ScopedStore, MEMORY_DB } from "./store/store";
export { runMigrations, MIGRATIONS } from "./store/migrations";
export type { Migration } from "./store/migrations";

// ---- live broadcast: in-process after-commit channel (ADR-0029, issue #109) ----
export { LogBroadcaster } from "./store/log-broadcast";
export type {
  RecordedLogEvent,
  LiveSubscription,
} from "./store/log-broadcast";
export { createLiveFeedPort, LIVE_TAIL_BATCH_SIZE, startLiveTail } from "./store/live-feed";
export type { LiveFeedPort, LiveTail, LiveTailErrorPhase, LiveTailOptions } from "./store/live-feed";
export type { LiveWakeHandler } from "./store/live-feed";
export { createDaemonHealthPort, latestDaemonTickAt } from "./store/daemon-health";
export type { DaemonHealthPort } from "./store/daemon-health";

// ---- event log: decider + inline projections (ADR-0021..0027) -----------
export { EventLog } from "./store/event-log";
export type {
  IssueAggregate,
  SystemAggregate,
  RecordedTranscriptEvent,
  TranscriptPruneResult,
} from "./store/event-log";
// Agent transcripts (ADR-0030): the per-run stream vocabulary + pure mapper + retention.
export {
  transcriptStreamId,
  parseTranscriptStreamId,
  isTranscriptStream,
  mapSdkMessageToTranscript,
  planTranscriptRetention,
  TRANSCRIPT_STREAM_PREFIX,
  TRANSCRIPT_MESSAGE_TYPE,
  TRANSCRIPT_PRUNED_TYPE,
} from "./store/events/transcript";
export type {
  TranscriptEvent,
  TranscriptEventType,
  TranscriptMessage,
  TranscriptPruned,
  TranscriptBlock,
  TranscriptRole,
  TranscriptStreamRef,
  TranscriptStreamSummary,
  TranscriptRetentionBudget,
  TranscriptPrunePlan,
  TranscriptPruneReason,
} from "./store/events/transcript";
export {
  decide,
  evolve,
  initialIssueState,
  issueDecider,
  IssueCommandError,
} from "./store/events/decider";
// `IssueActualState` here is the daemon's folded per-issue actual state (ADR-0021);
// distinct from GitHub's `IssueState` (open/closed) exported below from ./github/types.
export type {
  IssueState as IssueActualState,
  IssueLifecycle,
  IssueCommand,
} from "./store/events/decider";
export { ISSUE_EVENT_TYPES } from "./store/events/event-types";
export type { IssueEvent, IssueEventType, RunOutcome } from "./store/events/event-types";
// Curated surface only (CLAUDE.md): the read-side fold + the projection table name
// are consumer-facing; the write-path codecs and raw UPSERT/DDL SQL stay module-private
// (their only callers are event-log.ts + the projection's own tests). ADR-0025's
// cluster-migration slices consume the log via EventLog/decider, not the table internals.
export { foldIssueState, ISSUE_PROJECTION_TABLE } from "./store/events/projection";
export type { IssueProjectionRow } from "./store/events/projection";
// The open-question projection (slice 3, issue #79): the table name is consumer-facing;
// the inline-projection factory + codecs stay module-private (only event-log.ts calls them).
export { OPEN_QUESTIONS_TABLE } from "./store/events/open-questions-projection";
// The resume-context projection (slice 4, issue #80): same surface policy — the table
// name is consumer-facing; the projection factory + codecs stay module-private.
export { RESUME_CONTEXT_TABLE } from "./store/events/resume-context-projection";
export {
  issueStreamId,
  parseIssueStreamId,
  isSystemStream,
  SYSTEM_STREAM_ID,
} from "./store/events/streams";
export type { IssueStreamRef } from "./store/events/streams";
export { evolveSystem, initialSystemState, SYSTEM_EVENT_TYPES } from "./store/events/system";
export type { SystemEvent, SystemEventType, SystemState } from "./store/events/system";
export type {
  Mode,
  ComplexityTier,
  Phase,
  RunStatus,
  QuestionStatus,
  QuestionKind,
  Run,
  RunInput,
  ResumeContext,
  ResumePayload,
  OpenQuestion,
  OpenQuestionInput,
  AgentRecord,
  AgentInput,
  RunLogEntry,
  RunLogInput,
  DaemonSnapshot,
  DaemonError,
  BacklogView,
  BacklogEligible,
  BacklogBlocked,
  BacklogPaused,
  BacklogModingCandidate,
  BacklogBlockerRef,
  BacklogPausedState,
  PushSubscription,
  PushSubscriptionInput,
  PhaseRoute,
} from "./store/types";

export { Logger, createLogger, redact, REDACTED } from "./log/logger";
export type { LogLevel, LogFields, LoggerOptions } from "./log/logger";

// ---- GitHub window ------------------------------------------------------
export { GhCliClient } from "./github/gh-cli";
export type { GhCliOptions } from "./github/gh-cli";
export { parseBlockedBy } from "./github/blocked";
export { buildLaunchMarker, parseLaunchMarker } from "./github/marker";
export type { LaunchMarker } from "./github/marker";
export { classifyChecks, commentIdFromUrl, isGitHubRateLimitError } from "./github/gh-cli";
export type { RawCheck } from "./github/gh-cli";
export type {
  Issue,
  IssueState,
  PullRequest,
  PullRequestState,
  PrComment,
  MergeMethod,
  CheckState,
  ChecksResult,
  ChecksSnapshot,
  AwaitChecksOptions,
  MergeOptions,
  GitHubClient,
} from "./github/types";

// ---- core loop: admission (gate + scheduling) + label vocabulary --------
export {
  modeLabelFor,
  readMode,
  tierLabelFor,
  readTier,
  LABEL_READY,
  LABEL_AFK,
  LABEL_HITL,
  LABEL_MODE_TDD,
  LABEL_MODE_INFRA,
  LABEL_MODE_UI,
  LABEL_COMPLEXITY_1,
  LABEL_COMPLEXITY_2,
  LABEL_COMPLEXITY_3,
} from "./core/labels";
export { admit, RE_ADMITTABLE_STATUSES, SPAN_CLOSED_STATUSES } from "./core/admission";
export type { World, LaunchPlan, ExcludedIssue, ExclusionReason } from "./core/admission";
export { selectModingCandidates, modeDecisionSchema, parseModeDecision } from "./core/moding";
export type { ModeClassifier, ModeContext, ModeDecision } from "./core/moding";
export {
  usageGate,
  recordRateLimit,
  rateLimitSignalSchema,
  tripCooldown,
  isUsageLimitError,
  isTokenGated,
  pickActiveToken,
  resetToMs,
  EMPTY_USAGE,
  DEFAULT_COOLDOWN_MS,
} from "./core/usage";
export type {
  UsageState,
  UsageGateResult,
  RateLimitSignal,
  RateLimitWindowState,
  Subscription,
  ActiveToken,
} from "./core/usage";
export { slugify, branchName, worktreeDirName } from "./core/slug";
export {
  renderFencedPayload,
  extractFencedPayload,
  parseFencedPayload,
  hasFencedPayload,
  sanitizeForFence,
} from "./core/fenced-payload";

// ---- executor: worktree + impl agent -----------------------------------
export { GitWorktreeManager } from "./executor/worktree";
export type { WorktreeManager, GitWorktreeOptions, RebaseResult } from "./executor/worktree";
export { Executor } from "./executor/executor";
export type { PickedIssue, ClaimedRun, ExecutorResult, ExecutorDeps } from "./executor/executor";
export {
  buildAgentOptions,
  runReapedWallClockedSession,
  selectCuratedMcpServers,
  loadBoxMcpServers,
  resolveMcpServerDefs,
  MCP_WORKSPACE_TOKEN,
  MEMORY_MCP,
} from "./executor/agent";
export type {
  AgentRunner,
  AgentRunContext,
  AgentRunResult,
  EndpointOverride,
  SessionParams,
  ClassifiedSessionResult,
} from "./executor/agent";
// ---- container execution: the daemon↔runner pipe + ContainerExecution (ADR-0038, #184) ----
export {
  PROTOCOL_VERSION,
  ProtocolVersionError,
  ProtocolDecodeError,
  encodeFrame,
  decodeFrame,
} from "./container/protocol";
export type {
  Frame,
  TelemetryFrame,
  LifecycleTelemetry,
  TranscriptTelemetry,
  RateLimitTelemetry,
  ResultFrame,
  ResultOutcome,
  EscalationResult,
  StuckResult,
  ControlFrame,
  ControlSignal,
} from "./container/protocol";
export { LocalPipeTransport } from "./container/transport";
export type { Transport, LocalPipeEnds } from "./container/transport";
export type { Assignment, RunToken, ContainerDispatch, ContainerRoute, SessionProfile } from "./container/assignment";
// `runStubRunner` / `StubRunnerOptions` are walking-skeleton placeholders the real runner
// replaces (ADR-0038, epic #182 slice 3); deliberately *not* on the curated public surface.
export { ContainerExecution } from "./container/container-execution";
export type {
  DockerRunner,
  RunningContainer,
  ContainerExecutionDeps,
  ContainerSweeper,
  DispatchOptions,
} from "./container/container-execution";
export { recordTerminalResult } from "./container/record-result";
export type { TerminalRunRecorder, TerminalRunRef } from "./container/record-result";
// The real in-container runner + its daemon-side adapter, telemetry→store fold, and docker port
// (ADR-0038, epic #182 slice 3/5; issue #185).
export { runContainerRunner } from "./container/runner";
export type {
  ContainerRunnerDeps,
  RunnerEscalation,
  RunnerEscalationInput,
  SessionHost,
  SessionHostInput,
  WorkspaceCloner,
  RunnerWorkspace,
  ReviewSessionHost,
  FixSessionHost,
  ReviewFixSessionInput,
} from "./container/runner";
export { recordTelemetry, createTelemetrySink } from "./container/record-telemetry";
export type { TranscriptRunRecorder, TelemetryRunRef, TelemetrySink } from "./container/record-telemetry";
// The daemon-side fold of a container-reported per-account rate-limit signal into the usage meter
// (ADR-0037 account meter / ADR-0038 best-effort pipe, issue #228).
export { foldRateLimitTelemetry } from "./container/record-rate-limit";
export type { RecordRateLimitSignal } from "./container/record-rate-limit";
export { ContainerAgentRunner } from "./container/container-agent-runner";
export type { ContainerAgentRunnerDeps, ContainerRunStore } from "./container/container-agent-runner";
// The review-loop's review + fix runs through a container (ADR-0038, epic #182 slice; issue #189).
export {
  ContainerReviewAgentRunner,
  ContainerFixAgentRunner,
} from "./container/container-review-fix-runner";
export type { ContainerReviewFixDeps } from "./container/container-review-fix-runner";
// Recording the resolved route per phase at dispatch (ADR-0037 P3.1, issue #164).
export { recordDispatchedRoute, toPhaseRoute } from "./container/route-recording";
export type { RouteRecordingStore } from "./container/route-recording";
export {
  DockerCliRunner,
  buildDockerRunArgs,
  buildStopArgs,
  buildPsArgs,
  parsePsContainers,
  containerNameForBranch,
  uniqueContainerName,
  DISPATCH_ENV_VAR,
  CONTAINER_NAME_PREFIX,
  REPO_LABEL_KEY,
  BRANCH_LABEL_KEY,
  DEFAULT_STOP_TIMEOUT_SECONDS,
} from "./container/docker-runner";
export type { DockerRunnerConfig, ContainerCredentialMounts, DockerSpawn, RunningContainerView } from "./container/docker-runner";
// The target onboarding contract (.ralph/agent.yaml) + per-target image build/L2 cache (ADR-0038, #190).
export {
  agentContractSchema,
  loadAgentContract,
  parseAgentContract,
  AgentContractError,
  DEFAULT_AGENT_CONTRACT_PATH,
} from "./container/agent-contract";
export type { AgentContract } from "./container/agent-contract";
export {
  computeDepsCacheKey,
  targetImageRef,
  buildImageBuildArgs,
  ensureTargetImage,
  resolveImageBuildInput,
  fsManifestSources,
  DockerCliImageBuilder,
} from "./container/image-build";
export type {
  TargetImageBuildInput,
  EnsuredImage,
  ImageBuilderDeps,
  ManifestSources,
  ImageBuildArgs,
} from "./container/image-build";
export {
  createGitCloner,
  createImplSessionHost,
  createReviewSessionHost,
  createFixSessionHost,
  createRunnerEscalation,
} from "./container/in-container-session";
export type { GitClonerConfig, RunGit, RunGh, RunnerEscalationConfig } from "./container/in-container-session";
// The `ralph onboard` skill cores: detect the toolchain, scaffold the .ralph/ contract, run the
// smoke-test acceptance gate (ADR-0038, #192). The skill drives these via the `ralph-onboard` bin.
export { detectToolchain, fsRepoFacts } from "./onboard/detect";
export type { TemplateId, RepoFacts, ToolchainDetection, TemplateMatch, DetectionSignal } from "./onboard/detect";
export {
  planScaffold,
  setBaseBranch,
  readTemplateFiles,
  DEST_AGENT_YAML,
  DEST_AGENT_DOCKERFILE,
  DEST_DOCKERIGNORE,
} from "./onboard/scaffold";
export type { TemplateFiles, ScaffoldFile, ScaffoldPlan, ScaffoldOverrides } from "./onboard/scaffold";
export { onboard } from "./onboard/onboard";
export type { OnboardDeps, OnboardOptions, OnboardOutcome, SmokeResult } from "./onboard/onboard";

export { createTranscriptSink, createRunTranscriptSink } from "./executor/transcript-sink";
export type { TranscriptSink, CreateTranscriptSinkParams } from "./executor/transcript-sink";
export { buildImplPrompt, SYSTEM_APPEND } from "./executor/prompts";
export {
  runStructuredSession,
  runStructuredWithBackend,
  extractJsonObject,
  AgentOutputParseError,
} from "./executor/structured-session";
export type { StructuredSessionParams } from "./executor/structured-session";

// ---- providers: the SessionBackend seam + Claude/OpenAI(Codex) backends (issue #131) ----
export type { SessionBackend, SessionRequest } from "./providers/backend";
export { ClaudeSessionBackend } from "./providers/claude-backend";
export type { ClaudeSessionBackendParams } from "./providers/claude-backend";
export { CodexSessionBackend } from "./providers/codex-backend";
export type { CodexClient, CodexRunRequest, CodexSessionBackendParams } from "./providers/codex-backend";
export { SdkCodexClient } from "./providers/codex-client";
export {
  providerForAgentType,
  providerPreferenceList,
  perPhasePreferenceLists,
  allPreferenceLists,
  providerToolsCapable,
  requiresTools,
  capabilityOk,
  PROVIDER_TOOLS_CAPABLE_DEFAULTS,
  AGENT_TYPES,
} from "./providers/select";
export type { AgentType, RoutingPhase, RoutingTier, ProviderSelection } from "./providers/select";
export { tierProfile } from "./providers/select";
export { resolveRoute, resolveEffectiveRouting } from "./providers/resolve";
export type {
  RouteWorld,
  RouteResolution,
  RoutingConfig,
  RoutingSource,
  GlobalRouting,
  RepoRoutingPatch,
} from "./providers/resolve";
// The runtime routing overlay + write-through (ADR-0037 P4.1, issue #166).
export { RoutingStore } from "./config/routing-store";
export type {
  RoutingEdit,
  RoutingEditOutcome,
  RoutingSnapshot,
  RoutingStoreDeps,
} from "./config/routing-store";

// ---- review: CI gate + two-phase loop + rebase-aware merge --------------
export {
  SEVERITIES,
  GATING_SEVERITIES,
  worklistSchema,
  worklistItemSchema,
  parseWorklist,
  isGating,
  gatingItems,
  isClean,
  hasEscalation,
  dedupeWorklist,
} from "./review/worklist";
export type { Severity, Worklist, WorklistItem } from "./review/worklist";
export {
  escalationQuestionSchema,
  escalationQuestionShape,
  parseEscalationQuestion,
  parseRalphQuestionComment,
  formatRalphQuestion,
  buildHealCardQuestion,
  formatHealCard,
  evaluateEscalationBar,
  DESIGN_RESOLVABLE_GUIDANCE,
  REQUIRES_CODE_CONTEXT_GUIDANCE,
  buildPhaseMarker,
  parsePhaseMarker,
  RALPH_QUESTION_FENCE,
} from "./review/escalation";
export type {
  EscalationQuestion,
  HealCardInput,
  EscalationBarVerdict,
  EscalationBarFailure,
  EscalationBarFailureKind,
} from "./review/escalation";
export { RunnerInfraError } from "./review/agents";
export type {
  ReviewAgentRunner,
  ReviewContext,
  FixAgentRunner,
  FixContext,
  FixOutcome,
  ReviewCommentRef,
} from "./review/agents";
// `AgentOutputParseError` is re-exported from ./executor/structured-session (its home).
export {
  formatReviewComment,
  parseReviewComment,
  parseReviewCommentPayload,
  isReviewComment,
  latestReviewComment,
  RALPH_REVIEW_FENCE,
} from "./review/review-comment";
export type { ReviewCommentData } from "./review/review-comment";
export { ReviewLoop } from "./review/review-loop";
export type {
  ReviewLoopDeps,
  ReviewLoopContext,
  ReviewLoopOutcome,
  MergeConfig,
} from "./review/review-loop";
export { reviewWithBackend, fixWithBackend, fixOutcomeSchema } from "./review/structured";
export {
  CI_GATE,
  MERGE,
  MERGE_CONFLICT,
  reviewPhase,
  fixPhase,
  phaseLabel,
  decodeAgentPhase,
  reviewPhaseNumber,
} from "./review/phase";
export type { AgentPhase } from "./review/phase";
export {
  buildReviewPrompt,
  buildFixPrompt,
  buildHealGuidance,
  REVIEW_SYSTEM_APPEND,
} from "./review/prompts";

export type { ResumeInjection } from "./executor/prompts";
export { buildResumePrompt } from "./executor/prompts";
export {
  createEscalateTool,
  createEscalateServer,
  ESCALATE_TOOL,
  ESCALATE_SERVER,
  ESCALATE_DESCRIPTION,
} from "./executor/escalate-tool";
export type { ResumeRun } from "./executor/executor";

// ---- human-in-the-loop: escalate / answer / resume ----------------------
export {
  LABEL_AWAITING_ANSWER,
  LABEL_REVIEW_MAXED,
  AWAITING_LABELS,
  ANSWERABLE_LABELS,
  consequenceForAnswerableLabel,
  isAwaitingAnswerLabel,
} from "./hitl/labels";
export type { AnswerableLabel, AnswerConsequence, AwaitingAnswerLabel } from "./hitl/labels";
export { findStuckHealGuidance } from "./hitl/heal-readmit";
export type { StuckHealGuidance } from "./hitl/heal-readmit";
export {
  RALPH_ANSWER_FENCE,
  resolveAnswer,
  resolveStructuredAnswer,
  formatRalphAnswer,
  parseRalphAnswer,
  isRalphAnswerComment,
  isRalphQuestionComment,
} from "./hitl/answer";
export type { RalphAnswer, AnswerKind, StructuredAnswerChoice, StructuredAnswerResolution } from "./hitl/answer";
export { recordEscalation, EscalationCheckpointer } from "./hitl/escalation-checkpoint";
export type {
  RecordEscalationInput,
  CheckpointContext,
  EscalationCheckpointerDeps,
} from "./hitl/escalation-checkpoint";
export { listOpenQuestions } from "./hitl/queue";
export type { OpenQuestionItem } from "./hitl/queue";
export { RalphAnswerService } from "./hitl/ralph-answer";
export type { AnswerPrompter } from "./hitl/ralph-answer";
export { renderQuestion } from "./hitl/render";
export { findResumableRuns, scanPausedRuns } from "./hitl/resume";
export type { ResumableRun, StrandedAnsweredRun, PausedRunScan } from "./hitl/resume";

// ---- runtime projection: the pure snapshot the web read API consumes -----
// The Ink TUI is retired (issue #120); only the read-only projection it shared
// with the web control plane remains (ADR-0029).
export { buildSnapshot, OUTCOME_EVENTS } from "./projection/snapshot";
export type {
  RuntimeSnapshot,
  RuntimeBacklog,
  AgentView,
  QueueItem,
  OutcomeView,
  SnapshotOptions,
  DaemonHealthView,
} from "./projection/snapshot";

// ---- daemon: per-repo reconcilers + the multi-repo orchestrator -------------
export { Reconciler, DEFAULT_MAX_RUN_LIFETIME_MS, DEFAULT_MAX_CLAIM_FAILURES } from "./daemon/reconciler";
export type { ReconcilerDeps, ReconcileBudget } from "./daemon/reconciler";
export { UsageMeter, ProviderPoolMeter } from "./daemon/usage-meter";
export type { ProviderPoolMeterOptions, ProviderPoolSnapshot } from "./daemon/usage-meter";
export { Orchestrator } from "./daemon/orchestrator";
export type { DaemonControl } from "./daemon/control";
export type {
  OrchestratorDeps,
  RunAbortPort,
  SelfUpdateDeps,
  DrainOutcome,
  DrainKind,
  DaemonRunOutcome,
  RunForeverOptions,
} from "./daemon/orchestrator";
export {
  GitUpdateChecker,
  RESTART_EXIT_CODE,
  QUARANTINE_RELATIVE_PATH,
} from "./daemon/self-update";
export type { UpdateChecker, UpdateStatus, GitUpdateCheckerOptions } from "./daemon/self-update";
export {
  classifyIssueState,
  isNonTerminalStatus,
  isSpanClosed,
  LABEL_DAEMON_ANOMALY,
} from "./daemon/completeness";
export type {
  Classification,
  IssueClass,
  IssueSnapshot,
  AnomalyReason,
} from "./daemon/completeness";
export { projectBacklog } from "./daemon/backlog";
export {
  createOrchestrator,
  runDaemon,
  startNotificationSink,
  resolveWebPushIdentity,
} from "./daemon/daemon";
export type { AssembledDaemon, DaemonDeps, ShutdownSignals, NotificationSinkHandle } from "./daemon/daemon";

// ---- web control plane: embedded server + browser-safe contract (ADR-0029/0031/0032) ----
export { startWebControlPlane, createWebPorts } from "./web/control-plane";
export type { WebControlPlaneHandle, StartWebControlPlaneDeps, UsageSnapshotReader } from "./web/control-plane";
export { snapshotToOverview, activitySummary } from "./web/overview";
export type { SnapshotToOverviewOptions } from "./web/overview";
export { computeAnalytics, analyticsWindowStart } from "./web/analytics";
export type { ComputeAnalyticsInput, RunStart } from "./web/analytics";
export { buildHealthUsage } from "./web/health-usage";
export type { BuildHealthUsageOptions, UsageMeterSnapshot, AnomalyLogRow } from "./web/health-usage";
export { snapshotToBacklog } from "./web/backlog";
export type { SnapshotToBacklogOptions } from "./web/backlog";
export {
  toEscalationQuestionWire,
  toInboxCard,
  toInboxResponse,
} from "./web/inbox";
export type { InboxEntry, AnswerPortResult, EscalationQuestionWireDriftGuard } from "./web/inbox";
export { planPowerAction } from "./web/power-actions";
export type { PowerActionPlan, PowerActionPortResult } from "./web/power-actions";
export { getEffectiveRouting, executeRoutingEdit } from "./web/routing-actions";
export type { RoutingControlPort, RoutingActionDeps, RoutingEditPortResult } from "./web/routing-actions";
export { WebServer, allowAllAuth, isOriginAllowed, isSafeMethod, safeResolve, serveStatic, contentTypeFor, handleLiveSse } from "./web/server";
export type {
  WebServerDeps,
  WebControlPlanePorts,
  OverviewQuery,
  AnalyticsQuery,
  BacklogQuery,
  InboxQuery,
  RoutingQuery,
  AuthMiddleware,
  AuthVerdict,
  OriginCheckContext,
} from "./web/server";
export {
  API_BASE,
  API_ROUTES,
  healthResponseSchema,
  daemonHealthSchema,
  anomalyItemSchema,
  usageWindowSchema,
  usageLoginSchema,
  usageSummarySchema,
  healthUsageResponseSchema,
  NEEDS_YOU_STATES,
  needsYouStateSchema,
  needsYouItemSchema,
  fleetAgentSchema,
  pipelineFunnelSchema,
  activityItemSchema,
  overviewResponseSchema,
  liveEventSchema,
  isTranscriptStreamId,
  parseTranscriptStreamRef,
  classifyLiveEvent,
  transcriptLatestLine,
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
  BACKLOG_PAUSED_STATES,
  backlogPausedStateSchema,
  backlogPriorityColorSchema,
  backlogEligibleItemSchema,
  backlogBlockerSchema,
  backlogBlockedItemSchema,
  backlogPausedItemSchema,
  backlogManualHoldItemSchema,
  backlogModingCandidateItemSchema,
  backlogResponseSchema,
  INBOX_ATTENTION_LABELS,
  INBOX_CONSEQUENCES,
  ANSWER_KINDS,
  inboxAttentionLabelSchema,
  inboxConsequenceSchema,
  escalationQuestionWireSchema,
  inboxCardSchema,
  inboxResponseSchema,
  answerKindSchema,
  answerRequestBodySchema,
  answerResponseSchema,
  powerActionKindSchema,
  powerActionModeSchema,
  powerActionSurfaceSchema,
  powerActionAffordanceSchema,
  powerActionCatalogSchema,
  powerActionRequestBodySchema,
  powerActionResponseSchema,
  ROUTING_PROVIDERS,
  ROUTING_AGENT_TYPES,
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
  drainRequestBodySchema,
  drainResponseSchema,
  forceTickRequestBodySchema,
  forceTickResponseSchema,
  killRunRequestBodySchema,
  killRunResponseSchema,
  routeSchema,
  providerName,
} from "./web/contract";
export type {
  ApiRoute,
  Route,
  ProviderNameWire,
  HealthResponse,
  DaemonHealth,
  AnomalyItem,
  UsageWindow,
  UsageLogin,
  UsageSummary,
  HealthUsageResponse,
  NeedsYouState,
  NeedsYouItem,
  FleetAgent,
  PipelineFunnel,
  ActivityItem,
  OverviewResponse,
  LiveEvent,
  ClassifiedLiveEvent,
  TranscriptLiveEvent,
  DomainLiveEvent,
  LiveLine,
  LiveLineKind,
  AnalyticsDailyPoint,
  DistributionBucket,
  AnalyticsDistributions,
  AnalyticsSummary,
  AnalyticsResponse,
  BacklogPausedStateWire,
  BacklogPriorityColorWire,
  BacklogEligibleItem,
  BacklogBlocker,
  BacklogBlockedItem,
  BacklogPausedItem,
  BacklogManualHoldItem,
  BacklogModingCandidateItem,
  BacklogResponse,
  InboxAttentionLabelWire,
  InboxConsequenceWire,
  EscalationQuestionWire,
  InboxCard,
  InboxResponse,
  AnswerKindWire,
  AnswerRequestBody,
  AnswerResponse,
  PowerActionKindWire,
  PowerActionModeWire,
  PowerActionSurfaceWire,
  PowerActionAffordanceWire,
  PowerActionCatalogWire,
  PowerActionRequestBody,
  PowerActionResponse,
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
  DrainRequestBody,
  DrainResponse,
  ForceTickRequestBody,
  ForceTickResponse,
  KillRunRequestBody,
  KillRunResponse,
} from "./web/contract";

// ---- out-of-app notification sink: ntfy / webhook (issue #117) -----------
export { decideNotifications } from "./notify/decide";
export { formatNtfyDispatch, formatWebhookDispatch, severityToNtfyPriority } from "./notify/format";
export type { HttpDispatch } from "./notify/format";
export { NotificationDispatcher } from "./notify/dispatch";
export type { NotificationDispatcherDeps, FetchPort, FetchInit } from "./notify/dispatch";
export {
  WebPushDispatcher,
  resolveVapidIdentity,
  toWebPushPayload,
} from "./notify/webpush";
export type {
  VapidIdentity,
  WebPushSubscription,
  WebPushDispatcherDeps,
  WebPushFetchPort,
  WebPushFetchInit,
  WebPushPayload,
} from "./notify/webpush";
export { CompositeNotificationDispatcher, NotificationSink } from "./notify/sink";
export type { NotificationSinkDeps, StallProbe, NotificationDispatchPort } from "./notify/sink";
export type { NotificationKind, NotificationSeverity, NotificationRequest } from "./notify/types";
export type { NotificationSettings, NotificationEndpoint, NotificationEndpointKind, WebPushSettings } from "./config/schema";
