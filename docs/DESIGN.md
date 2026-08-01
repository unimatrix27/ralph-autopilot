# ralph-autopilot — design

The autonomous-implementation daemon for a **set** of target monorepos. This
document is the architecture of record; the rationale for each load-bearing
decision lives in [`adr/`](adr/). Terms in **bold** are defined in
[`../CONTEXT.md`](../CONTEXT.md).

## 1. Shape

A long-lived **daemon** models itself as a **reconciler** (the k8s pattern). Every
30 seconds it diffs **desired state** (GitHub labels) against **actual state**
(SQLite + running agents) and acts on the difference. GitHub is the source of
truth; SQLite holds only runtime state and is rebuildable from GitHub on restart.
No webhooks, no event backlog to lose — restart the daemon and it re-derives
reality. ([ADR-0003](adr/0003-reconciler-poll.md))

The daemon works **several target repos at once** (its own repo for
self-improvement *and* product repos), from one process on one box. One
**Orchestrator** (`daemon/orchestrator.ts`) owns the process loop and each tick
drives **one Reconciler per target** — sequentially and awaited — sharing one
SQLite store (every issue-keyed table gains a `repo` column) and one global build
budget (`scheduler.maxConcurrentAgents`). The pure cores stay per-repo: each
reconciler reconciles exactly one repo's issue set, and GitHub remains the source
of truth per repo (SQLite rebuildable per repo on restart).
([ADR-0020](adr/0020-multi-repo-orchestration.md))

Concretely, before the first tick a **startup reconciliation** rebuilds runtime
state from GitHub. It re-derives in-flight runs from the open PRs carrying the
`<!-- ralph-launch: … -->` marker: each orphaned `running` run is re-attached and
its review re-driven if its PR survives, else marked terminal with its worktree
removed; a paused run (`awaiting-answer` / `review-maxed`) is re-indexed — run
row, open-question entry, resume context — so it resumes once answered even on a
cold (lost) store. No orphaned worktrees or silently-abandoned runs survive a
restart.

Shutdown is the mirror image: a `SIGTERM`/`SIGINT` (or `ralph-daemon --drain`)
**drains** rather than aborting — it stops starting/resuming agents but lets the
in-flight ones finish their review + merge, then exits `0` with nothing wedged.
A configurable `drainTimeoutSeconds` force-exits a genuine stall and surfaces what
was still in flight; a second signal forces an immediate stop. The drain core
(`Reconciler.drainToCompletion`) is shared with self-update (legacy issue 30), which drains
the same way before it pulls + rebuilds + relaunches. (legacy issue 35; see
[OPERATING §3](OPERATING.md).)

Everything the daemon does is grounded in **hard facts**: labels, the `## Blocked
by` graph, CI status, structured agent results. Never agent folklore — agents run
with **fresh context** every time, no `memory` MCP. ([ADR-0008](adr/0008-oauth-fresh-context.md))

## 2. The eligibility gate

An issue is picked up iff: `state == OPEN` **and** labelled `ready-for-agent`
**and** `afk` **and** not `hitl` **and** every `## Blocked by` dependency is
`CLOSED` with a merged closing PR **and** it carries a **mode** (`mode:tdd`
default if absent, `mode:infra`, or `mode:ui`). Not labelled `[log] *`
(milestone-log issues). ([ADR-0006](adr/0006-mode-routing.md))

