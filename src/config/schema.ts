// zod v4 (peer-required by @anthropic-ai/claude-agent-sdk). Object-level optional
// blocks use .prefault({}) — v4's input-side default that is parsed so nested
// field defaults apply (v4's .default() validates the output type and skips them).
import { z } from "zod";

/** `owner/repo` slug, e.g. `acme/example-monorepo`. */
const repoSlug = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "must be an 'owner/repo' slug, e.g. acme/example-monorepo",
  );

const nonEmpty = z.string().min(1, "must not be empty");

const effortEnum = z.enum(["low", "medium", "high", "xhigh", "max"]);
const mergeMethodEnum = z.enum(["squash", "merge", "rebase"]);
/**
 * The LLM provider backing an agent session (issue #131, ADR-0033). `claude` is the
 * Claude Agent SDK (the default, byte-for-byte the pre-#131 behaviour); `openai` is
 * the Codex SDK on a ChatGPT-subscription OAuth login (OAuth only — never an API key,
 * amending ADR-0008's letter while honouring its spirit). `zai` is z.ai/GLM behind an
 * Anthropic-compatible endpoint (issue #149, ADR-0034): it rides the *Claude* SDK path
 * via env injection (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`), not a new SDK — and,
 * deliberately, is the first provider authenticated by an **API key** (z.ai has no OAuth
 * login), read from an env var at runtime and never stored in config (ADR-0034).
 */
/**
 * The known LLM provider kinds (ADR-0037), as a runtime list — the single source the config
 * enum is built from and the read-model route parser validates against ({@link isProviderName}).
 * Exported (not just the list) so #228's wire protocol can reuse the same enum.
 */
export const PROVIDER_NAMES = ["claude", "openai", "zai"] as const;
export const providerEnum = z.enum(PROVIDER_NAMES);
/**
 * Which Claude setting layers an agent session loads (ADR-0019). `project` reads
 * the TARGET repo's `CLAUDE.md` + `.claude/` relative to the worktree `cwd`, so a
 * run honours that repo's own conventions. `user` is deliberately *off* by default
 * so the operator's personal settings + auto-memory never leak into a run (the
 * no-memory-leak intent of ADR-0008 is preserved per target).
 */
const settingSourceEnum = z.enum(["user", "project", "local"]);

// ---- per-block settings -------------------------------------------------
// Each block exists twice: a GLOBAL schema (fully defaulted — the daemon-wide
// default) and an OVERRIDE schema (all-optional, no defaults — a per-target patch
// deep-merged over the global in config/load.ts). zod cannot express "fall back to
// another field's value", so the merge is done after parsing; keeping defaults out
// of the override schema is what makes an unset target field mean "inherit".

/**
 * A per-agent-type provider/model override (issue #131) — the **legacy single-provider
 * form**, kept for back-compat (ADR-0037 P1.2). `provider` selects which backend runs
 * that agent type; `model` overrides the provider's default model for it (the Claude
 * default is `agent.model`, the OpenAI default is `providers.openai.model`). Both
 * optional — an unset key inherits the global `agent.provider` / provider default. A
 * single object here normalises to a **one-entry preference list** (see
 * {@link agentTypeRoutingSchema}); the array form is the general preference list.
 */
const agentTypeOverrideSchema = z
  .object({
    provider: providerEnum.optional(),
    model: nonEmpty.optional(),
  })
  .strict();

/**
 * One entry of an ordered **`(provider, model)` preference list** (ADR-0037 P1.2). Unlike
 * the legacy single form, an entry names its `provider` explicitly (a list is a ranking of
 * providers, so each rung must say which one); `model` is the optional per-type model for
 * *that* provider — model ids are not portable across providers (`opus` is Claude-only,
 * `glm-5.2` z.ai-only, `gpt-5.5` Codex-only), so the model travels with the entry, never
 * the account. Absent `model` → the provider's default model.
 */
const agentTypeEntrySchema = z
  .object({
    provider: providerEnum,
    model: nonEmpty.optional(),
  })
  .strict();

/**
 * A type's routing (ADR-0037 P1.2): either the **legacy single** {@link agentTypeOverrideSchema}
 * (normalised to a one-entry list) or an **ordered preference list** of
 * {@link agentTypeEntrySchema} entries (preference order, first-qualifying wins at route
 * resolution — a later slice). At least one entry is required; an empty list is a config
 * error. Normalisation to the ordered list lives in `providers/select.ts`
 * (`providerPreferenceList`), so load + wiring read one shape.
 */
const agentTypeRoutingSchema = z.union([
  agentTypeOverrideSchema,
  z.array(agentTypeEntrySchema).min(1, "preference list must have at least one entry"),
]);

/**
 * The **per-phase** routing form for `review`/`fix` (ADR-0037 #169): a `base` list that applies
 * to every phase with no override, plus optional `phase1` (normal review/fix) and `phase2`
 * (behaviour-preserving thermo) overrides — the numbered Phase-1/Phase-2 vocabulary (CONTEXT.md);
 * Phase 0 is the CI gate (no agent, no key) and resolves to `base`. Each value is itself an
 * {@link agentTypeRoutingSchema} (legacy single or ordered list). `base` is **required**: a
 * `phaseN`-only config would strand the other phase at permanent `no-provider`, so its absence is
 * a load-time error. The merge is **whole-list replacement per phase** — `effectiveList(phase) =
 * perPhase[phase] ?? base` — done in `providers/select.ts` (`providerPreferenceList(agent, type,
 * phase)`), so a per-phase list **replaces** the base for that phase (not concatenation). The
 * keys are `.strict()`, so a `phase3` typo / a per-phase key on a single-phase type fails loud.
 */
const phasedAgentTypeRoutingSchema = z
  .object({
    base: agentTypeRoutingSchema,
    phase1: agentTypeRoutingSchema.optional(),
    phase2: agentTypeRoutingSchema.optional(),
  })
  .strict();

/**
 * A `review`/`fix` type's routing (ADR-0037 #169): **either** the {@link agentTypeRoutingSchema}
 * list/legacy form (= `base`, applies to all phases — back-compat) **or** the per-phase
 * {@link phasedAgentTypeRoutingSchema} object form. `impl`/`autoMode` are single-phase, so they
 * keep the plain {@link agentTypeRoutingSchema} (a per-phase key there fails loud via `.strict()`).
 */
const reviewFixRoutingSchema = z.union([agentTypeRoutingSchema, phasedAgentTypeRoutingSchema]);

