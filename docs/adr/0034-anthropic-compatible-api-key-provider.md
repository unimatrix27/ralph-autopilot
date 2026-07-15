# An Anthropic-compatible, API-key provider (z.ai / GLM) on the Claude SDK path

> **Amended by ADR-0037.** z.ai is recognised as one instance of the general
> **Anthropic-compatible, tool-capable endpoint** provider kind — the universal adapter
> for new providers (a translation proxy fronting API-key OpenAI/OpenRouter/local is the
> same kind, opt-in and fidelity-gated). Its credential becomes an **account** in the
> general pool.

## Context

ADR-0033 decoupled the agent provider behind the `SessionBackend` seam and added
**OpenAI (Codex)** as a second provider, authenticated by a **ChatGPT-subscription
OAuth login** — keeping ADR-0008's "OAuth subscriptions only — never an API key"
intact (it amended the *letter* from "Claude OAuth" to "Claude or ChatGPT OAuth").

We now want a **third** provider: **z.ai (GLM)**, serving GLM models (GLM-5.2,
GLM-4.x) behind an **Anthropic-compatible** endpoint (`https://api.z.ai/api/anthropic`).
GLM is cheap (pay-as-you-go, later upgradable to the GLM Coding Plan on the *same*
key) and GLM-5.2 is tuned for Claude-Code-style agentic loops, so it is a strong
candidate for **review** and **fix** work (legacy issue 149).

Two facts shape the design:

- **z.ai is Anthropic-compatible.** The Claude Agent SDK already honours a per-session
  `env` (it injects `CLAUDE_CONFIG_DIR` for dual-subscription rotation, ADR-0028). So a
  session can be pointed at z.ai by injecting `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  on that same seam and overriding the model — **no new SDK, no new backend class, no new
  runners**. z.ai rides the *Claude* path; the custom `escalate`/`stuck` tools therefore
  come for free (the advantage over Codex, which only does review/fix).
- **z.ai has no OAuth subscription login.** Even the GLM Coding Plan authenticates with a
  Bearer **API key**. There is no `auth.json`/`CLAUDE_CONFIG_DIR` analog to cache on disk.
  So this provider deliberately introduces the **first API key onto the box** — a new
  credential class that ADR-0033/0008 forbade.

This decision is pre-approved (legacy issue 149); this ADR records it.

## Decision

### Amend ADR-0033 / ADR-0008: permit an API key for an explicitly-scoped provider

ADR-0008 said "never an API key … there is no fallback auth path"; ADR-0033 amended its
letter to "OAuth subscriptions only — Claude or ChatGPT." We amend it once more, narrowly:

> **An explicitly-scoped, Anthropic-compatible third-party provider (z.ai / GLM) MAY
> authenticate with an API key / auth token.** `claude` and `openai` remain OAuth-only.

The spirit of ADR-0008 is held by two mitigations:

- **The key is read from an environment variable at runtime, never stored in
  `.ralph/config.yaml`.** `providers.zai` holds only `authTokenEnv` — the *name* of the
  env var — never the key. This keeps the secret out of config (which is committed/edited
  live) and off the log redactor's path. The schema has **no `authToken` field**;
  supplying one is an unknown-key `ConfigError` (zod `.strict()`).
- **Fail-loud at load.** Selecting `provider: zai` while `providers.zai` is unset, or with
  the named env var unset/empty, is a `ConfigError` at startup — not a surprise hours into
  a run (the no-silent-fallback discipline of ADR-0008).

### Blast radius (OPERATING.md §2)

The box runs agents under `bypassPermissions`, so the box *is* the blast radius. A
**spend-capable API key** on it is a strictly larger exposure than an OAuth login: an OAuth
subscription is plan-capped, whereas a pay-as-you-go key can accrue cost without a plan
ceiling. Accepted on the dedicated, credential-free box, and bounded by: the key is z.ai-only
(no other service), it is injected at runtime (not committed), and the operator sets a spend
cap on the z.ai account. The provider is removed by clearing the env var + the config block.

### Implementation (rides the Claude backend — no new backend class)

- **Config** (`src/config/schema.ts`): `zai` added to `providerEnum`; a `providers.zai`
  block `{ baseUrl (default https://api.z.ai/api/anthropic), authTokenEnv (required),
  model (default glm-5.2) }`. Carried onto every resolved target like `providers.openai`.
- **`ClaudeSessionBackend`** gains an optional `endpoint: { baseUrl, authToken, model }`.
  When present, `buildAgentOptions` (`src/executor/agent.ts`) overrides `options.model`,
  injects `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` via `options.env` (omitting
  `CLAUDE_CONFIG_DIR` — no OAuth store), and **drops `settings.forceLoginMethod`** (it
  forces the OAuth login method and conflicts with token auth). One backend, two auth modes.
- **Wiring** (`src/daemon/daemon.ts`): `zaiEndpoint` reads the key from
  `process.env[providers.zai.authTokenEnv]` and builds the `{ baseUrl, authToken, model }`
  override; `buildZaiBackend` wraps it in a `ClaudeSessionBackend`. The per-type builders
  branch on `provider === "zai"`: `buildReviewAgent`/`buildFixAgent` →
  `BackendReviewAgentRunner`/`BackendFixAgentRunner`; `buildModeClassifier` →
  `BackendModeClassifier`; `buildImplRunner` → `SdkAgentRunner` with the endpoint override.
  The `Backend*` runners/classifier are the former `Codex*` ones, renamed since they are
  generic `SessionBackend` wrappers serving both Codex and z.ai now.

### Isolation: a z.ai session is not a Claude session

- **Out of the OAuth usage router (ADR-0028).** `buildZaiBackend` passes **no** `configDir`
  and is **not** routed through the `UsageRouter`. z.ai usage hits z.ai's own quota;
  folding its `rate_limit_event` telemetry into a Claude login's state would corrupt the
  dual-subscription failover meter. Transient z.ai quota/rate-limit signals instead trip a
  separate provider cooldown gate, so the daemon defers new sessions without moving the
  Claude meter.
- **Distinguishability.** The composition root logs each agent type's resolved
  `{ provider, model }` (`daemon.agent-provider`), so a GLM session reads as `zai`/GLM in
  the structured log, never as `claude`.

### Scope — all four agent types

z.ai supports **all four** agent types (`impl`, `review`, `fix`, `autoMode`). This is the
payoff of riding the Claude SDK rather than a foreign one: `review`/`fix`/`autoMode` go
through the `SessionBackend` seam (a `ClaudeSessionBackend` with an `endpoint` override),
and `impl` runs through `SdkAgentRunner` with the same `endpoint` override — its in-process
`escalate`/`stuck` MCP tools work unchanged because the SDK is identical. A `zai` impl
session is simply driven OFF the OAuth `UsageRouter` (no token bind, no rate-limit fold), so
GLM usage never moves the Claude meter.

The one combination that remains unwired is **`impl` on `openai` (Codex)** — its
escalate/stuck tools do not port to the Codex SDK (legacy issue 146) — which `assertProviderWired` still
rejects loud at the composition root.

## Consequences

- **Any/all agent types can run on GLM** at a fraction of the cost, on the existing Claude
  SDK path — set `agent.provider: zai` to run the whole daemon on GLM, or route per type.
  The unconfigured daemon is byte-for-byte unchanged (default provider `claude`).
- **z.ai caps defer, not terminalize.** A z.ai 429/quota hit is treated like a transient
  usage cap: the affected session is deferred, a provider cooldown blocks fresh sessions
  until the cooldown clears, and the Claude OAuth usage meter remains untouched.
- **The box now holds a spend-capable API key** (env-var only). This is the first such
  credential; OPERATING.md §2's blast-radius note is widened accordingly.
- **A fourth provider** that is also Anthropic-compatible is now just another
  `providers.*` block + an `endpoint` override — no new backend. A non-compatible one is a
  new `*-backend` implementing `SessionBackend`, as ADR-0033 already anticipated.
- **ToS:** driving a paid third-party key from an automated box is an operator decision,
  recorded as risk-accepted (as in ADR-0028/0033); the daemon makes no attempt to disguise
  the automation.
- **Testing:** no test hits the live z.ai endpoint. The endpoint-injection logic is unit
  tested in `buildAgentOptions`; the load-time guards in `config.test.ts`; the
  composition-root wiring guards in `daemon/provider-wiring.test.ts`; the review/fix
  contract is unchanged and exercised behind the scripted `SessionBackend` fakes.