A `## Blocked by` reference may be written as `#n`, a same-repo GitHub issue URL
(the form GitHub itself renders), or `owner/repo#n` shorthand — all three gate
identically (issue #8). The gate **fails loud and closed** on anything else in
the section: a cross-repo reference is a dependency it cannot evaluate, so the
issue is held `blocked` (the ref surfaces verbatim in the backlog view) and a
warning is logged each tick; a section whose non-empty list items parse to zero
references is warned the same way, never treated as "no dependencies".

The `## Blocked by` graph is also how we **avoid the parallel-edit pileup**: when
authoring a batch of issues, foundational/cross-cutting work and heavy
same-subsystem overlap are chained so they don't collide under high concurrency.
The discipline for *when* to add a dependency lives in
[ADR-0013](adr/0013-issue-dependency-discipline.md); the runtime complement (a
rebase-aware merge that self-heals incidental overlap) is legacy issue 41.

The scheduler fills open slots up to `maxConcurrentAgents` (default 5,
configurable), FIFO by issue age with `priority/*` labels as tie-breakers. Slots
refill as agents finish. ([ADR-0002](adr/0002-worktrees.md) covers isolation;
the cap is purely the operator's plan budget to manage.)

**Auto-mode (the moding pass).** The gate requires a `mode:*` label, so a target
whose triage doesn't stamp one leaves `ready-for-agent` + `afk` issues stalled at
`no-mode`. When `autoMode.enabled` (per target, **off by default**), a bounded
pass each tick finds the issues the gate rejects *solely* for a missing mode,
classifies each as `tdd` or `infra` with a fresh-context SDK call, and applies the
label — so they become eligible next tick. It only ever fills the missing label on
issues a human already marked ready (it does not auto-triage *what* gets worked),
the tdd-vs-infra rubric is the harness's (target conventions are context, not a
gate — [ADR-0012](adr/0012-hardcoded-review-rubrics.md)), and it runs off the build
pool, capped at `autoMode.maxPerTick`. An issue the classifier cannot decide is
left unmoded and logged — never guess-labelled, never a `daemon-anomaly` (the
completeness invariant is untouched). ([ADR-0021](adr/0021-auto-mode.md))

## 3. Execution

One eligible issue → one git **worktree** on `ralph/<n>-<slug>` (shared object
store, isolated working tree) → one Claude **Agent SDK** session. On pickup the
daemon removes `ready-for-agent` (so it is not re-picked) and records the run in
SQLite.

Agents are driven through the Agent SDK (concurrent OAuth use is safe there),
authenticated by this box's `claude` login — **OAuth only, never an API key**.
Each agent gets the curated MCP set `codebase-memory, morph-mcp, context7` and
**not** `memory`. ([ADR-0008](adr/0008-oauth-fresh-context.md); trimmed in 2026-07 —
`github`/`sequential-thinking` dropped as redundant, `serena` replaced by the baked
`codebase-memory-mcp` binary, legacy issue 276)

Agents load the **target** repo's project context: the SDK runs with
`settingSources: ["project"]`, which reads that repo's `CLAUDE.md` / `.claude`
relative to the worktree `cwd`, and the harness injects the worktree's `AGENTS.md`
(the SDK does not auto-load it) into the system prompt for impl, resume, review,
and fix sessions alike. The operator's `user` layer and the `memory` MCP stay
**excluded** — preserving ADR-0008's no-leak / no-memory intent, now per target.
This refines ADR-0008's blanket `settingSources: []`.
([ADR-0019](adr/0019-per-target-project-context.md))

Two hard ceilings bound every agent: a **wall-clock** of 1 hour (daemon kills →
`agent-stuck`) and the **stuck budget** (agent self-stops → `agent-stuck`).

The wall-clock wraps **every** SDK session — impl, resume, review, and fix — not
just the impl/resume one, so a hung review/fix session is bounded too (it
surfaces as `review-maxed` rather than `agent-stuck`, since that path has a PR).
On the **Claude** provider the kill is *hard*: the SDK spawns the `claude` CLI
through `spawnClaudeCodeProcess` as its own process-group leader, so on overrun the
daemon aborts the `query()` **and** SIGKILLs the whole process group — reaping every
`build`/`test`/bash subprocess the agent spawned, so none outlives the run holding the
slot's resources (legacy issue 13). On the **OpenAI (Codex)** provider this hard-kill
guarantee does **not** hold: the wall-clock cancels the turn through its `AbortSignal`,
which delivers a single **SIGTERM** to the `codex` CLI process only (the Codex SDK
spawns it without a detached process group and hides its pid), so the `build`/`test`/bash
children it launched can be **orphaned** on overrun. This is an **accepted limitation**
of the Codex backend ([ADR-0033](adr/0033-multi-provider-agent-backends.md)), bounded by
the dedicated, credential-free box (OPERATING §2), the rarity of overruns, and a 24-hour
box reboot that clears any accumulation; restoring process-group reaping parity for Codex
is tracked as follow-up.

### Implementation call

Mode selects the prompt. `mode:tdd` implements red-green-refactor, builds and
tests until green, opens a PR (`Closes #n` + a `<!-- ralph-launch: … -->`
marker). `mode:infra` drops the test gate for a mode-appropriate verification.

`mode:ui` (view-layer work, legacy issue 277) keeps the build gate, treats tests as
additive (where sensible, never a gate on pixels), and verifies by *rendering*:
the agent captures headless-chromium screenshots of the changed surface and
delivers them to the PR via net-zero branch commits — PNGs committed to the PR
branch, embedded as pinned-SHA `raw.githubusercontent.com` links in the PR body,
then removed in a follow-up commit so the squash lands nothing. A surface that
cannot be rendered (missing chromium, unavailable backend) escalates — never a
hedged PR body. The mode presumes a chromium-equipped target image and is
operator-applied only.

An operator-applied `complexity:1|2|3` label selects the issue's **per-tier agent
profile** for the impl call ([ADR-0039](adr/0039-complexity-tier-agent-profiles.md),
legacy issue 278) — lower = more demanding, the `priority:p0` convention. A configured
`agent.tiers[tier]` may replace the impl route preference list whole and/or override
`effort` / `wallClockSeconds` for the run, all resolved daemon-side at dispatch (the
in-container runner applies, never re-derives). No label = the globals — the tier is
deliberately not part of the eligibility gate, so an unlabeled backlog never stalls;
review/fix routing and budgets are untouched (the review loop is what makes
unattended merge safe, [ADR-0014](adr/0014-harness-owned-merge.md)).

Outcomes are exactly three — PR opened, `escalate`, or `agent-stuck`. There is no
fourth "done with caveats" outcome: the **no-deferral rule** is enforced by the
output contract having nowhere to record a hedge. An *unexpected* failure mid-run
(an exception thrown out of the session after claim — e.g. a malformed agent
output that fails to parse) is not a fourth outcome either: it folds into
`agent-stuck`. The executor terminalizes the run off `status=running`, labels the
issue for a human, and closes any PR the agent had opened — never a silent island
that holds no slot yet is skipped by the gate, ignored by resume, and trails a
dangling PR (legacy issue 34; the
mid-run-failure sibling of the restart and completeness silent-loss classes). A
**transient external limit is the one documented exception**: a Claude usage limit
([ADR-0023](adr/0023-usage-limit-guard.md)) or a GitHub rate-limit on the merge/resume
paths ([ADR-0029](adr/0029-github-rate-limit-defer-not-stuck.md)) **defers** rather than
terminalizing — the work self-heals when the window clears, and a terminal-label swap
that itself loses to a rate-limit is retried on a later tick (no silent island). Its sibling, the
**design-authority rule** ([ADR-0011](adr/0011-design-authority-rule.md)), bars an
agent from silently re-architecting around an obstacle (e.g. swapping the Agent
SDK for CLI shell-out to dodge a dependency conflict) — it resolves toward the
committed design or `escalate`s. Together they pin the agent's endgame to *finish
as designed* or *escalate*. ([ADR-0009](adr/0009-auto-merge.md) covers the twin
principle on the merge side, auto-merge.)

## 4. The review loop

**Phase 0 — CI gate (await CI *before* review).** After the PR opens, poll
`gh pr checks <pr>` until every check is terminal. **Red** → skip review, treat the
failing checks as the fix worklist, run the bounded fix loop, push, re-await CI;
still red (or a timeout) → `review-maxed` (ci) + heal-card. **Green / no checks** →
proceed. Gating on CI first means review/fix budget is never spent on a PR that
does not even compile; on a repo with no checks this is a no-op.
([ADR-0014](adr/0014-harness-owned-ci-gated-rebase-aware-merge.md))

CI in flight is **transient**, so the gate waits for a **stably-terminal, latest**
verdict before manufacturing the `review-maxed` human-attention state
([ADR-0033](adr/0033-ci-gate-stably-terminal-latest-verdict.md), same principle as the
usage-limit guard [ADR-0023](adr/0023-usage-limit-guard.md)): `classifyChecks` collapses
multiple runs of one check name to the **latest** (by `startedAt`/`completedAt`), so a
passing re-run supersedes an earlier failure; a `pending` check or external commit-status
that never reports stays non-terminal (keep waiting up to `ciTimeoutMinutes`), never a
hard red; the gate **re-reads checks once** just before maxing so a green that lands
inside the poll window proceeds instead of terminalizing; and the CI phase spends its
**full `maxFixAttempts`** budget across the off-slot park re-entry. A genuine, stable red
still maxes after the full budget — the gate's purpose is preserved.

Both review steps run **locally** as Agent SDK sessions — deterministic, no
waiting on an external bot. The review rubrics are **hardcoded in the daemon**
(`src/review/prompts.ts`) and target-independent: Phase 1 carries a normal
correctness/security/spec/tests rubric, Phase 2 the thermo-nuclear structural
rubric. The agent reads the target's own `CLAUDE.md`/`AGENTS.md`/ADRs as *context*
for idioms, but the gating criteria are baked in and never depend on the target
shipping a review spec. ([ADR-0012](adr/0012-hardcoded-review-rubrics.md),
superseding [ADR-0005](adr/0005-two-phase-local-review.md))

**Phase 1 — normal review** (the hardcoded correctness / security / spec / tests
rubric). The review agent applies it to the diff **and ingests any automated PR
comments already present** (Codex, `@claude`, etc.), then emits a **worklist**. Up to three
**fix attempts**; the fix agent applies `P0`+`P1` items, builds+tests green,
pushes. Clean → advance. Three attempts still blocked → `review-maxed`
(correctness) + heal-card, **stop** (never enter Phase 2 on behaviourally-wrong
code).

**Phase 2 — behaviour-conserving thermo** (the hardcoded thermo-nuclear structural rubric). Same shape,
behaviour-preserving fixes only. Clean → done. Maxout → `review-maxed` (quality) +
heal-card.

Consolidation is folded into the review agent (it produces the deduped, ranked
worklist) — there is no separate "decide what to implement" agent. A fix agent
that hits a finding implying a risky design change (e.g. "delete this whole
layer") calls `escalate` rather than applying it blind.

**The review→fix handoff goes through the PR, not memory** (legacy issue 47). After each
review pass the loop posts (or edits) **one rolling `ralph-review` comment per
phase** carrying that phase's deduped worklist as a fenced JSON payload — the same
machine-parseable shape as `ralph-question`, through the one shared fenced-payload
codec (`src/core/fenced-payload.ts`). The fix agent reads the latest `ralph-review`
comment from the PR (plus any new bot/human comments) as the source of truth rather
than only the in-process worklist, so a reviewed PR carries a durable, human-readable
record of what review found and the fix step resolved — ralph's own findings and the
automated bots now share one review surface. Only the *findings* move to the PR; the
loop still tracks **attempt counters, gating, and the phase verdict locally** (SQLite).
The CI gate (Phase 0) keeps its inline failing-checks worklist — those are already
visible as red checks, not a review-agent finding, so no `ralph-review` comment.

The comment is **rolling**: edited in place as fix attempts resolve items (not one
comment per iteration, which would bury the thread), and idempotent across the
ADR-0017 build/integration split. A phase can review **twice** — once in the build
flow and again in the integration re-review when a moved rebase changed the branch's
net diff — so the loop recovers the existing comment's id from the PR (the listing
derives the numeric REST id from each comment's URL via `GitHubClient.updateComment`)
and edits it, converging on one comment per phase rather than posting a duplicate.

## 5. Merge

The lifecycle splits in two so high concurrency does not race at the merge
(ADR-0017). The **build flow** (high concurrency, ≤ `maxConcurrentAgents`) runs
review and, when both phases pass, hands off to `awaiting-merge` (sets the run
status; the `awaiting-merge` issue label is a level-triggered effect the reconciler
applies from that status, [ADR-0027](adr/0027-reconciler-as-outbox.md)) and frees its
slot — it does NOT merge. A **single-concurrency integration flow** (one merge lease in the
reconciler, serviced every tick and throughout drain) pulls the oldest
`awaiting-merge` run FIFO, re-attaches its worktree, and runs the **rebase-aware
merge** under the lease.

Integration first brings the branch current with base
(`git fetch && git rebase origin/<base>` in the worktree, force-push): a conflict is
aborted in the daemon worktree and handed to a fix agent that **starts a fresh
rebase in its own container clone**, resolves it, and reports `fixed` without
pushing — the **runner** (not the agent session) then force-pushes the rewritten
history (force-push is blocked inside agent sessions, §8; the harness — not the
agent — owns every rebase force-push), and the daemon **verifies** `origin/<branch>`
actually moved past the merge-base rather than assuming it landed (legacy issue 273) — a
conflict implying a risky structural change escalates, never resolved blind. That runner
force-push rewrites history, so the daemon worktree's stale local ref can never fast-forward
onto it; the daemon therefore **records the runner-pushed head SHA on the run** (recorded
whether or not the landed-verification then passes, since the push happened either way) so a
later resume or the integration re-sync recognises the divergence as its **own** verified write
and hard-syncs the local ref to `origin/<branch>` instead of tripping the divergence guard —
which otherwise fires on the daemon's own legitimate push and orphans the reviewed PR (issue 21).
The divergence guard stays fully intact for a divergence the daemon **cannot** attribute to its
own push (a hand force-push / unknown rewrite): rather than terminalize to `agent-stuck` with the
reviewed PR auto-closed, that case parks **healable** (`review-maxed` + heal-card, PR preserved)
so a human resolves it and re-enables the run. Then,
keyed on whether the branch **moved**: a no-op rebase merges directly; a moved
branch (base advanced under a reviewed branch) is **re-reviewed under the lease**
(net diff taken against `origin/<branch>`, so a conflict resolution that changed the
merged result is caught) and re-gated on CI before
`gh pr merge <pr> --squash --delete-branch`. The issue auto-closes via `Closes #n`;
the lease frees for the next queued run.

The integration lease is **per repo** — each target has its own, so different
clones never race base — and it is **free per-repo concurrency, NOT counted against
the global build cap** (gating it by the cap would let one repo at full build cap
never merge, regressing ADR-0017's "integration always progresses"). Peak agent
count is therefore `cap + (repos currently integrating)`: a small, bounded overage.
([ADR-0020](adr/0020-multi-repo-orchestration.md), refining
[ADR-0017](adr/0017-single-concurrency-integration-flow.md).)

Because only one branch races base at a time, the concurrency cap can run high
without the parallel-edit pileup (each later PR rebases onto a base only the merge
worker advances). **Merge from day 1** — safe because merging to `master` is not a
prod deploy (prod requires an explicit tag release, which no agent triggers under
these prompts). ([ADR-0017](adr/0017-single-concurrency-integration-flow.md),
building on [ADR-0014](adr/0014-harness-owned-ci-gated-rebase-aware-merge.md), which
superseded the auto-merge *mechanism* of [ADR-0009](adr/0009-auto-merge.md))

Success terminal = *merged + issue closed*. `ready-for-human` is therefore **not**
a success state; the human-attention states are `agent-stuck`, `awaiting-answer`,
`review-maxed`, and — as the catch-all that makes a dead state impossible to hide —
`daemon-anomaly` (§9a).

The four **daemon-set** state labels (`awaiting-answer`, `review-maxed`, `agent-stuck`,
`awaiting-merge`) are not written imperatively at the transition points. They are
level-triggered **effects** of the run-status projection: each tick the reconciler diffs
the desired set (derived from status) against the actual GitHub labels and applies the
difference idempotently, generalising the outbox `reconcileAnomalyLabel` already runs for
`daemon-anomaly`. A failed write self-heals next tick; up-to-one-tick effect latency is
accepted, and the completeness pass (§9a) compares against the projection's *desired* set
so that latency never raises a false island. The **intake** labels (`ready-for-agent`,
`afk`, `hitl`, `mode:*`) and `ralph-answer`'s `awaiting-answer → ready-for-agent` swap-back
stay human/CLI-set; the pickup claim's `ready-for-agent` removal stays inline.
([ADR-0027](adr/0027-reconciler-as-outbox.md))

## 6. Human input — the escalate / heal path

When an agent needs a decision it calls **`escalate`** — a custom tool, never
Claude's built-in `AskUserQuestion`. It is asynchronous: checkpoint the WIP branch
(draft PR + resume context), write a structured `ralph-question` comment, swap
`ready-for-agent → awaiting-answer`, free the slot, exit. The question schema is a
forcing function — `headline · feature · where_we_stand · decision · options? ·
stakes · recommendation`, all validated at the tool boundary. **`stakes` is
required** and must translate the decision up to architecture/user level. The
boundary also enforces an **escalation quality bar**: it rejects a design-resolvable
internal structure call (decide + ADR per ADR-0011 instead) and one whose stakes
only parse with the diff open.
([ADR-0004](adr/0004-async-escalate.md), [ADR-0015](adr/0015-escalation-quality-bar.md))

Answers come through the **`ralph-answer` CLI**, which is GitHub-only and runs
**anywhere** (not just the daemon box) — it serves open questions one at a time in
a forever loop, takes the typed answer, writes a `ralph-answer` comment, and swaps
the label back. The daemon sees the swap next tick and **resumes, not restarts**
the agent from its WIP branch with the answer injected. The resume **dispatches on
where the pause came from** (legacy issue 9): an impl-agent `escalate` resumes the impl/fix
session, while a **review-origin** pause — a `review-maxed` heal-card *or* a
review-loop `escalate` — re-enters the **build-flow review** ([ADR-0017](adr/0017-single-concurrency-integration-flow.md))
at the phase it paused on, with the answer injected as fix guidance, and hands back
off to `awaiting-merge` for the integration flow to land — instead of re-running the
impl prompt against a PR that is already built. The phase survives a cold store in a
hidden `ralph-phase` marker on the `ralph-question` comment, so a rehydrated
review-origin pause re-enters at the right phase too. `review-maxed` heal-cards flow
through the same answer queue. ([ADR-0007](adr/0007-two-tool-ui.md))

## 7. State & UI

**SQLite** (one file, `better-sqlite3`) holds runtime state: fix-attempt
counters, per-issue resume context, the open-question index, agent PIDs/worktree
paths, the structured run log. Transactional, survives reboots, rebuildable from
GitHub. ([ADR-0006a — see ADR-0003 lineage]; recorded as part of the reconciler.)

The operator's live window is the **embedded web control plane** (below); the
read-only Ink TUI that used to render it is **retired** (legacy issue 120), though the
pure projection it shared — `projection/snapshot.ts` — is kept and reused as the web read
API's model. The viewer stays SQLite-only and read-only: it never needs a GitHub
dependency, because the daemon persists what it needs. Agents write phase
transitions to SQLite *as they happen*, so progress is live between the 30s
reconcile ticks; and each tick writes a **backlog snapshot** to SQLite **per repo**
(a `daemon_snapshot` row keyed by `repo`) — the eligible queue in scheduler
pick-order, blocked issues with their unmet refs, paused/stuck. Eligible rows are
coloured from a single priority model: the daemon buckets each issue's rank in the
configured `priorityLabels` proportionally (`f = rank / max(1, N-1)`; `<1/3` red,
`<2/3` yellow, else blue) and carries the colour in the snapshot, so the viewer
never re-guesses priority from label text.
- **`ralph-answer` CLI**, GitHub-only, portable. ([ADR-0007](adr/0007-two-tool-ui.md))

**Embedded web control plane** (legacy epic 106; [ADR-0029](adr/0029-embedded-web-control-plane.md)).
An HTTP (+ SSE) server runs *inside* the daemon process — not a sidecar — and serves a
built SPA (Vite + React + TS + Tailwind + shadcn + TanStack) statically. It is an
**isolated edge**: the reconcile tick never `await`s it, it reads only through ports,
its socket is `unref`'d so it never delays a drain, and a bind failure is logged
rather than fatal. It is **aggregate-first across all repos** (capacity is one shared
global build budget — ADR-0020) with repo as a filter, leads with a "what needs me?"
attention band, and provides run history, a live transcript
viewer, and an integrated HITL inbox (it replaced — and in legacy issue 120 retired — the
read-only Ink TUI). The single client/server seam is a
**browser-safe zod contract leaf** (`src/web/contract`, zero node imports — a Vite
build-breaking discipline boundary) imported by both daemon and UI. Bound to
**loopback by default**, reached over **Tailscale** (the identity boundary; no managed
auth), with an **Origin guard** in front of (future) mutating routes and a reserved
auth-middleware seam. The UI is part of the **build gate** (ADR-0018) so a self-update
ships it atomically. ([ADR-0029](adr/0029-embedded-web-control-plane.md),
[ADR-0031](adr/0031-web-stack-and-contract.md),
[ADR-0032](adr/0032-web-exposure-and-writes.md))

## 8. Safety

- **No merge gate beyond CI-green** (now harness-enforced, not GitHub auto-merge) —
  and that is acceptable because prod is gated by a separate tag release.
  ([ADR-0014](adr/0014-harness-owned-ci-gated-rebase-aware-merge.md))
- **No prod credentials on the box** — AWS is deliberately uncredentialed; a
  runaway agent cannot reach prod Aurora/Cognito/Batch. Biggest blast-radius
  limiter.
- **git-guardrails hook** on agent sessions blocks dangerous local git ops;
  `master` already has `non_fast_forward` + `deletion` rules server-side.
- **Worktree isolation**, **1-hour wall-clock**, **stuck budget**.
- Agents never echo secrets.

## 9. Label state machine

```
needs-triage ──► needs-info ──► (triage skill) ──► ready-for-agent + afk + mode:* ──► [GATE]
                                                          │
                          ┌───────────────────────────────┼───────────────────────────────┐
                          ▼ (escalate)                     ▼ (stuck)         ▼ (review maxout)
                    awaiting-answer                   agent-stuck         review-maxed
                          │  ◄── ralph-answer ──────────────┴───────────────────┘ (heal)
                          ▼ (resume)
                    ready-for-agent ──► … ──► PR merged + issue closed   [SUCCESS — no label]
```

Retired: `needs-human` (superseded by the three precise states). `hitl` excludes
an issue from the gate. `ready-for-human` is a triage outcome, not a loop state.

`daemon-anomaly` is the daemon-side human-attention label, surfaced from two paths
that converge on the same state. The reconciler labels an issue it could not even
*claim* after `maxClaimFailures` consecutive ticks (a git/gh fault, not an agent
stuck on the task — legacy issue 28); the completeness pass (§9a) labels any island it
cannot classify (legacy issue 27). Like the three escalation states it excludes the issue
from the gate, so a persistently-unactionable issue stops being retried every tick
and starving the scheduler; a human clears the cause and re-labels `ready-for-agent`
to re-admit. The fresh-claim worktree reset (a pre-existing `ralph/<n>` branch is
reset, not collided with) and the startup orphan sweep keep the claim path from
firing on the common re-pickup case.

## 9a. The completeness invariant — no silent loss (legacy issue 27)

The defence against *silently* losing work is distributed: many code paths must
each set/clear the right label + run status so the reconciler keeps acting on an
issue. Whenever an issue lands in a (label set × run status) combination that **no
path classifies**, it becomes a silent **island** — acted on by nothing, seen by no
one. Under auto-merge (§5, [ADR-0009](adr/0009-auto-merge.md)) every island is
silent until a human happens to look; the original build shipped two (legacy issue 8 —
a crash abandons in-flight runs; legacy issue 9 — an answered `review-maxed` heal nothing
resumes). Point-fixing islands does not prevent the next one, so the daemon makes a
dead state impossible to *hide*, always visible within one tick:

1. **Completeness invariant** (`src/daemon/completeness.ts`). Each tick a single,
   **total** pure function classifies every OPEN issue and every non-terminal run
   row into exactly one of `{eligible, in-flight, awaiting-human, terminal}`.
   Anything that falls through, or any contradiction — `ready-for-agent` + a
   non-re-admittable run row, a `running` row the daemon isn't executing, a
   non-terminal run whose issue is closed, an answered pause nothing can resume, a
   human-attention label with no run/question to resume, an in-flight run wedged past
   its lifetime ceiling (the wall-clock failed to settle it) — is **surfaced**: a
   `daemon-anomaly` label + a structured `daemon.anomaly` log. Unknown state becomes
   a *visible* anomaly, never a silent island; the label clears automatically once
   the issue is no longer anomalous. **`daemon-anomaly` is a human-attention
   state** — the reconciler advances nothing in it; a human reads the anomaly reason
   and repairs the underlying state (or closes the issue).

2. **Orphan / liveness sweeper.** A periodic GC (every tick) that auto-remediates the
   **slot-safe** cases — a `running` row the daemon isn't executing (re-drive or
   terminate), a non-terminal run whose issue closed under it (terminate + prune), an
   in-flight run wedged past its lifetime ceiling (terminate via the executor's abort
   handle), a tracked worktree no live run/agent references (prune), and — in
   `container` mode (ADR-0038, legacy issue 219) — a running `ralph-*` container backing no live
   run (`docker stop` it; enumerated from `docker ps`, so a daemon crash / lost run row
   that strands a container is reaped without in-memory state). It composes with
   the startup reconcile (§1, legacy issue 8) — the same orphan pass, now run continuously, not
   only at boot. The per-session wall-clock (§3, legacy issue 13) is the primary settle
   mechanism; should it fail, a run wedged past its lifetime ceiling is **actively
   terminated** (legacy issue 61): the sweep asks the executor — the single owner of the run's
   session-kill handle — to abort the run's live session, which terminalizes it to
   `agent-stuck` and frees the slot through `occupySlot`'s single owner once the killed
   session settles (never a second writer to the in-flight map, so the "single home"
   cap-accounting invariant holds, and the slot is never freed while the session is
   alive). It is *surfaced* as a `daemon-anomaly` (part 1) the whole time it settles,
   then the label self-clears.

The invariant now holds **per repo**: each reconciler classifies only its own
repo's issues + runs, guaranteed by the **ScopedStore** (`store.forRepo(repo)`) —
a repo-bound view that can never return another repo's run for a colliding issue
number, even though issue numbers are not unique across repos.
`classifyIssueState` stays total and pure
([ADR-0020](adr/0020-multi-repo-orchestration.md)).

The classifier is pure so the guarantee is matrix-tested against the full state
space (`src/daemon/completeness.test.ts`) and guarded against regression as the
daemon self-modifies. **This invariant is the completion criterion for unattended
auto-merge** (OPERATING.md): merging without a human in the loop is only safe while
every open issue is provably *being worked, visibly waiting on a human, or
terminal* — never silently dropped.

## 10. Open workstreams (not yet built)

1. **Fork + adapt Matt Pocock's skills** → a maintained skills fork, customised
   to this label vocabulary (heavy: `triage`, `setup`; medium: `to-issues`,
   `to-prd`, `implement`, build a new `address-review`; light: the rest). The
   design machine then pulls them. Deferred until the label set froze — it now has.
2. **Scaffold the TS project** — daemon, executor, SQLite schema, the `escalate`
   tool, the two CLIs.
3. **Prompt templates** — `implement` (tdd / infra), `review` (phase 1 / phase 2),
   `address-review`, all embedding the no-deferral rule **and** the
   design-authority rule (ADR-0011); Phase-1 review flags any diff that deviates
   from a binding decision without an escalation.
4. **`.ralph/config.yaml`** for the target (build/test commands, cap, timeouts).
5. **Pilot** against `acme/example-monorepo`.

## 11. Self-update — drain → rebuild → restart via supervisor (legacy issue 30)

The daemon adopts new commits on its own branch — its auto-merged fixes or operator
pushes — without a manual stop → pull → build → restart, and **without abandoning
in-flight runs**. The mechanism is unchanged under multi-repo: there is exactly
**one** self-update checker, over the daemon's **own** repo, owned by the
**Orchestrator** and independent of which targets it works (ADR-0020). A Node
process cannot cleanly `exec`-replace itself, so the concern is split
([ADR-0018](adr/0018-self-update-supervisor.md)):

- **Daemon — detect + drain.** Every `selfUpdate.checkEveryTicks` ticks the
  Orchestrator `git fetch`es the daemon's *own* repo and compares local HEAD to
  `origin/<branch>` (`GitUpdateChecker`, `src/daemon/self-update.ts`); a local-only
  commit is *ahead*, not behind, and does not trigger. On a real update it requests a
  restart: `runForever` stops starting/resuming agents, drains in-flight runs through
  review + merge (the graceful-drain core, legacy issue 35), then exits the dedicated
  **restart code 75** (`RESTART_EXIT_CODE`). A check error fails *safe* — log and
  skip, never restart on a flaky fetch.
- **Supervisor — rebuild + restart, outside the daemon.** `ops/ralph-supervisor.sh`
  (kept alive by `ops/ralph-supervisor.service`, `Restart=always`) runs the daemon in
  the foreground. On exit 75 it pulls + (`npm ci` only if the lockfile changed) +
  builds **while the daemon is down** (no partial state), then relaunches.

**Build-gate + rollback + quarantine.** A failed build — or a fresh launch that
crash-loops inside the health window — never relaunches broken code: the supervisor
restores last-good (`git reset --hard` + rebuild) and surfaces a `daemon-anomaly`.
Build-gate + rollback alone don't *converge* — the daemon, back on last-good,
re-detects `origin` ahead and re-drains every cycle — so the supervisor and daemon
share a `.ralph/quarantine` record: the supervisor writes the failed remote sha; the
daemon treats a remote HEAD equal to it as *not behind* (no drain) and clears it once
origin advances past the sha. A bad commit can no longer wedge an unattended box.

Off by default (`selfUpdate.enabled: false`); a bare daemon that exits 75 with no
supervisor simply stops. A forced (timeout) restart is safe: startup rehydration
re-derives in-flight runs from GitHub ([ADR-0003](adr/0003-reconciler-poll.md), §1/§7),
so nothing is abandoned. Operator runbook: [SELF-UPDATE.md](SELF-UPDATE.md).

## 12. Master-escalation foundation — native hierarchy zoom-out + decision ledger (issue #41)

Every agent so far reasons from **one issue and one run**. That is right for a
worker and wrong for the high-tier *master escalation* agent later slices need: one
that can see where an issue sits in a programme and what has already been decided
above it, from a fresh session, with no conversational memory. This section is the
substrate for that — it changes no existing behaviour ([ADR-0040](adr/0040-native-hierarchy-and-decision-ledger.md)).

**The hierarchy is GitHub's native parent/sub-issue graph, and nothing else.**
Depth is unbounded by product semantics: there is no "epic level", and a prose
heading ("epic", "master epic", "wayfinder") is how a human *narrates* structure, not
a contract — the word lands at whatever depth the author felt like and drifts as
tickets are re-parented. `readIssueHierarchy` reads the graph through GraphQL
(`Issue.parent`, `Issue.subIssues`), the only surface that answers "who is this
issue's parent?", and every node carries its own `repository { nameWithOwner }`, so a
cross-repository hierarchy is represented rather than flattened. Because issue
numbers collide across repos, every surface here keys on `IssueRef`
(`owner/repo` + number), not a bare number.

**Never a false root** (`src/hierarchy/map.ts`). `RootResolution` has exactly one
variant meaning "this is the absolute root", reached only when GitHub itself reports
no parent. A **cycle**, an **over-ceiling** chain (`HIERARCHY_DEPTH_CEILING` = 32, a
technical safety stop that names the ancestor it stopped before — never a silent
truncation), a **deleted** parent, and an **unauthorized** parent are each their own
typed outcome. This is load-bearing rather than tidy: an unreadable parent collapsed
into "no parent" would plant an initiative-scoped decision, or the root index, on a
node that merely looked like the top. Callers that need the root go through
`absoluteRoot(map)` and fail closed on `null`.

**Context assembly is two-pass and budgeted** (`src/hierarchy/context-packet.ts`).
Pass one builds the compact map from body-less reads, so every sibling branch is
*visible* for one line's cost. Pass two fetches bodies and comments only for the
nodes it selects — origin, ancestors nearest-first, direct children, plus explicit
extras — so a sibling's body enters a packet only when something asks for it by name.
The budget is a plain **character** count (tokenizer-independent, so it means the
same thing across providers, and a constant rather than a config key — see the
compatibility note below); selection order is fixed and every child listing is
sorted, so the same hierarchy yields a byte-identical packet. When the budget binds,
the packet names what it trimmed and what it dropped.

**Decisions live on the narrowest node matching their scope** (`src/ledger/`).
`issue` → the issue; `subtree` → the subtree root it governs; `initiative` → the
absolute root. A descendant loads the fold along its entire root→issue ancestor path,
so inheritance falls out of the hierarchy instead of a rule to get wrong: a sibling
subtree's decisions are simply not on the path. Canonical records are **append-only**
`ralph-decision` fenced comments through the same shared codec as `ralph-question` /
`ralph-review`; a later record **supersedes** an earlier one **by id**, never by
recency, and the superseded comment is never edited.

**Conflicts and malformed records fail closed and stay visible.** Two active records
claiming one key with no supersession between them do not resolve to a winner: the
key drops out of the active fold and both claims surface with their node and comment
id for a later master or human to adjudicate — guessing would pick an architecture on
a timestamp. A fenced-but-unparseable comment is a diagnostic, not state; an ordinary
comment that merely *discusses* a decision, or pastes one in a ` ```json ` block, is
never parsed as one (extraction is anchored on the fence tag).

**One derived index on the absolute root.** A single daemon-managed
`ralph-decision-index` comment lists active decisions with source links back to their
canonical records. It is a *view*: regenerated from the records, byte-identical on an
unchanged ledger (nothing time-varying is rendered, so an unchanged ledger performs
**no write**), found by its fence tag and edited in place so a restart cannot plant a
second one, and safe to delete.

**GitHub stays authoritative; there is no SQLite here.** Every read walks canonical
comments, so "delete the local database" is not a recovery scenario but the normal
path — the same rebuildable-store guarantee as §1/§7
([ADR-0003](adr/0003-reconciler-poll.md)/[ADR-0021](adr/0021-event-sourced-actual-state.md)).
A projection may be added later purely as a cache; **no decision may ever exist only
in it.** Payload evolution follows
[ADR-0026](adr/0026-event-schema-evolution.md): the record schema is a *loose* object,
so a field a later slice adds parses, round-trips, and is preserved.

**Compatibility.** No new config key: the budget and ceiling are constants with
per-call overrides. A daemon-only field on the mounted config would re-run the
unknown-keys-rejected failure documented in issue #19 against stale container
runners, for no benefit this slice needs.

Deliberately **out of scope**: running a master agent, its prompt, any change to
worker `escalate`/`stuck` behaviour or the human-attention labels, persisting
free-form master conversation history, and any inference of hierarchy from prose.

---

## 13. Master escalation — complexity-1 adjudication before human attention (issue #42)

Slice §12 built the substrate and ran nothing on it. This section runs the first thing:
worker-origin `escalate` and `stuck` are adjudicated by a fresh, highest-tier **master**
before an operator is asked anything. The binding decisions are
[ADR-0041](adr/0041-master-escalation-complexity-1-adjudication.md); this is the shape.

### 13.1 What the two worker exits now mean

`escalate` means **internal escalation to the master**, not "ask the human". Its schema,
its quality bar ([ADR-0015](adr/0015-escalation-quality-bar.md)) and its worker-facing
description are unchanged — only its destination is. `stuck` stays a *distinct signal*
("execution budget exhausted" rather than "I need a decision"), because that distinction
is genuine evidence for the master; it enters the same queue and, crucially, **preserves
the WIP** instead of discarding it.

Both exits: checkpoint the branch (commit + push, ensure the draft PR), promote the issue
to `complexity:1` in one atomic label patch, post a fenced `ralph-master-request` carrying
the worker's payload/recommendation/attempted fixes/uncertainty and the normalized failure
signature, append `MasterTriageRequested`, and return. **No `ralph-question`, no
`awaiting-answer`, no `agent-stuck`.** The worker frees its ordinary slot; nothing is
reserved and nothing is handed over.

### 13.2 Scheduling

The run projects to `master-triage` — a run status and a daemon-owned label delivered by
the ADR-0027 outbox like every other state effect. It is an **automated in-flight** state:
excluded from ordinary admission, classified as `in-flight` by the completeness pass, never
`awaiting-human`. The daemon is working; nobody is being paged.

Each tick, **before** `admit` computes open slots, the reconciler services the queue: take
the oldest queued escalation, acquire the **one process-wide master lease**, and run it on
an ordinary build slot. Three properties fall out: master work outranks fresh admission (an
already-worked, checkpointed run is worth more than one not yet started); total sessions
never exceed `scheduler.maxConcurrentAgents`; and a second queued master simply waits —
the tick proceeds and ordinary admission fills the remaining slots as usual. V1 serializes
masters **globally**, across repos, so two masters can never race the §12 decision ledger
into a fail-closed conflict.

### 13.3 The master's route, and why it fails closed

The master route is derived from `agent.tiers["1"]` — there is deliberately no
`agent.types.master` key (V1 avoids re-running the mounted-config schema skew of issue
#19). Tier 1 is now the **governing** tier: its profile applies to every subsequent lane
for the promoted issue — impl, resume, review, fix, master — amending
[ADR-0039](adr/0039-complexity-tier-agent-profiles.md)'s impl-only rule. Tiers 2 and 3 stay
impl-only, so ordinary issues keep the uniform review/fix routing that makes unattended
merge safe ([ADR-0014](adr/0014-harness-owned-ci-gated-rebase-aware-merge.md)).

The tier→model mapping is **binding**: `complexity:1` → `claude-fable-5`, `complexity:2` →
`claude-opus-5`, pinned in the shipped example config and in routing tests.

A missing or non-tools-capable tier-1 profile is a **configuration defect**, not a wait: the
engine refuses to dispatch, surfaces a `daemon-anomaly` naming the defect and the fix, and
**consumes no intervention budget**. It never falls back to a cheaper master — a master
weaker than the worker that escalated to it would burn an intervention, produce a confident
wrong adjudication, and hide the misconfiguration.

### 13.4 What the master sees, and what it must produce

Every invocation is a fresh session ([ADR-0008](adr/0008-oauth-fresh-context.md)). Its
context packet carries four layers: the worker's evidence (labelled **as a recommendation**,
before any instruction to act on it); the run's actual state (issue, phase, branch, head SHA,
WIP status/diff, PR and checks, fix counts, recent log events); the §12 zoom-out (hierarchy
map, budgeted context packet, inherited **active** decisions); and what has already been
tried (prior interventions with their resolutions, whether this signature is a *repeat*, and
the remaining budget). Reads are tolerant — a failed read becomes a stated gap in the packet,
never a skipped intervention.

The master must state its **own** conclusion and rationale; the outcome schema requires both
on every arm, so "agreed" is not expressible. It produces exactly one of:

| outcome | what happens |
| --- | --- |
| `resolved-and-continue` | the repair/guidance is injected and the interrupted phase re-enters |
| `redispatch-tier-1` | a fresh tier-1 worker resumes the preserved WIP branch with the master's brief |
| `retry-pipeline` | one typed harness action re-runs (`ci` / `review` / `merge` / `reconcile`) — the gate runs again, it is never skipped |
| `ask-human` | a structured `ralph-question` is posted and the run enters `awaiting-answer` |
| `terminal-stuck` | a self-explaining card, then terminal `agent-stuck` |

`ask-human` is the **only** path in this slice that creates a human question, and answering
it resumes the **master**, not the original worker.

### 13.5 Capability, and the invariants it does not buy

The master may inspect and edit the exclusive WIP worktree, run commands and tests, commit
and push the issue branch, inspect GitHub/CI, publish scoped decisions, and delegate a fresh
tier-1 worker. Capability is the point.

Four invariants are non-bypassable, and are so *because* the master is the strongest model —
an agent smart enough to argue itself into merging its own repair is the one that most needs
a mechanical stop: no direct merge or issue close; no CI bypass; no force-push, destructive
git, or any branch but the issue's own; no host/supervisor control. Enforcement is two-sided:
the merge/close capabilities are simply **not wired** into a master session, and a
`PreToolUse` guardrail hook (advisory, exactly like §8's git guardrails) denies the commands
with a reason the master can act on. Repaired work re-enters the ordinary CI/review/merge
pipeline.

### 13.6 The loop budget

At most **two** interventions per run phase; a third cannot launch (the harness posts a
readable card and terminalizes). A repeated **normalized failure signature** forces final
adjudication: the master may not repeat a resolution already tried for that signature, and
the harness re-checks its answer — a forbidden repeat is coerced to a human question rather
than executed. The signature erases SHAs, timestamps, paths, line numbers and counters, so
**a changed head SHA alone never makes a failure new**. A genuinely new run span resets the
per-run budget; the prior history stays in context.

A human answer **re-opens the same numbered attempt** once — spending no fresh budget,
because answering the second intervention's question would otherwise land straight on the
ceiling and throw the answer away — and that resumed master may not ask again. Ask → answer
→ ask cannot cycle.

### 13.7 Durability and compatibility

Master queue and attempt state are append-only issue-stream facts; GitHub stays desired-state
truth. The `master-triage` label says *that* an escalation is queued and the
`ralph-master-request` comment says *what* must be adjudicated, so a cold store rehydrates
exactly one pending intervention and duplicates no session or decision comment. Published
decisions carry deterministic ids, which the §12 fold collapses on a replayed re-post.

Container dispatch/result schemas grow additively (`kind: "master"`, `escalationMode`, the
`master` result frame). Because a stale runner *ignoring* `escalationMode` would post a human
question the daemon never asked for, the master path is gated on a **declared runner
capability**: the image stamps `io.ralph.runner-capabilities`, the daemon reads it
pre-dispatch, and a stale image fails with one precise, actionable error naming the missing
capability — never a generic no-result → review-maxed cascade. The onboarding smoke test gates
on the same label.

Deliberately **out of scope**: automatic triage of `review-maxed`, CI/merge/rebase failures
and daemon anomalies (the next slice); direct master merge/close; host recovery; persistent
conversational memory; parallel master sessions.