/**
 * Per-agent-type routing keyed by the four configurable session types (issue #131):
 * `impl` (the full agentic runner), `review` + `fix` (the structured review loop,
 * including Phase-2 thermo), and `autoMode` (the moding classifier). Each value is optional;
 * an absent key means "use the global default".
 *
 * `impl`/`autoMode` are single-phase, so they take a plain {@link agentTypeRoutingSchema} — a
 * legacy single `{provider?, model?}` or an ordered `(provider, model)` preference list. `review`/
 * `fix` additionally accept the per-phase {@link phasedAgentTypeRoutingSchema} object form (`base`
 * + optional `phase1`/`phase2`), so normal review can route to a cheap provider while the Phase-2
 * thermo pass bumps to a stronger one (ADR-0037 #169 — per-phase routing key). The keys are
 * `.strict()`: a `mode:*` typo, an unknown phase key, or a per-phase object on impl/autoMode all
 * fail loud at load.
 */
const agentTypesSchema = z
  .object({
    impl: agentTypeRoutingSchema.optional(),
    review: reviewFixRoutingSchema.optional(),
    fix: reviewFixRoutingSchema.optional(),
    autoMode: agentTypeRoutingSchema.optional(),
  })
  .strict();

/**
 * One complexity tier's **agent profile** (issue #278): what an impl run labeled with that
 * tier runs on. A tier is a profile, not just a route — `routes` replaces the impl
 * `(provider, model)` preference list **whole-list** (the ADR-0037 #169 per-phase merge
 * semantics), while `effort` / `wallClockSeconds` override the matching `agent.*` globals
 * for the run's session. Every field optional: an absent field inherits the global, so a
 * tier can e.g. re-route without touching the wall-clock. Impl-only by design — review/fix
 * routing and budgets are untouched (the review loop is what makes unattended merge safe,
 * ADR-0014).
 */
