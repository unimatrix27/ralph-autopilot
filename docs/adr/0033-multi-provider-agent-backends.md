# Multi-provider agent backends — a SessionBackend seam; OpenAI (Codex) on a ChatGPT subscription, per agent type

> **Amended by ADR-0037.** `providerForAgentType`'s single `{provider, model?}` per type
> becomes an ordered **`(provider, model)` preference list** resolved **at every agent
> start** (not frozen at the composition root); the four agent types become an open list;
> a principled **`toolsCapable` capability gate** replaces the hardcoded impl-on-openai
> block (which becomes a self-clearing maturity flag). The "TODO: port impl onto the
> SessionBackend seam" below is now a tracked follow-up.

## Context

Every agent session runs through the Claude Agent SDK (ADR-0008): impl, review,
fix, and the auto-mode classifier are all `query()` sessions on this box's OAuth
login. We want to run **specific agent types on a second provider** — initially
**review** and the **thermo Phase-2 fix** on OpenAI's GPT, via the Codex SDK — while
the rest stay on Claude, and to do it without scattering provider conditionals
across the codebase or precluding a future third provider (e.g. Together/GLM).

Two facts shape the design:

- **The agent-type taxonomy is exactly four** session kinds — `impl`
  (`SdkAgentRunner`), `review` + `fix` (the review loop; "thermo review" is just
  `review`/`fix` at Phase 2, not a separate kind), and `autoMode` (`SdkModeClassifier`).
  "Answered questions" is not a kind either — an answered escalation *resumes* whichever
  kind paused, so it inherits that kind's provider.
- **A structured harness session needs one thing from a provider:** run a fresh,
  tool-using session in a worktree and return its final assistant text — the caller
  parses that text against its own contract (worklist / fix outcome / mode verdict).
  The review/fix runner *interfaces* (`ReviewAgentRunner`, `FixAgentRunner`) are
  already provider-agnostic; the only Anthropic-specific code was the body of the old
  `runSession` inside `executor/structured-session.ts`.

This decision is **pre-approved** (maintainer decision in the originating discussion,
legacy issue 131); this ADR records it, it does not re-litigate it.

## Decision

### Amend ADR-0008: OAuth subscriptions only — never an API key

ADR-0008 said "agents run on this box's OAuth … never an API key … there is no
fallback auth path." We amend its letter to **"OAuth subscriptions only — Claude or
ChatGPT — never an API key,"** keeping its spirit intact. The OpenAI provider
authenticates with a **ChatGPT-subscription OAuth login**: a pre-cached `auth.json`
under a dedicated `CODEX_HOME` (the direct analog of `CLAUDE_CONFIG_DIR`), captured
once with `codex login` and copied onto the box (see
[docs/runbooks/openai-codex-auth.md](../runbooks/openai-codex-auth.md)). The Codex
client **never sets an `apiKey`**; like the Claude path, the credential lives on disk
and is selected by an env dir, not embedded in config. Dual-subscription rotation
(ADR-0028) is unchanged and Claude-only — Codex has no such login rotation.

### The `SessionBackend` seam (`src/providers/`)

One leaf interface captures the single operation above:

```
SessionRequest { prompt, worktreePath, systemAppend?, abortSignal? }
SessionBackend { run(req): Promise<string> }   // throws WallClockExceededError on overrun
```

The structured retry/parse contract is lifted to be provider-neutral:
`runStructuredWithBackend<T>(backend, req, parse)` drives the session, re-prompts a
bounded number of times on unparseable output, and never retries a wall-clock kill
(unchanged behaviour, legacy issue 15). `runStructuredSession` is now a thin adapter that
builds a `ClaudeSessionBackend` and delegates — every existing caller and test keeps
its signature.

Isolated modules, each a leaf the wiring depends on:

- `backend.ts` — the pure types above, **zero imports**. A new provider is a new file,
  not edits across the tree.
- `claude-backend.ts` — `ClaudeSessionBackend`: the exact body lifted out of the old
  `runSession` (wraps the reaped, wall-clocked `query()` session; folds plan
  rate-limit signals into the bound login; re-casts an overrun to
  `WallClockExceededError`). Rebuilt per call by the Claude runners to bind each
  session to the active OAuth login (ADR-0028).
- `codex-backend.ts` — `CodexSessionBackend` + the injectable `CodexClient` seam. The
  backend owns the provider-neutral mechanics (fold `systemAppend` into the prompt —
  Codex has no `claude_code` preset to append a system prompt to; link the parent
  abort; arm the wall-clock `setTimeout` that aborts + marks `expired`; map an expired
  abort to `WallClockExceededError`) and delegates the turn to the client. Built once
  at the composition root (no login rotation) — that asymmetry with the per-call Claude
  rebuild is intentional.
