# Runtime provider routing — an account pool, per-type provider preference, a capability gate, and live web control

## Context

ADR-0033 introduced the `SessionBackend` seam and `providerForAgentType(agent, type)`:
a pure function that maps each of the four agent kinds (`impl`, `review`, `fix`,
`autoMode`) to a `{ provider, model? }`. ADR-0028 added dual-subscription rotation —
but only for Claude, hardcoded to a list of two OAuth logins. ADR-0034 added z.ai as an
Anthropic-compatible, API-key provider on the Claude SDK path.

Three limitations block where we want to go:

1. **Routing is frozen at the composition root.** `providerForAgentType` is *called once*
   in `daemon.ts`, and the results are baked into closures — the impl runner, the Codex
   backend, and the z.ai backend are each built once and captured. Only the Claude path
   rebuilds per call (it had to, for OAuth rotation + the transcript sink). So a routing
   change today requires editing `config.yaml` and a full daemon restart.

2. **Credentials are not modelled as a pool.** ADR-0028's rotation assumes exactly "two
   Claude logins"; there is no notion of *N accounts per provider* (4 z.ai keys + 1
   Claude, 3 Codex + 0 Claude, …), and each provider's auth is a separate code path
   (`bindSession` for Claude, `zaiEndpoint` for z.ai, `buildCodexBackend` for Codex).

3. **There is no operator-facing control or visibility of routing.** The embedded web
   control plane (ADR-0029/0031/0032) steers backlog state via GitHub labels, but cannot
   see *which provider/model/account a run is using*, nor change the routing.

We want: routing as **live data a single seam consults at every agent start**, an
**account pool** of arbitrary size and mix, **per-type provider preference with
fallback**, a principled **capability gate**, graceful behaviour when no provider has
headroom, and the whole thing **visible and editable from the web control plane** with
changes that take effect **without a daemon restart**.

This decision was reached in a design session (the grilling that produced this ADR); it
amends ADR-0028, ADR-0033, and ADR-0034 rather than re-litigating them.

## Decision

### The route, and route resolution