const tierProfileSchema = z
  .object({
    /** Whole-list replacement of the impl preference list for this tier (absent → `types.impl`). */
    routes: z.array(agentTypeEntrySchema).min(1, "tier routes must have at least one entry").optional(),
    /** Per-tier reasoning effort (absent → the global `agent.effort`). */
    effort: effortEnum.optional(),
    /** Per-tier wall-clock ceiling (absent → the global `agent.wallClockSeconds`). */
    wallClockSeconds: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The per-tier agent profiles, keyed by the `complexity:1|2|3` label's tier (issue #278) —
 * lower = more demanding, following the `priority:p0` convention. `.strict()`, so a `"4"`
 * or a typo fails loud at load. An issue with no `complexity:*` label uses no profile at
 * all (the globals) — the tier is deliberately NOT part of the eligibility gate, so an
 * absent label is never an admission stall.
 */
const agentTiersSchema = z
  .object({
    "1": tierProfileSchema.optional(),
    "2": tierProfileSchema.optional(),
    "3": tierProfileSchema.optional(),
  })
  .strict();

/**
 * One config-owned stdio MCP server definition (issue #264). The daemon stopped depending on the
 * operator's mutable `~/.claude.json` for the curated set: that file is never mounted into run
 * containers, and its definitions are project-scoped to operator paths anyway. Definitions living
 * in the daemon config travel into every container for free — the config is already bind-mounted
 * `:ro` and re-read by the in-container runner.
 *
 * `args` and `env` values may carry the literal `${workspace}` token; it is substituted with the
 * session's working tree (the per-run clone in containers) when the session is built, so servers
 * that need an explicit project root get the right one per run. `env` values are literals — the
 * config file is operator-local and gitignored, and is the one place the daemon already treats as
 * box-private; keys placed here are visible to the agent, which is inherent (the agent's own MCP
 * server consumes them).
 */
const mcpServerDefSchema = z
  .object({
    /** The stdio launcher binary (`uvx`, `npx`, …) — must exist in the agent image/box. */
    command: nonEmpty,
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const agentGlobalSchema = z
  .object({
    /** Hard wall-clock ceiling per agent; daemon kills on overrun. */
    wallClockSeconds: z.number().int().positive().default(3600),
    /**
     * Cadence (seconds) of the impl-session heartbeat written to the run log,
     * so the web control plane shows live progress during the long impl phase
     * rather than a static row with no log lines until `agent.result` (#42).
     */
    heartbeatSeconds: z.number().int().positive().default(30),
    /**
     * Model for every agent session (impl, review, fix). SDK alias or full
     * id. Default `opus` — quality over cost, since the box is OAuth-only and
     * the thermo review + hard refactors benefit from the strongest model.
     */
    model: nonEmpty.default("opus"),
    /**
     * Reasoning effort guiding adaptive-thinking depth on every agent session.
     * `xhigh` = deeper than high (Opus 4.7+); falls back to `high` elsewhere.
     */
    effort: effortEnum.default("xhigh"),
    /** Curated MCP set handed to each agent (never `memory`). */
    mcpServers: z
      .array(nonEmpty)
      .default(["codebase-memory", "morph-mcp", "context7"]),
    /**
     * Config-owned MCP server definitions the curated {@link mcpServers} names resolve against,
     * taking precedence over the box `~/.claude.json` (issue #264 — the only source that reaches
     * in-container sessions). Empty by default: names with no definition anywhere are skipped, as
     * before.
     */
    mcpServerDefs: z.record(nonEmpty, mcpServerDefSchema).default({}),
    /**
     * Claude setting layers loaded per session (ADR-0019). Default `["project"]`:
     * honour the target repo's CLAUDE.md/.claude, never the operator's `user`
     * layer. `AGENTS.md` is injected separately by the harness (the SDK does not
     * auto-load it).
     */
    settingSources: z.array(settingSourceEnum).default(["project"]),
    /**
     * The default LLM provider for every agent type (issue #131, ADR-0033). `claude`
     * keeps the daemon byte-for-byte unchanged; a per-type {@link agentTypesSchema}
     * override can route specific types (e.g. `review`/`fix`) to `openai` instead.
     */
    provider: providerEnum.default("claude"),
    /**
     * Per-agent-type routing (issue #131; ADR-0037 P1.2). Empty by default → every type
     * runs on `provider`. Each type takes a legacy single `{provider?, model?}` or an
     * ordered `(provider, model)` preference list. The capability gate (ADR-0037) is
     * enforced at load: `impl` requires in-session tools, so it routes only to a
     * tools-capable provider (`claude`/`zai`, not bare `openai`); `review`/`fix`/`autoMode`
     * are capability-open. Use it to put `review`/`fix` on `openai` while `impl` stays on
     * Claude/z.ai.
     */
    types: agentTypesSchema.prefault({}),
    /**
     * Per-complexity-tier agent profiles (issue #278), selected by an issue's
     * `complexity:1|2|3` label at impl dispatch. Empty by default → every issue runs on
     * the globals. Impl-only; per-target overridable like every agent field (a target's
     * `tiers` replaces the whole block, the spread-merge array/object convention).
     */
    tiers: agentTiersSchema.prefault({}),
  })
  .strict();

const agentOverrideSchema = z
  .object({
    wallClockSeconds: z.number().int().positive().optional(),
    heartbeatSeconds: z.number().int().positive().optional(),
    model: nonEmpty.optional(),
    effort: effortEnum.optional(),
    mcpServers: z.array(nonEmpty).optional(),
    mcpServerDefs: z.record(nonEmpty, mcpServerDefSchema).optional(),
    settingSources: z.array(settingSourceEnum).optional(),
    provider: providerEnum.optional(),
    types: agentTypesSchema.optional(),
    tiers: agentTiersSchema.optional(),
  })
  .strict();

/** Harness-owned, CI-gated, rebase-aware merge (ADR-0014, issue #41). */
const mergeGlobalSchema = z
  .object({
    /** Merge strategy passed to `gh pr merge`. */
    method: mergeMethodEnum.default("squash"),
    /**
     * Await CI green before review (Phase 0) and again before merge. On a repo
     * with no checks this is a no-op (merges immediately). Set false to skip
     * the CI gate entirely.
     */
    waitForChecks: z.boolean().default(true),
    /** Minutes to wait for CI to reach a terminal state before giving up. */
    ciTimeoutMinutes: z.number().int().positive().default(30),
    /** Seconds between `gh pr checks` polls while awaiting CI. */
    pollIntervalSeconds: z.number().int().positive().default(30),
    /** Delete the head branch after a successful merge. */
    deleteBranch: z.boolean().default(true),
  })
  .strict();

const mergeOverrideSchema = z
  .object({
    method: mergeMethodEnum.optional(),
    waitForChecks: z.boolean().optional(),
    ciTimeoutMinutes: z.number().int().positive().optional(),
    pollIntervalSeconds: z.number().int().positive().optional(),
    deleteBranch: z.boolean().optional(),
  })
  .strict();

const reviewGlobalSchema = z
  .object({
    /** Fix attempts allowed per review phase before review-maxed. */
    maxFixAttempts: z.number().int().positive().default(3),
    /**
     * Bounded daemon-side re-dispatches when a review/fix container produces NO result because of an
     * infra fault (a dropped pipe / killed / un-started container, issue #220) — counted separately
     * from `maxFixAttempts`, so a transient `docker run` hiccup self-heals instead of maxing the
     * phase out. `0` disables retry (terminalize on the first no-result).
     */
    maxContainerRetries: z.number().int().nonnegative().default(2),
  })
  .strict();

const reviewOverrideSchema = z
  .object({
    maxFixAttempts: z.number().int().positive().optional(),
    maxContainerRetries: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Auto-mode (CONTEXT: moding pass). An opt-in, per-target pass that classifies the
 * OPEN issues the eligibility gate rejects *solely* because they lack a `mode:*`
 * label and applies the missing label, so a backlog whose triage doesn't stamp modes
 * stops stalling. Off by default — when off the pass is an exact no-op (no SDK call,
 * no label write). The tdd-vs-infra rubric stays harness-owned (ADR-0012); this only
 * toggles whether the daemon supplies the one missing label.
 */
const autoModeGlobalSchema = z
  .object({
    /** Master switch. Off by default (opt-in per target). */
    enabled: z.boolean().default(false),
    /**
     * Maximum issues classified per tick (a small default so a large unmoded backlog
     * can't stampede the SDK or the plan budget — the rest wait for later ticks).
     */
    maxPerTick: z.number().int().positive().default(3),
    /**
     * Model for the classification session. Defaults to the target's `agent.model`
     * when unset; override to a cheaper/faster model since triage is a short call.
     */
    model: nonEmpty.optional(),
  })
  .strict();

const autoModeOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxPerTick: z.number().int().positive().optional(),
    model: nonEmpty.optional(),
  })
  .strict();

/**
 * Provider-KIND settings for OpenAI (Codex) (issue #131, ADR-0033; credential split
 * ADR-0037 P2.2). This block now carries only the **kind** surface — `model`, `baseUrl`,
 * `toolsCapable` — never a credential authority: the `CODEX_HOME` credential lives in the
 * **account pool** ({@link accountSchema}). `codexHome` is kept here as an **optional
 * back-compat single-account slice** — present → it folds into the pool as one
 * `{ provider: openai, codexHome }` account (via {@link resolveAccountPool}), exactly
 * mirroring how `usageLimit.subscriptions` folds in the Claude slice; a multi-account
 * setup instead lists explicit `accounts: [{ provider: openai, ... }]` and omits it here.
 */
const openaiProviderSchema = z
  .object({
    /**
     * Optional **back-compat** `CODEX_HOME` dir with the ChatGPT-subscription `auth.json`
     * (never an API key). Present → folds into the account pool as the single openai
     * account; omit it and define explicit `accounts:` entries for N Codex logins (ADR-0037).
     */
    codexHome: nonEmpty.optional(),
    /**
     * Default model for OpenAI-provider sessions; a per-type `model` overrides it. Default
     * `gpt-5.5` (plain): under ADR-0033's OAuth-only stance the login is a ChatGPT
     * subscription, which serves plain `gpt-5.x` ids and 400s every `-codex`-suffixed id
     * ("not supported when using Codex with a ChatGPT account" — those are API-tier). See
     * issue #138.
     */
    model: nonEmpty.default("gpt-5.5"),
    /** Optional OpenAI-compatible gateway base URL. */
    baseUrl: nonEmpty.optional(),
    /**
     * Provider-KIND **in-session host-callback tools** capability (ADR-0037 capability
     * gate): whether an agent on this provider can invoke `escalate`/`stuck` mid-session.
     * Bare Codex is **not** tools-capable yet (the derived default is `false`); the flag
     * is a self-clearing maturity switch — flip it once those tools are re-hosted as an
     * out-of-process MCP server. Optional: absent → the derived default
     * ({@link PROVIDER_TOOLS_CAPABLE_DEFAULTS}). A proxy-backed Codex declares its own.
     */
    toolsCapable: z.boolean().optional(),
  })
  .strict();

/**
 * Settings for the z.ai (GLM) provider (issue #149, ADR-0034). z.ai serves GLM models
 * behind an **Anthropic-compatible** endpoint, so a session rides the *Claude* SDK path
 * (env injection of `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) rather than a new SDK.
 *
 * Unlike `claude`/`openai` (OAuth on disk), z.ai has no OAuth login: it authenticates
 * with a Bearer **API key** — the first such credential on the box (ADR-0034 amends
 * ADR-0008/0033). To keep the key out of `.ralph/config.yaml` and the log redactor's
 * path, the credential is the env-var NAME (`authTokenEnv`), never the key itself.
 *
 * Credential split (ADR-0037 P2.2): this block is the **kind** surface — `baseUrl`,
 * `model`, `toolsCapable`. `authTokenEnv` is kept here as an **optional back-compat
 * single-account slice** — present → it folds into the account pool as one
 * `{ provider: zai, authTokenEnv }` account; a multi-account setup instead lists explicit
 * `accounts: [{ provider: zai, ... }]` (4 z.ai keys) and omits it here.
 */
const zaiProviderSchema = z
  .object({
    /** Anthropic-compatible base URL for z.ai. */
    baseUrl: nonEmpty.default("https://api.z.ai/api/anthropic"),
    /**
     * Optional **back-compat** NAME of the env var holding the z.ai API key — NOT the key
     * itself (ADR-0034). Present → folds into the account pool as the single zai account;
     * omit it and define explicit `accounts:` entries for N z.ai keys (ADR-0037).
     */
    authTokenEnv: nonEmpty.optional(),
    /**
     * Default GLM model for z.ai sessions; a per-type `model` overrides it. Default
     * `glm-5.2` (GLM-5.2, tuned for Claude-Code-style agentic loops). The 1M-context
     * variant is `glm-5.2[1m]` — see `.ralph/config.example.yaml`.
     */
    model: nonEmpty.default("glm-5.2"),
    /**
     * Provider-KIND **in-session host-callback tools** capability (ADR-0037 capability
     * gate). z.ai rides the Claude SDK path, so it IS tools-capable (the derived default
     * is `true`); this override exists for symmetry / a future fidelity-gated proxy.
     * Optional: absent → the derived default ({@link PROVIDER_TOOLS_CAPABLE_DEFAULTS}).
     */
    toolsCapable: z.boolean().optional(),
  })
  .strict();

/**
 * Provider-KIND settings for `claude` (ADR-0037). Claude is always available — the
 * box-default login(s) — and carries no connection/credential detail here; those live in
 * the **account pool** ({@link accountSchema}). This block is purely the provider-kind
 * surface, so in v1 it holds only the `toolsCapable` override (default `true`). Optional
 * and unknown-key-strict: omit it entirely to keep the derived default.
 */
const claudeProviderSchema = z
  .object({
    /**
     * Override the provider-KIND in-session-tools capability (ADR-0037). Claude is
     * tools-capable by default (`true`); set `false` only to deliberately bar impl from
     * the Claude path. Absent → the derived default ({@link PROVIDER_TOOLS_CAPABLE_DEFAULTS}).
     */
    toolsCapable: z.boolean().optional(),
  })
  .strict();

/**
 * One notification delivery endpoint (issue #117). `ntfy` POSTs the message text as the
 * body with `Title`/`Priority`/`Tags` headers (the ntfy.sh protocol); `webhook` POSTs a
 * JSON payload (`{kind,severity,title,message,repo,issue,at}`). An optional `tokenEnv`
 * names an env var holding a bearer token sent as `Authorization: Bearer <token>` — the
 * env-var NAME, never the secret itself (the ADR-0034 precedent: config never carries a
 * credential the log redactor would have to know about).
 */
const notificationEndpointKindEnum = z.enum(["ntfy", "webhook"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isValidVapidSubject(value: string): boolean {
  if (value.trim() !== value || /\s/.test(value)) {
    return false;
  }
  const url = parseUrl(value);
  if (url === null) {
    return false;
  }
  if (url.protocol === "https:") {
    return url.hostname.length > 0 && url.username === "" && url.password === "";
  }
  if (url.protocol === "mailto:") {
    const recipient = url.pathname;
    return (
      recipient.length > 0 &&
      recipient.includes("@") &&
      !recipient.startsWith("@") &&
      !recipient.endsWith("@")
    );
  }
  return false;
}

const notificationEndpointSchema = z
  .object({
    /** Delivery protocol: `ntfy` (ntfy.sh) or `webhook` (generic JSON POST). */
    kind: notificationEndpointKindEnum,
    /** The fully-qualified URL to POST to (a ntfy topic URL or a webhook receiver). */
    url: z
      .string()
      .url("must be a fully-qualified URL, e.g. https://ntfy.sh/my-topic")
      .refine((value) => {
        const protocol = parseUrl(value)?.protocol;
        return protocol === "http:" || protocol === "https:";
      }, "must use http:// or https://")
      .refine((value) => {
        const url = parseUrl(value);
        return url === null || (url.username === "" && url.password === "");
      }, "must not include username or password; use tokenEnv for credentials"),
    /**
     * NAME of an env var holding a bearer token sent as `Authorization: Bearer <token>`
     * (works for ntfy access-control and most webhook receivers). Omit for an open topic.
     */
    tokenEnv: nonEmpty.optional(),
  })
  .strict();

/**
 * Web Push delivery for the notification sink (issue #119): the installable-PWA's native
 * phone/desktop push channel. It is another delivery target for the same escalation /
 * anomaly / stall events the sink already fans out to ntfy/webhook, so it reuses the
 * notification-sink decision verbatim and never touches the reconcile tick. Subscriptions
 * are registered from the PWA UI and persisted in SQLite; the VAPID keypair identifies the
 * daemon to the browser push services.
 *
 * The private key is a credential, so — following the ADR-0034 precedent — this block
 * carries only the **NAME** of the env var holding it (`privateKeyEnv`), never the key
 * itself. The public key is derived from the private one and served to the browser via
 * `/api/webpush/vapid` so it can subscribe. `subject` is the contact URI the push services
 * reach you at on abuse (VAPID `sub`). Off by default — push payloads transit a third-party
 * push service, so like the other notification endpoints it is strictly opt-in. Requires
 * `notifications.enabled: true` (the sink must run for the channel to receive events);
 * `notifications.endpoints: []` is a valid "push-only" configuration.
 */
const notificationWebPushSchema = z
  .object({
    /** Master switch. Off by default (opt-in — push payloads leave the box via a push service). */
    enabled: z.boolean().default(false),
    /**
     * Contact URI for the push services (the VAPID `sub` claim). A `mailto:` address is the
     * norm; an HTTPS URL is also accepted. Required when enabled (the push services reject a
     * VAPID JWT that omits `sub`).
     */
    subject: z.string().optional(),
    /**
     * NAME of the env var holding the VAPID private key — a base64url-encoded 32-octet P-256
     * scalar (the raw private exponent), NOT the key itself (ADR-0034). Generate one with
     * `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, export
     * it, and the matching public key is derived and served to the browser. Required when enabled.
     */
    privateKeyEnv: nonEmpty.optional(),
  })
  .strict();

/**
 * Top-level provider settings block (issue #131; extended ADR-0037). Holds the per-provider
 * *kind* settings that are NOT per-agent-type and NOT credentials: connection details
 * (`openai` Codex, `zai` GLM) plus the provider-kind `toolsCapable` flag (all three,
 * `claude` included). For `openai`/`zai`, absent → that provider is unconfigured (selecting
 * it anywhere then fails loud at load); `claude` is always available, so its block is purely
 * the optional `toolsCapable` override (credentials live in the account pool, not here).
 */
const providersSchema = z
  .object({
    claude: claudeProviderSchema.optional(),
    openai: openaiProviderSchema.optional(),
    zai: zaiProviderSchema.optional(),
  })
  .strict();

/**
 * One ACCOUNT in the pool (ADR-0037): a single credential — the unit of the pool — shaped
 * `{ id, provider, <auth> }` and **model-free** (the model travels with a route entry, not
 * the account, so one credential serves many models). Auth is provider-shaped, so the
 * account is a **discriminated union** on `provider`: `configDir` for `claude` (the
 * `CLAUDE_CONFIG_DIR` store `claude login` wrote), `codexHome` for `openai` (the
 * `CODEX_HOME` dir with the ChatGPT-subscription `auth.json`), `authTokenEnv` for `zai`
 * (the NAME of the env var holding the API key — never the key itself, ADR-0034). The pool
 * is flat and arbitrary: N per provider, including zero. `usageLimit.subscriptions` folds in
 * as the claude slice via {@link resolveAccountPool}. `id` is the stable handle, unique
 * across the whole pool.
 */
const claudeAccountSchema = z
  .object({
    id: nonEmpty,
    provider: z.literal("claude"),
    /** `CLAUDE_CONFIG_DIR` store written by `claude login` (the credential lives on disk). */
    configDir: nonEmpty,
  })
  .strict();

const openaiAccountSchema = z
  .object({
    id: nonEmpty,
    provider: z.literal("openai"),
    /** `CODEX_HOME` dir holding the ChatGPT-subscription `auth.json` (never an API key). */
    codexHome: nonEmpty,
  })
  .strict();

const zaiAccountSchema = z
  .object({
    id: nonEmpty,
    provider: z.literal("zai"),
    /** NAME of the env var holding the z.ai API key — never the key itself (ADR-0034). */
    authTokenEnv: nonEmpty,
  })
  .strict();

const accountSchema = z.discriminatedUnion("provider", [
  claudeAccountSchema,
  openaiAccountSchema,
  zaiAccountSchema,
]);

/**
 * The stable account ids the **single-block back-compat** provider credentials fold into
 * the pool under (ADR-0037 P2.2): `providers.openai.codexHome` →
 * `{ id: "openai", provider: "openai", codexHome }`, `providers.zai.authTokenEnv` →
 * `{ id: "zai", provider: "zai", authTokenEnv }`. Fixed ids (one such account per provider),
 * mirroring how the legacy single z.ai meter was keyed `"zai"`. Shared by
 * {@link resolveAccountPool} (the fold) and the uniqueness guard below so the two agree.
 */
export const BACKCOMPAT_OPENAI_ACCOUNT_ID = "openai";
export const BACKCOMPAT_ZAI_ACCOUNT_ID = "zai";

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

/**
 * Retired, accepted-but-ignored execution-mode key (ADR-0038 / #227). The container model is the
 * only execution path; there is no in-process alternative and no rollback. The enum is retained
 * solely so a live daemon whose gitignored `config.yaml` still carries `executionMode: container`
 * (or the legacy `in-process`) does not wedge on the next restart — strict-zod (ADR-0010) would
 * otherwise reject it as an unknown key. The value is parsed-then-ignored (a garbage value still
 * fails loud); the composition root logs a one-line deprecation when the key is present.
 */
const executionModeEnum = z.enum(["in-process", "container"]);

/**
 * One target repo the daemon operates *on* (distinct from this repo). `repo` and
 * `commands` are mandatory — the build/test gate differs per repo. Everything else
 * is an optional override of the daemon-wide default, deep-merged in config/load.ts.
 * `paths` default to slug-derived directories so two targets never collide.
 */
const targetSchema = z
  .object({
    /** The `owner/repo` slug the daemon works (e.g. `acme/example-monorepo`). */
    repo: repoSlug,
    paths: z
      .object({
        /**
         * Local clone of this target. Its object store is shared by every
         * per-issue worktree; `git worktree add` runs here. Defaults to
         * `.target-repo/<owner>-<repo>` (derived from the slug in load.ts).
         */
        targetClone: nonEmpty.optional(),
        /**
         * Root under which this target's per-issue worktrees are created.
         * Defaults to `.wt/<owner>-<repo>`.
         */
        worktreeRoot: nonEmpty.optional(),
      })
      .strict()
      .prefault({}),
    /** Shell commands run inside a worktree to gate a change (per target). */
    commands: z
      .object({
        build: nonEmpty,
        test: nonEmpty,
      })
      .strict(),
    /** Per-target overrides of the daemon-wide `agent`/`merge`/`review`/`autoMode` defaults. */
    agent: agentOverrideSchema.optional(),
    merge: mergeOverrideSchema.optional(),
    review: reviewOverrideSchema.optional(),
    autoMode: autoModeOverrideSchema.optional(),
    /** FIFO priority tie-breakers for this target (overrides scheduler.priorityLabels). */
    priorityLabels: z.array(nonEmpty).optional(),
    /**
     * **Deprecated and ignored (#227).** Every target runs in a fresh per-target container; there
     * is no in-process alternative and no mode to switch to. Accepted-but-ignored, optional, only
     * so a live daemon does not wedge on an operator's gitignored `config.yaml` that still sets it
     * (the composition root logs a one-line deprecation when present). Dropped from
     * `.ralph/config.example.yaml`. A garbage value still fails loud (strict enum).
     */
    executionMode: executionModeEnum.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    /**
     * The repos the daemon operates on, each scheduled independently but sharing
     * the one global agent budget (`scheduler.maxConcurrentAgents`) and the one
     * SQLite store. At least one is required.
     */
    targets: z.array(targetSchema).min(1, "at least one target repo is required"),

    paths: z
      .object({
        /** SQLite file holding rebuildable runtime state — shared across targets. */
        database: nonEmpty.default(".ralph/ralph.sqlite"),
      })
      .strict()
      .prefault({}),

    /** Daemon-wide defaults; a target may override any of these. */
    agent: agentGlobalSchema.prefault({}),
    merge: mergeGlobalSchema.prefault({}),
    review: reviewGlobalSchema.prefault({}),
    autoMode: autoModeGlobalSchema.prefault({}),

    /**
     * Multi-provider connection settings (issue #131/#149, ADR-0033/0034): the
     * per-provider details (`openai`, `zai`) the per-agent-type `agent.provider` /
     * `agent.types` selection routes to. Daemon-wide (a login/key is a box credential,
     * not per-target), carried onto every resolved target in config/load.ts.
     */
    providers: providersSchema.prefault({}),

    /**
     * The ACCOUNT POOL (ADR-0037): a flat, arbitrary registry of credentials — N per
     * provider, including zero — each a model-free, provider-shaped {@link accountSchema}.
     * Daemon-wide (a credential is a box credential, not per-target). The legacy
     * `usageLimit.subscriptions` (two Claude logins) folds in as the **claude slice** via
     * {@link resolveAccountPool}, so an existing config keeps loading while the pool becomes
     * the single source of truth. Empty by default. This slice (P1.1) adds the data only —
     * route resolution / the generalised meter that consume it are later slices.
     */
    accounts: z.array(accountSchema).default([]),

    /**
     * Operator-parked pool accounts (issue #10), keyed by **resolved pool id** — explicit
     * `accounts:` entries and back-compat-slice accounts (`usageLimit.subscriptions` ids, the
     * synthetic `openai`/`zai` ids) alike, which is why this is a top-level id list rather than a
     * per-entry flag: a back-compat slice has no `accounts:` entry to carry one. A disabled
     * account stays in the pool (the registry) but is invisible to dispatch-time selection: the
     * headroom port never returns it and route resolution walks on exactly like the all-gated
     * case. Runtime-mutable from the web control plane (the account arm of the routing edit),
     * written through here so the state survives restart + self-update. Ids are validated against
     * the resolved pool in `resolveTargets` (unknown id → fail loud), which also rejects a state
     * where a provider selected by any preference list has zero enabled accounts.
     */
    disabledAccounts: z.array(nonEmpty).default([]),

    scheduler: z
      .object({
        /** Max agents running at once across ALL targets (operator plan budget). */
        maxConcurrentAgents: z.number().int().positive().default(5),
        /** Seconds between reconcile ticks. */
        reconcileIntervalSeconds: z.number().int().positive().default(30),
        /** Labels used as FIFO tie-breakers, highest priority first (global default). */
        priorityLabels: z.array(nonEmpty).default([]),
        /**
         * Ceiling (seconds) on a graceful drain (SIGTERM/SIGINT or
         * `ralph-daemon --drain`, issue #35): how long to let in-flight agents
         * finish review + merge before force-exiting and surfacing what was still
         * running. A backstop for a genuine hang (#13's wall-clock makes those
         * rare); a second signal forces an immediate stop. Default one hour,
         * matching the per-agent wall-clock so one more session can finish.
         */
        drainTimeoutSeconds: z.number().int().positive().default(3600),
        /**
         * Consecutive claim failures tolerated for one issue before it is
         * surfaced as a `daemon-anomaly` rather than retried every tick (issue
         * #28) — the safety net that stops an unclaimable issue from starving the
         * scheduler.
         */
        maxClaimFailures: z.number().int().positive().default(3),
        /**
         * Liveness backstop (issue #27): an in-flight run whose row has not advanced
         * in this many seconds is wedged — the per-session wall-clock failed to
         * settle it — and is surfaced as a `daemon-anomaly` for a human. Must exceed
         * the wall-clock; the default (6h) is well beyond any single session. `0`
         * disables the backstop.
         */
        maxRunLifetimeSeconds: z.number().int().nonnegative().default(21600),
      })
      .strict()
      .prefault({}),

    /**
     * Claude **usage-limit** guard (shared across all targets — one OAuth plan
     * budget). The daemon reads the SDK's live plan rate-limit windows (5-hour +
     * weekly) and stops admitting NEW agents while any window is at/above
     * `admitBelowPercent`, or while a hit-limit cooldown is active. This prevents
     * the backlog being converted to `agent-stuck` when the plan is exhausted; the
     * limit is transient, so it self-heals when the window resets.
     */
    usageLimit: z
      .object({
        /** Master switch. On by default — a single shared safeguard, not per-target. */
        enabled: z.boolean().default(true),
        /**
         * Admit no new agents once any plan window's utilization reaches this
         * percentage (the "stop at 85%" knob). In-flight work is unaffected.
         */
        admitBelowPercent: z.number().int().min(1).max(100).default(85),
        /**
         * Dual-subscription rotation (ADR-0028): two-plus OAuth logins the daemon
         * routes between. Each is a stable `id` + the `CLAUDE_CONFIG_DIR` store its
         * `claude login` wrote (NOT a token — the credential lives on disk in that
         * dir). New sessions bind to the active login; the daemon flips to another
         * when the active one hits `admitBelowPercent`/cooldown or `rotateEveryMinutes`
         * elapses, and defers only when ALL are exhausted. Omit/one entry → the
         * box-default login, i.e. exactly the single-subscription behaviour.
         */
        subscriptions: z
          .array(
            z
              .object({
                id: z.string().min(1),
                configDir: z.string().min(1),
              })
              .strict(),
          )
          .optional()
          .superRefine((subs, ctx) => {
            if (!subs) {
              return;
            }
            if (firstDuplicate(subs.map((s) => s.id))) {
              ctx.addIssue({ code: "custom", message: "usageLimit.subscriptions ids must be unique" });
            }
          }),
        /**
         * Rotate the active login every N minutes for even wear (the timer trigger).
         * Omit → only the threshold/cooldown trigger flips the active login.
         */
        rotateEveryMinutes: z.number().int().min(1).optional(),
      })
      .strict()
      .prefault({}),

    /**
     * Daemon self-update (issue #30, ADR-0018). When enabled, the daemon polls its
     * own repo for new commits, gracefully drains, and exits the restart code so a
     * supervisor pulls + builds + relaunches it. Off by default — only turn it on
     * when the daemon runs under `ops/ralph-supervisor.sh`. Independent of which
     * targets the daemon works (it tracks the daemon's OWN repo).
     */
    selfUpdate: z
      .object({
        /** Master switch. Off by default (AC6); turn on only under the supervisor. */
        enabled: z.boolean().default(false),
        /**
         * Run the update check every N reconcile ticks. At the default 30s tick this
         * is ~5 min (10 ticks) — frequent enough to adopt fixes promptly, rare
         * enough that the extra `git fetch` is negligible.
         */
        checkEveryTicks: z.number().int().positive().default(10),
        /** The daemon's own branch to track (compared against `origin/<branch>`). */
        branch: nonEmpty.default("main"),
        /**
         * Hard ceiling on the graceful drain. Once draining, the daemon restarts the
         * instant it is idle; if an agent hangs, it restarts anyway after this many
         * seconds (next startup rehydrates in-flight work from GitHub, ADR-0003).
         */
        drainTimeoutSeconds: z.number().int().positive().default(1800),
        /**
         * Path to the daemon's own git checkout (where `git fetch`/compare runs).
         * Defaults to the process working directory — the repo root the supervisor
         * launches from.
         */
        repoDir: nonEmpty.default("."),
      })
      .strict()
      .prefault({}),

    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        /** Optional log file path; stdout-only when omitted. */
        file: nonEmpty.optional(),
      })
      .strict()
      .prefault({}),

    /**
     * The embedded web control plane (ADR-0029/0031/0032). An HTTP server that
     * runs *inside* the daemon process (not a sidecar) and serves the built SPA
     * statically. It is an isolated edge: the reconcile tick never awaits it and
     * it reads only through ports, so a web fault never wedges the daemon.
     *
     * **Bound to loopback by default** and reached remotely over Tailscale
     * (single-user tailnet = identity; no managed auth — ADR-0032). The bind
     * `host` is configurable but defaults to `127.0.0.1`; binding it to a
     * non-loopback address (e.g. `0.0.0.0`) is allowed but logged as a loud
     * exposure warning at startup, never the default.
     */
    web: z
      .object({
        /** Master switch. On by default; off → no server is started (the daemon runs headless). */
        enabled: z.boolean().default(true),
        /**
         * Bind address. Defaults to loopback. Set to a Tailscale IP (or `0.0.0.0`
         * behind the tailnet firewall) to reach it from a laptop/phone — doing so
         * emits an exposure warning, since there is no managed auth in front of it.
         */
        host: nonEmpty.default("127.0.0.1"),
        /** TCP port the SPA + API are served on. */
        port: z.number().int().min(1).max(65535).default(4280),
        /**
         * Directory holding the built SPA (Vite output), served statically with a
         * single-page-app fallback to `index.html`. Resolved against the daemon's
         * working directory; defaults to the `web/` workspace's build output. The
         * UI is part of the build gate (ADR-0018/0031), so a proper deployment
         * always has this populated; if it is missing the server still starts and
         * serves a placeholder, so the API stays reachable.
         */
        staticDir: nonEmpty.default("web/dist"),
        /**
         * Extra origins the Origin guard accepts on mutating routes, on top of the
         * server's own origins (ADR-0032; confused-deputy hygiene). Same-origin
         * requests from the served SPA are always allowed; list additional origins
         * here only if you front the UI from another host.
         */
        allowedOrigins: z.array(nonEmpty).default([]),
      })
      .strict()
      .prefault({}),

    /**
     * Agent **transcript** capture + retention (ADR-0030). Every impl/resume/review/fix/
     * moding session's `SDKMessage`s are captured (redacted) onto a dedicated per-run
     * stream — the verbose, two-tier companion to the permanent domain timeline. Capture
     * is always on (transcripts are owned data, not an SDK-internal artifact); only the
     * *retention budget* for the verbose tier is configurable. Pruning is oldest-first
     * and leaves a "transcript pruned" marker; the domain timeline is never pruned.
     */
    transcript: z
      .object({
        /** Prune a run's verbose transcript once its newest message ages past this many days. */
        retentionDays: z.number().int().positive().default(30),
        /**
         * Optional total size cap (MB) across all un-pruned transcripts. When exceeded,
         * the oldest runs are pruned first until back under the cap. Omit → age is the
         * only budget.
         */
        maxTotalMb: z.number().int().positive().optional(),
        /**
         * Run the retention prune every N reconcile ticks (the grouped scan is cheap, so
         * it need not run every tick). At the default 30s tick, 120 ≈ once an hour.
         */
        pruneEveryTicks: z.number().int().positive().default(120),
      })
      .strict()
      .prefault({}),

    /**
     * Out-of-app **notification sink** (epic #106, issue #117): an edge module that
     * subscribes to the after-commit event stream (the same in-process channel the live
     * SSE feed rides, ADR-0029) and fires best-effort **ntfy / webhook** notifications
     * when the daemon needs the operator and the UI is not open — a new escalation / heal /
     * stuck, a `daemon-anomaly`, and a stalled daemon. Dispatch is fire-and-forget and
     * never on the reconcile tick's path; the event → notification decision is a pure,
     * unit-tested transform. **Off by default**: notifications push data to an external
     * endpoint, so they are strictly opt-in.
     *
     * The sink is the live broadcast channel's second subscriber (the first is the SSE
     * feed), so it inherits ADR-0029's isolation contract for free — a slow or failing
     * endpoint never back-pressures the append path or the reconcile tick.
     */
    notifications: z
      .object({
        /** Master switch. Off by default (opt-in — notifications leave the box). */
        enabled: z.boolean().default(false),
        /**
         * One or more delivery endpoints. Each notification is POSTed to every endpoint
         * (fan-out, best-effort); an empty list with `enabled: true` is a valid no-op (the
         * sink runs but dispatches nowhere — useful while wiring up).
         */
        endpoints: z.array(notificationEndpointSchema).default([]),
        /**
         * Liveness backstop: notify when no reconcile tick has landed for this many seconds
         * (a wedged loop the UI's staleness flag already surfaces, paged out-of-app). `0`
         * disables the stall probe. Must exceed the reconcile interval; the default (5 min)
         * is well past two tick intervals so a single slow tick never false-fires.
         */
        stallSeconds: z.number().int().nonnegative().default(300),
        /**
         * Web Push delivery (issue #119): the PWA's native push channel — another delivery
         * target for the same escalation/anomaly/stall events. Off by default (push payloads
         * transit a third-party push service). Requires `enabled: true` above for the sink to
         * run; `endpoints: []` with this on is a valid push-only setup.
         */
        webpush: notificationWebPushSchema.prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const stallSeconds = config.notifications.stallSeconds;
    if (
      config.notifications.enabled &&
      stallSeconds !== 0 &&
      stallSeconds <= config.scheduler.reconcileIntervalSeconds
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["notifications", "stallSeconds"],
        message: "must be 0 or greater than scheduler.reconcileIntervalSeconds",
      });
    }
    // Web Push needs both a VAPID subject and the NAME of an env var holding the private
    // key when enabled — the channel cannot sign/serve without them (issue #119).
    const webpush = config.notifications.webpush;
    if (webpush.enabled) {
      if (!config.notifications.enabled) {
        ctx.addIssue({
          code: "custom",
          path: ["notifications", "enabled"],
          message: "must be true when notifications.webpush.enabled is true (web push is a notification-sink channel)",
        });
      }
      if (!webpush.subject || webpush.subject.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["notifications", "webpush", "subject"],
          message: "is required when notifications.webpush.enabled is true (VAPID sub)",
        });
      } else if (!isValidVapidSubject(webpush.subject)) {
        // RFC 8292 §3.2: the VAPID `sub` must be a URL (mailto: or https:). A bare address like
        // "operator@example.com" makes every push service reject the VAPID JWT with 403 — fail
        // this loud at load rather than as a silent 403 storm on every dispatch.
        ctx.addIssue({
          code: "custom",
          path: ["notifications", "webpush", "subject"],
          message: "must be a mailto: or https: contact URL (e.g. mailto:operator@example.com)",
        });
      }
      if (!webpush.privateKeyEnv) {
        ctx.addIssue({
          code: "custom",
          path: ["notifications", "webpush", "privateKeyEnv"],
          message: "is required when notifications.webpush.enabled is true (NAME of the env var holding the VAPID private key)",
        });
      }
    }

    const duplicateExplicitAccountId = firstDuplicate(config.accounts.map((account) => account.id));
    if (duplicateExplicitAccountId) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: `duplicate account id: ${duplicateExplicitAccountId}`,
      });
      return;
    }

    const explicitAccountIds = new Set(config.accounts.map((account) => account.id));
    const duplicateLegacyAccountId = config.usageLimit.subscriptions?.find((sub) =>
      explicitAccountIds.has(sub.id),
    )?.id;
    if (duplicateLegacyAccountId) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: `duplicate account id: ${duplicateLegacyAccountId}`,
      });
    }

    // The single-block back-compat provider creds fold into the pool under fixed ids
    // (ADR-0037 P2.2); an explicit account or legacy subscription already using one of
    // those ids would collide once the fold runs. Guard it at the same parse-time edge
    // the other id-uniqueness checks live, so the duplicate fails loud, not silently.
    const priorIds = new Set([
      ...explicitAccountIds,
      ...(config.usageLimit.subscriptions ?? []).map((sub) => sub.id),
    ]);
    if (config.providers.openai?.codexHome && priorIds.has(BACKCOMPAT_OPENAI_ACCOUNT_ID)) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: `duplicate account id: ${BACKCOMPAT_OPENAI_ACCOUNT_ID}`,
      });
    }
    if (config.providers.zai?.authTokenEnv && priorIds.has(BACKCOMPAT_ZAI_ACCOUNT_ID)) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: `duplicate account id: ${BACKCOMPAT_ZAI_ACCOUNT_ID}`,
      });
    }
  });