- `codex-client.ts` — `SdkCodexClient`: the **only** importer of `@openai/codex-sdk`,
  imported **lazily** (`await import(...)`) so a Claude-only box never loads it. Builds
  `new Codex({ baseUrl?, env })` (env seeded from `process.env` and carrying
  `CODEX_HOME`; never an `apiKey`), `startThread({ workingDirectory, skipGitRepoCheck:
  true, model, modelReasoningEffort, sandboxMode: "danger-full-access", approvalPolicy:
  "never", networkAccessEnabled: true })`, and returns `turn.finalResponse`. The
  non-interactive posture is the Codex analog of Claude's `bypassPermissions` — the box
  is the blast radius (OPERATING.md §2). **`danger-full-access`, not `workspace-write`:**
  a fix session resolves rebase conflicts by finishing the rebase in-session (`git add` +
  `git rebase --continue`), and git writes its `index.lock` / rebase state to the SHARED
  clone's `.git/worktrees/<name>/` — which lives OUTSIDE the worktree workspace, so under
  `workspace-write` it is read-only and every conflict-resolving fix escalated with
  "cannot create index.lock". Full access (matching Claude's `bypassPermissions`) is the
  fix; it is bounded by the dedicated, credential-free box. Effort maps this repo's enum
  (low|medium|high|xhigh|max) onto Codex's (minimal|low|medium|high|xhigh): `max →
  xhigh`, the rest pass through.
- `select.ts` — the pure `providerForAgentType(agent, type)` + the `AgentType` union,
  used by **both** load-time validation and daemon wiring so they can never disagree.

`@openai/codex-sdk` is a **normal `optionalDependency`** (installed without
`--ignore-scripts` so it does not wipe `better-sqlite3`'s native binding); a
Claude-only box simply never loads it.

### Per-agent-type provider config

`agent.provider` (default `claude`) sets the default; `agent.types.{impl,review,fix,
autoMode}.{provider?,model?}` overrides it per type. A per-type `model` overrides the
provider's default model (Claude: swap `agent.model`, mirroring `autoMode.model`;
OpenAI: `providers.openai.model`). A top-level `providers.openai = { codexHome
(required), model (default gpt-5.5), baseUrl? }` block holds the connection
details, carried onto every resolved target. Selecting `provider: openai` for any
type while `providers.openai` is unset **fails loud at load time** (a `ConfigError`,
not a first-launch surprise) — the no-silent-fallback discipline of ADR-0008.

Because the OpenAI provider authenticates with a **ChatGPT subscription** (above), the
default model is the plain **`gpt-5.5`**, not `gpt-5.5-codex`: a ChatGPT-subscription
Codex login accepts plain `gpt-5.x` ids and **400s every `-codex`-suffixed id** (`"The
'gpt-5.5-codex' model is not supported when using Codex with a ChatGPT account."` — the
`-codex` ids are API-tier, unreachable under the OAuth-only stance; legacy issue 138). The
`SdkCodexClient` maps that specific 400 to an actionable error naming the
`providers.openai.model` knob, so the next operator is not sent log-spelunking.

Default provider stays `claude`, so an **unconfigured daemon is byte-for-byte
unchanged**.

## Consequences

- **`review` and `fix` can run on Codex** (including thermo Phase 2, which is a `fix`
  session) when configured; the Claude path is provably unchanged — the existing
  `sdk-agents` / `sdk-mode-classifier` tests pass untouched, and the Claude runners now
  delegate through the same provider-neutral contract as Codex.
- **`autoMode` on Codex is now wired (legacy issue 136).** The moding classifier was made
  provider-agnostic (`classifyWithBackend` over a `SessionBackend`, mirroring
  `reviewWithBackend`/`fixWithBackend`); `SdkModeClassifier` delegates through it (Claude
  path byte-for-byte unchanged) and a new `CodexModeClassifier` runs it on a
  `CodexSessionBackend`. The ADR-0021 could-not-decide contract (leave the issue unmoded +
  log it; never guess-label, never a `daemon-anomaly`) is provider-independent.
- **`impl` on Codex is out of scope** and not yet wired: it depends on the in-process
  `escalate`/`stuck` SDK MCP tools, which are Claude-SDK-specific and do not port cleanly.
  The config *accepts* `provider: openai` for it, but the composition root **fails loud**
  rather than silently running it on Claude. TODO: port `impl` (its `escalate`/`stuck`
  tools) onto the `SessionBackend` seam.
- **A third provider is a new file.** Together/GLM (likely API-key based) would be a new
  `*-backend` + client implementing `SessionBackend`; the seam does not preclude it (an
  API-key provider would amend this ADR's auth stance for that provider only).
- **Blast radius (OPERATING.md §2):** the box may now also hold a ChatGPT-subscription
  `auth.json`. Like the Claude login dir it is *not* an isolation boundary — same user
  reads both — so it widens the credential blast radius by exactly one more subscription;
  acceptable on the dedicated, credential-free box. Never commit it.
- **Wall-clock hard-kill is Claude-only (accepted limitation, Option 1).** DESIGN §3's
  process-group SIGKILL / no-orphan guarantee holds only on the Claude provider, which
  spawns the CLI as a reapable process-group leader. `@openai/codex-sdk` spawns its
  `codex` CLI via `child_process` **without** `detached`/`setsid` and hides the child
  pid (`node_modules/@openai/codex-sdk/dist/index.js`: `spawn(executablePath, args, {
  env, signal })`), so a wall-clock overrun cancels through the turn's `AbortSignal` — a
  single **SIGTERM** to the `codex` process — and can orphan the `build`/`test`/bash
  children it launched (the codex-backend reaper is a deliberate no-op). Accepted because
  the box is dedicated and credential-free (OPERATING §2), overruns are rare, the blast
  radius is box-local with no prod reach, and the box is rebooted every 24 h, which bounds
  accumulation. **Follow-up:** regain process-group control for Codex — run the `codex`
  CLI under the existing `createProcessGroupReaper` instead of the in-process SDK turn — to
  restore DESIGN §3 parity.
- **ToS:** driving a ChatGPT subscription from an automated box is an operator decision,
  recorded as risk-accepted (as in ADR-0028 for the second Claude login); the daemon makes
  no attempt to disguise the automation, and the provider is removed by deleting the block.
- **Testing:** no test invokes the real Codex SDK or a live ChatGPT login (CI has
  neither). The real `SdkCodexClient` is the thin, isolated edge; everything above it is
  tested behind the `CodexClient` / `SessionBackend` fakes, matching the repo's DI+fakes
  convention.