A **route** is the concrete `{ provider, model, account }` an agent start runs on.
**Route resolution** is the act of producing one, done **at every agent start** by
reading the *current* routing — never a startup snapshot. (We deliberately do **not**
call this a dispatcher — CONTEXT.md reserves against that word; it is *route resolution*,
the natural extension of ADR-0033's `providerForAgentType`.)

Route resolution runs in the **daemon**, once per agent start, **before dispatch**: the daemon reads
the current routing, resolves `{ provider, model, account }`, and injects it into the container — the
chosen account's credential is mounted, and the provider/model are passed as env. The `SessionBackend`
(ADR-0033) is then constructed *inside the container* from that injected route (ADR-0038 is
container-only). Nothing is captured in startup closures: every run resolves fresh, so a routing
change takes effect on the next dispatch with no daemon restart.

### Three separated concerns

The tangled "provider" notion splits into three:

- **Account** — a single credential, the unit of the pool. `{ id, provider, <auth> }`
  and **nothing else** — *no model*. Auth is provider-shaped (`configDir` for Claude,
  `authTokenEnv` for z.ai, `codexHome` for Codex), abstracted behind one "bind this
  account to a session" operation so route resolution never special-cases a provider.
  The pool is flat and arbitrary: N per provider, including **zero** (a provider with no
  accounts is simply unavailable). This generalises ADR-0028's two-Claude-login list to
  every provider. _Avoid_: subscription (when you mean the generic unit), login.

- **Provider (kind)** — the backend kind: auth style + how it is reached (native SDK, or
  an Anthropic-compatible endpoint) + a **`toolsCapable`** flag. `claude` and `zai` are
  tools-capable; `openai` (bare Codex SDK) is not (yet — see Consequences). A
  proxy-backed provider under the Anthropic-compatible-endpoint kind declares its own
  flag.

- **Agent type** — still the four kinds, but the schema and resolver treat the set as an
  **open list** so new types are additive (a separate effort will extend it). Each type
  declares whether it **requires in-session host-callback tools** (see the gate).

### Per-type routing: a preference list of `(provider, model)`

Each agent type's routing is an **ordered, preference-ranked list of
`(provider, model)` entries**. Model ids are not portable across providers (`opus` is
Claude-only, `glm-5.2` z.ai-only, `gpt-5.5` Codex-only), so the model travels *with each
entry*, not on the account. Accounts stay model-free; **account choice within a chosen
provider is automatic** — rotated for headroom / even wear by the generalised meter
(below). Consequence: a single z.ai credential serves `review` at `glm-5.2` and `impl`
at `glm-5.2[1m]` from *one* account and two route entries; rotation is a pure credential
swap that never changes the model.

Route resolution for `(repo, type)`:

1. Walk the type's preference list in order.
2. The first entry whose **provider is allowed by the capability gate** *and* has **an
   account with headroom** wins; pick a headroom account from that provider's pool
   (rotated). Return `{ provider, model, account }`.
3. If no entry qualifies, return **no route** — a `no-provider` wait (below), never an
   error and never a guess.

### The capability gate — `toolsCapable`

The one principled constraint. The capability is precisely **in-session host-callback
tools**: the agent invoking a custom tool that runs *our* host code mid-session —
`escalate` (checkpoint WIP, push branch, post `ralph-question`, swap label) and `stuck`.
It is **not** file read/write (every backend has it — review reads the worktree, fix
edits it) and **not** MCP boosters (review *uses* serena/context7 on Claude but does not
*need* them — it already runs on Codex without them).

- `impl` **requires** in-session tools. `review` / `fix` / `autoMode` **do not** — their
  contract is read(/edit) the worktree and emit one JSON object; `fix`'s escalate is a
  *structured-output field*, not a tool call.
- A type may route to a provider iff `requiresTools(type) ⟹ provider.toolsCapable`.
- Enforced by **one pure function** at three points (mirroring how ADR-0033's
  `providerForAgentType` is shared by load + wiring): **config load** (reject, a
  `ConfigError`), the **web edit API** (reject / render the choice disabled-with-reason,
  never silently hidden), and **route resolution** (defence in depth — fail loud rather
  than run on the wrong backend, like today's `assertProviderWired`).

### No headroom is a wait, not a stuck — `no-provider`

If route resolution returns no route for an otherwise-[[eligible]] issue, the issue is
**not launched this tick and not escalated**. It stays `eligible` (keeps
`ready-for-agent`, no human-attention label) and appears in the **launch plan
`excluded`** list with a new reason **`no-provider`** — the exact shape that already
handles "more eligible issues than open slots". The next tick re-resolves; when a usage
window resets and a provider regains headroom, the issue is picked up automatically.

This is the generalisation of ADR-0028's global pause (both Claude budgets dead → admit
nothing) down to per-type, per-provider-pool granularity. The **completeness invariant
is unaffected**: a `no-provider` issue classifies as `eligible`, so it is no island and
never a `daemon-anomaly`.

### Generalised account meter (amends ADR-0028)

ADR-0028's usage meter — per-login usage state, headroom gating, fall-through to the next
account with headroom — is lifted from "Claude, two logins" to **a pool per provider**. "A provider
has headroom" ≙ at least one of its accounts is not gated. Route resolution falls through the
preference list across pools; each provider keeps an isolated meter so one provider's quota never
corrupts another's gating (the ADR-0034 z.ai-meter rule, generalised).

Because a container holds **one account for its whole life** (no in-process session to rotate
mid-run; ADR-0038), an account's rate-limit signals are observed *inside* the container and fold
back into its meter state over the best-effort telemetry pipe; a dropped signal degrades to a staler
headroom view, never lost work. The meter therefore steers the **next** dispatch's account choice,
not a mid-session rotation.

### Runtime-mutable, write-through to config

Routing (and the account/provider definitions) is editable from the web control plane
with **no daemon restart**. A change writes through to **`config.yaml`** (gitignored, so
the self-update `git reset --hard` never touches it — it survives restart) **and** is
held in a runtime overlay route resolution reads each tick. Effect is **next agent
start** (≈ next tick); **in-flight sessions finish on the route they started with**.
There is one source of truth (the file); the overlay is the not-yet-flushed edit, so
boot needs no file-vs-store reconciliation.

This is a deliberate, bounded carve-out from "config is read once at startup": only the
routing surface is live; everything else still requires a restart. The write path reuses
the web write discipline of ADR-0032 (origin guard; validated at the contract edge).

### Visibility — record the resolved route per phase

Route resolution is the single place a route is decided, so it is the single place to record it. The
daemon resolves the route **at dispatch** and records the resolved **`{ provider, model, account }`**
on the existing phase/run read-model — no telemetry round-trip needed, since the daemon already knows
what it dispatched. A container holds **one route for its whole life**, so the route is fixed per
phase; it changes only **between** containers — a resumed phase is a fresh dispatch that re-resolves,
**overwriting** that phase's recorded route (latest dispatch wins). The web contract (ADR-0031)
carries it (the same projection the web read API and run-detail consume; ADR-0030) so the fleet view
shows the **live** route of the running phase and the run-detail timeline shows it **per past phase**.

### Per-repo is anticipated, global ships first

The end state is **global base ⊕ per-repo deviation** across the *whole* setup (accounts
a repo may use, providers, and per-type routing). This ADR builds the global layer and
shapes resolution as a pure `resolve(globalRouting, repoPatch?)` with the patch **empty
in v1**, so per-repo deviation is an additive overlay later, not a re-key. The runtime
overlay and the web read API are already repo-aware (everything is keyed by `?repo=`).

## Consequences

- **A routing change is a live web action**, not an edit-and-restart. Operators see, per
  run/phase, exactly which provider·model·account ran — including an account change across phases
  (each container runs one fixed route; the route changes only between containers).
- **The account pool is arbitrary.** 4 z.ai + 1 Claude, 3 Codex + 0 Claude, etc., all
  expressible; ADR-0028's two-login assumption is gone. `usageLimit.subscriptions`
  becomes the Claude slice of the general account pool (migration handled in the config
  schema; the example file documents the new shape).
- **`review` / `fix` / `autoMode` are freely routable** to any provider/account
  (capability-open). Routing one to a *bare* backend loses the MCP boosters (weaker code
  navigation) — a quality trade, not a capability block; logged, never silent.
- **`impl` carries the only non-trivial gate.** It stays routable to `claude` / `zai`
  and **not** to bare `openai` — but the gate is a *self-clearing maturity flag*, not a
  hardcoded blocklist: when escalate/stuck are re-hosted as an out-of-process MCP server
  (the **follow-up issue**, the real form of ADR-0033's "TODO: port impl"), `openai`
  flips `toolsCapable` and impl→openai becomes selectable with no blocklist to hunt down.
- **No proxy converts a subscription into a tool-capable API endpoint.** The universal
  adapter for new providers is the **Anthropic-compatible, tool-capable endpoint** (the
  z.ai shape, ADR-0034); a translation proxy (anthropic-proxy and the like) brings
  API-key OpenAI/OpenRouter/local backends *with tools* onto the Claude SDK path, but is
  **opt-in, fidelity-gated, never default**, and never on the path of the natively-working
  Claude/Codex subscriptions. Subscription-Codex-with-tools remains the MCP-port job.
- **Amends ADR-0028** (rotation → general per-provider account pools), **ADR-0033**
  (per-type single provider → preference list + capability gate + runtime mutability;
  the four types become an open list), **ADR-0034** (z.ai is one instance of the
  Anthropic-compatible-endpoint provider kind).

### Out of scope (parked follow-ups)

1. **Port `impl` onto Codex**, subscription-preserving: re-host `escalate`/`stuck` as an
   out-of-process MCP server wired into the run's `CODEX_HOME` config (STDIO, or an HTTP
   MCP endpoint on the daemon's existing web server). Flips `openai.toolsCapable`.
2. **Extend the agent-type list** beyond the four (e.g. splitting Phase-1 / Phase-2
   review and fix into independently-routable types). _Resolved (legacy issue 169) — but not by
   minting new types:_ that would contradict ADR-0033 / CONTEXT.md (*"thermo review is
   just `review`/`fix` at Phase 2, not a separate kind"*) and re-indirect onto the same
   per-phase runner. Instead the **routing key gained a `phase`** — resolution is now
   `(repo, type, phase)`, and `review`/`fix` config accepts a per-phase object form
   (`base` + optional `phase1`/`phase2`, whole-list replacement `perPhase[phase] ?? base`).
   So normal review can route to a cheap provider while the Phase-2 thermo pass bumps to a
   stronger one, with no new type in the open list. Opening the config schema to
   **arbitrary new type keys** stays parked (no dispatch site consumes them yet).
3. **Per-repo deviation** of the whole setup (accounts allow-list + providers + routing),
   and its web editing surface — the data model already permits it.