/** Validated, fully-defaulted configuration (targets carry per-target overrides). */
export type RalphConfig = z.infer<typeof configSchema>;

/** Shape accepted as input before defaults are applied. */
export type RalphConfigInput = z.input<typeof configSchema>;

/** Fully-resolved per-block settings (global defaults, after parse). */
export type AgentSettings = z.infer<typeof agentGlobalSchema>;
/** The reasoning-effort level an agent session runs at (`agent.effort` / a tier's `effort`). */
export type EffortLevel = z.infer<typeof effortEnum>;
/** One complexity tier's agent profile — routes / effort / wall-clock (issue #278). */
export type TierProfile = z.infer<typeof tierProfileSchema>;
/** The per-tier agent profiles keyed `"1" | "2" | "3"` (issue #278). */
export type AgentTiers = z.infer<typeof agentTiersSchema>;
/** The LLM provider backing an agent session: `claude` | `openai` | `zai` (issue #131/#149). */
export type ProviderName = z.infer<typeof providerEnum>;
/** Runtime guard: whether an arbitrary string is a known {@link ProviderName}. */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}
/** A per-agent-type provider/model override — the legacy single form (issue #131). */
export type AgentTypeOverride = z.infer<typeof agentTypeOverrideSchema>;
/** One `(provider, model)` entry of an ordered preference list (ADR-0037 P1.2). */
export type AgentTypeEntry = z.infer<typeof agentTypeEntrySchema>;
/**
 * A type's routing as parsed (ADR-0037 P1.2): the legacy single {@link AgentTypeOverride}
 * or an ordered {@link AgentTypeEntry} preference list. Normalise to the ordered list with
 * `providerPreferenceList` in `providers/select.ts`.
 */
export type AgentTypeRouting = z.infer<typeof agentTypeRoutingSchema>;
/**
 * The per-phase routing form for `review`/`fix` (ADR-0037 #169): `base` (required, applies to
 * every phase with no override) + optional `phase1`/`phase2` overrides, each an
 * {@link AgentTypeRouting}. Resolve the effective list for a phase with
 * `providerPreferenceList(agent, type, phase)` (`perPhase[phase] ?? base`, whole-list replacement).
 */
export type PhasedAgentTypeRouting = z.infer<typeof phasedAgentTypeRoutingSchema>;
/**
 * A `review`/`fix` type's routing (ADR-0037 #169): the {@link AgentTypeRouting} list/legacy form
 * (= base-for-all-phases) **or** the per-phase {@link PhasedAgentTypeRouting} object form. The
 * single-phase types (`impl`/`autoMode`) keep the narrower {@link AgentTypeRouting}.
 */
export type ReviewFixRouting = z.infer<typeof reviewFixRoutingSchema>;
/** The multi-provider connection settings block (issue #131, ADR-0033). */
export type ProvidersSettings = z.infer<typeof providersSchema>;
/**
 * One account in the pool: a model-free, provider-shaped credential (ADR-0037). A
 * discriminated union on `provider` — `claude` carries `configDir`, `openai` carries
 * `codexHome`, `zai` carries `authTokenEnv`. The resolved pool is {@link resolveAccountPool}.
 */
export type Account = z.infer<typeof accountSchema>;
export type MergeSettings = z.infer<typeof mergeGlobalSchema>;
export type ReviewSettings = z.infer<typeof reviewGlobalSchema>;
export type AutoModeSettings = z.infer<typeof autoModeGlobalSchema>;
/** The shared Claude usage-limit guard settings (global; not per-target). */
export type UsageLimitSettings = RalphConfig["usageLimit"];
/** The embedded web control plane settings (global; ADR-0029/0031/0032). */
export type WebSettings = RalphConfig["web"];
/** The agent-transcript capture/retention settings (global; ADR-0030). */
export type TranscriptSettings = RalphConfig["transcript"];
/** The out-of-app notification sink settings (global; issue #117). */
export type NotificationSettings = RalphConfig["notifications"];
/** The Web Push delivery settings for the notification sink (global; issue #119). */
export type WebPushSettings = RalphConfig["notifications"]["webpush"];
/** One notification delivery endpoint (issue #117). */
export type NotificationEndpoint = z.infer<typeof notificationEndpointSchema>;
/** The notification delivery protocol: `ntfy` (ntfy.sh) or `webhook` (JSON POST). */
export type NotificationEndpointKind = z.infer<typeof notificationEndpointKindEnum>;
/** One element of `config.targets` as validated (overrides still optional). */
export type TargetInput = z.infer<typeof targetSchema>;

/**
 * A single target fully resolved for the per-repo reconciler: global defaults with
 * the target's overrides merged in, slug-derived paths filled, and `targetRepo`
 * named exactly as the per-repo components (agent runner, review loop, prompt
 * builders) consume it. Produced by {@link resolveTargets} in config/load.ts.
 */
export interface TargetConfig {
  /** The `owner/repo` slug this reconciler works. */
  targetRepo: string;
  paths: { targetClone: string; worktreeRoot: string };
  commands: { build: string; test: string };
  agent: AgentSettings;
  merge: MergeSettings;
  review: ReviewSettings;
  autoMode: AutoModeSettings;
  /** Multi-provider connection settings (issue #131); daemon-wide, carried per target. */
  providers: ProvidersSettings;
  priorityLabels: string[];
  /**
   * Deprecated, accepted-but-ignored execution-mode key (#227): present only when an operator's
   * config still carries it, so the composition root can log a one-line deprecation. Every target
   * runs in a fresh per-target container regardless of this value; absent on a clean config.
   */
  executionMode?: ExecutionMode;
}

/** Retired execution-mode key (ADR-0038 / #227): accepted-but-ignored for config back-compat. */
export type ExecutionMode = z.infer<typeof executionModeEnum>;
