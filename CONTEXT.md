# ralph-autopilot

The shared language of the autonomous-implementation daemon. These are the terms
that mean something specific *here* — general programming concepts are omitted on
purpose.

## Language

**Daemon**:
The single long-lived process that orchestrates everything. A reconciler, not an
event handler. It works a *set* of target repos via the [[orchestrator]].
_Avoid_: server, service, worker.

**Orchestrator**:
The process-level loop (`daemon/orchestrator.ts`) that drives **one
[[per-repo-reconciler]] per target** each tick — sequentially and awaited — and owns
the concerns that must be singular: the tick cadence, the cross-repo drain, the one
self-update checker over the daemon's *own* repo, and the exit outcome. It never
touches issue-keyed state, only the loop and aggregate counts. Distinct from the
[[supervisor]] (the ops restart wrapper *outside* the daemon) and from a single
reconciler (which reconciles *one* repo). (ADR-0020.)
_Avoid_: scheduler, dispatcher, manager.

**Per-repo reconciler / tick engine**:
One `Reconciler` instance bound to a single [[target-repo]] — its own GitHub client,
clone + worktree root, base branch, executor, review loop, and [[merge-lease]], plus
its own in-flight / merge-in-flight maps. Because issue numbers are not unique across
repos, this per-repo isolation is what keeps the [[completeness-invariant]] correct.
The [[orchestrator]] runs N of them, all sharing the [[global-build-budget]] and one
store. "The reconciler" still means this per-repo engine; the process-level loop is the
orchestrator.

**Reconcile tick**:
One pass of the daemon's 30-second loop: the orchestrator drives every [[per-repo-reconciler]]
in turn, each diffing desired state (GitHub labels) against actual state (SQLite +
running agents) for its repo and acting on the difference.
_Avoid_: poll cycle, cron run.

**Global build budget**:
The one `scheduler.maxConcurrentAgents` cap shared across *all* repos — the operator's
Claude plan budget (total concurrent agents on the box), not per repo. Each reconciler
reads it live; free slots are `cap − Σ all repos' in-flight build runs`. The
single-concurrency [[merge-lease]] is **not** counted against it (it stays free per-repo
concurrency, ≤1 per repo), so peak agents = `cap + (repos currently integrating)`.
(ADR-0020 refining ADR-0017.)
_Avoid_: per-repo cap, slot pool (when you mean the shared cap).

**Scoped store**:
The per-repo view of the one shared SQLite store, obtained via `store.forRepo(repo)`
(`ScopedStore`). Issue-number-keyed reads/writes auto-inject the repo, so a reconciler
can never see another repo's run for a colliding issue number — the load-bearing
guarantee for the [[completeness-invariant]] under multiple repos. id-keyed tables
(by globally-unique autoincrement run id) need no scoping. Each [[per-repo-reconciler]]
is handed a scoped store, never the raw one. (ADR-0020.)
_Avoid_: repo filter, tenant store.

**Desired state / actual state**:
Desired state is what GitHub's labels say should be true; actual state is what the
daemon has done — the fold over the [[event-log]]. The daemon's only job is to make
actual converge on desired. GitHub is the source of truth for desired state; the
[[event-log]] is the working source of truth for actual state and is reconstructible
from GitHub on catastrophic loss (ADR-0021).

**Event log**:
The append-only stream of the daemon's own decisions ([[domain-event]]s), stored via
the per-repo [[scoped-store]] (Emmett, SQLite backend — ADR-0023). The working source
of truth for actual state; [[projection]]s fold over it. Durable but not precious — on
catastrophic loss, current state re-derives from GitHub (ADR-0003/0021), losing only
the decision history, never correctness.
_Avoid_: event store, journal, WAL.

**Domain event**:
One immutable, past-tense fact about actual state — `RunStarted`, `Escalated`,
`FixAttempted`, `Merged`. The unit of the [[event-log]], folded into [[projection]]s.
Distinct from a `run_log` entry (observability, never folded). Modeled as a business
fact, never a CRUD `StatusChanged` (ADR-0024).
_Avoid_: message, command, log entry.

**Projection**:
A read-model folded from the [[event-log]] — the current-state views (`runs`,
fix-attempt counts, resume context) the reconciler reads each tick. Updated inline, in
the same SQLite transaction as the append; rebuildable by replay (or from GitHub if
the log is lost). Run status and fix counts are *derived* here, never stored.
_Avoid_: read model, materialized view, cache, snapshot.

**Stream**:
The per-issue, repo-scoped event sequence (`<repo>#<issue>`, aligning with
`UNIQUE(repo, issue_number)`) — the aggregate and consistency boundary, guarded by an
expected-version check. A *run* is a `RunStarted … RunEnded` span within it; `runId` is
a correlation tag, not a durable identity. Daemon-lifecycle events use a separate
**system stream**. (ADR-0022.)
_Avoid_: partition, topic, channel.

**Intake / Effect**:
The two sides of the desired/actual split. *Intake* turns an observed human-set GitHub
change into [[domain-event]]s (poll-based, behind the `gh` ACL; pluggable for future
webhooks). *Effect* is the reverse — a daemon-set label swap or comment projected from
an event, delivered by the reconciler as an idempotent outbox (ADR-0027). Human-set
labels are intake; daemon-set labels are effects (ADR-0024).
_Avoid_: ingestion, sync (for intake); side effect (for effect).

**Admission**:
The single decision of *which* open issues to launch this tick, and in what
order — one deep module (`admit`) behind one call. It folds together the
eligibility gate (the label condition), the in-flight / active-run exclusions,
the per-tick dependency cache, and the ordered fill of the open slots. The
reconciler injects the world it reconciles against (the in-flight test, the run
lookup, the GitHub dependency port, the open-slot count, the priority labels)
and launches the plan it returns.
_Avoid_: scheduler, selector (when you mean the whole decision).

**Launch plan**:
What `admit` returns: the ordered, slot-capped `picked` issues to launch, plus
the `excluded` list — every issue dropped this tick with its reason
(`not-open` … `blocked`, plus `in-flight` and `held`).

**Eligibility gate**:
The label condition at the heart of admission: `OPEN` + `ready-for-agent` +
`afk` + not `hitl` + not paused + carries a mode + all `## Blocked by`
dependencies satisfied. An internal seam of admission, not a standalone surface.

**AFK issue**:
An issue an agent can carry to completion with no human checkpoints — marked
`afk`. Its opposite is `hitl` (human-in-the-loop required), which the gate
excludes.

**Mode**:
How an issue is implemented, stamped at triage as a label — a **verification
contract**, never a domain tag. `mode:tdd` (default, red-green-refactor, tests
gate the build), `mode:infra` (no-code / no-test work where tests don't apply —
the build+test gate is replaced by a mode-appropriate verification), or `mode:ui`
(view-layer work: build gate + tests only where sensible; verification is
*rendering* — headless-chromium screenshots delivered to the PR body via net-zero
branch commits, so the squash lands no screenshot files). `mode:ui` is
operator-applied only (the moding pass never stamps it) and presumes a
chromium-equipped target image.
_Avoid_: type, kind, category, and domain modes (`mode:frontend`, `mode:marketing`).

**Complexity tier**:
How demanding an issue is, stamped as an operator-applied `complexity:1|2|3` label —
lower = more demanding (the `priority:p0` convention): `1` = hard/architectural, `2` =
standard, `3` = routine/mechanical. Selects the per-tier **agent profile**
(`agent.tiers`: impl routes + effort + wall-clock) at impl dispatch. Deliberately NOT
part of the eligibility gate: an unlabeled issue runs on the globals — never a stall —
and duplicate labels resolve by precedence to the most demanding tier. Impl-only;
review/fix stay uniform (ADR-0014). (Issue legacy issue 278, ADR-0039.)
_Avoid_: difficulty, size, priority (that's `priority:p0/p1` — orthogonal).

**Moding pass** (auto-mode):
The opt-in, per-target pass that fills the one gap the eligibility gate cannot
fill itself: an issue an operator marked `ready-for-agent` + `afk` but never
stamped with a **mode**. Each tick it finds the OPEN issues the gate rejects
*solely* for a missing `mode:*` label, runs a bounded, fresh-context SDK
classification per issue, and applies the chosen `mode:tdd` / `mode:infra` label
— so the issue becomes eligible next tick. It supplies the missing label and
nothing else: it never triages *what* gets worked (a human marked it ready), and
the tdd-vs-infra rubric stays harness-owned. Off by default; a no-op when off.
_Avoid_: triage, auto-triage, classifier (when you mean the whole pass).

**Worktree**:
A per-issue git worktree (`ralph/<n>-<slug>` branch) that isolates one agent's
working tree from the others while sharing one clone's object store. One agent,
one worktree.

**Escalate**:
The custom tool an agent calls when it needs a human decision. Asynchronous: it
checkpoints the agent's work, writes a structured question to GitHub, frees the
slot, and exits. It is **not** Claude's built-in `AskUserQuestion` and must never
be conflated with it.
_Avoid_: ask, AskUserQuestion, ask-user, prompt-the-user.

**ralph-question / ralph-answer**:
The two fenced comment formats on a GitHub issue. `ralph-question` is the
structured escalation an agent writes (headline, feature, where-we-stand,
decision, options, stakes, recommendation). `ralph-answer` is the human's reply,
written by the `ralph-answer` CLI.

**ralph-review**:
The fenced comment format that carries a review pass's deduped worklist on the
**PR** — the review→fix handoff (legacy issue 47). One *rolling* comment per phase, edited
in place as fix attempts resolve items and recovered-by-id so the build review and
the ADR-0017 integration re-review converge on one comment, not a duplicate. The fix
agent reads it back as the source of truth, next to the bot/human comments it already
ingests. It round-trips through the same shared fenced-payload codec as
`ralph-question`. _Avoid_: review comment, worklist comment (when you mean this
specific format).

**Stakes**:
The required field on every escalation that translates a technical decision *up a
level* — its architecture-level and user-facing consequences — so the operator can
rule on it without reloading the deep technical context. The attention of the
operator is the system's scarcest resource.

**Worklist**:
The consolidated, deduplicated, severity-ranked output of a review pass — the
review agent's own findings merged with ingested automated PR comments, each item
tagged `P0 | P1 | nit | out-of-scope | escalate`. The single thing a fix agent
consumes.
_Avoid_: findings, comments, review results (when you mean the merged list).

**Phase-1 review / Phase-2 review**:
The two review steps. Phase 1 is the *normal* code review (correctness, security,
spec-match, conventions, tests — the AGENTS.md P0 lenses). Phase 2 is the
*behaviour-conserving* thermo-nuclear pass (structural quality — the AGENTS.md P1
lenses), run only after behaviour is verified correct.

**Fix attempt**:
One review→fix cycle inside a phase. Each phase allows at most three. A phase
passes the instant a review returns no `P0`/`P1` blockers.

**Review-maxed**:
The state when a phase exhausts its three fix attempts still blocked. Surfaces a
heal-card and stops (Phase-1 maxout never enters Phase 2).

**Heal-card**:
A `ralph-question`-shaped escalation emitted on `review-maxed` (or any paused run)
that a human answer can re-enable. To *heal* a run is to answer it so the daemon
resumes the agent with that guidance injected.

**Stuck budget / agent-stuck**:
The bounded-effort escape: an agent self-stops (no PR, `agent-stuck` label) after
too many fix iterations on the same failure, too many edits without a green build,
or self-judged futility. Distinct from `review-maxed` (which has a PR).

**Completeness invariant**:
The structural guarantee that no work is *silently* lost. Each tick the reconciler
classifies every open issue and every non-terminal run into exactly one of
`{eligible, in-flight, awaiting-human, terminal}`; anything unclassifiable or
contradictory (an **island** — a state acted on by nothing) is surfaced as a
`daemon-anomaly`. It is the completion criterion for unattended auto-merge
(DESIGN §9a, [[design-authority-rule]] sibling on the safety side).

**Island**:
A (label set × run status) combination that *no* reconciler path acts on — acted on
by nothing, seen by no one. Under auto-merge an island is silent until a human looks.
The completeness invariant makes every island visible within one tick.

**daemon-anomaly**:
The single human-attention label the daemon applies whenever *it* — not an agent —
needs a human, surfaced from two paths that converge on the same state. The
completeness pass labels any island or contradiction it cannot resolve (legacy issue 27);
the reconciler labels an issue it could not even *claim* after `maxClaimFailures`
consecutive ticks (a git/gh fault, legacy issue 28). Peer to `agent-stuck` /
`awaiting-answer` / `review-maxed`, it excludes the issue from the gate, and the
daemon advances nothing in this state: a human reads the logged anomaly reason and
repairs the underlying state (or closes / re-labels `ready-for-agent` to re-admit).
The completeness pass self-clears the label once the issue is no longer anomalous —
except where it is the sole surface of a deliberately-parked claim anomaly. The
worktree idempotency (resetting a pre-existing `ralph/<n>` branch on a fresh claim)
and the startup orphan sweep keep the claim path from firing on the common
re-pickup collision.

**Resume, not restart**:
A paused agent (escalate / heal) continues from its checkpointed WIP branch with
the answer injected — it does not start over from a clean tree. Preserves work and
decision continuity.

**Self-update**:
The daemon adopting new commits on its *own* branch — its auto-merged fixes or an
operator push — without a manual stop → pull → build → restart and without
abandoning in-flight runs. The daemon detects it is behind `origin/<branch>`, drains
(starts nothing new, lets in-flight runs finish), and exits the restart code so
the [[supervisor]] rebuilds and relaunches it. Off by default (ADR-0018).
_Avoid_: hot-reload, auto-upgrade, self-exec.

**Supervisor**:
The thin wrapper *outside* the daemon (`ops/ralph-supervisor.sh`, kept alive by
systemd `Restart=always`) that runs the daemon in the foreground and, on the restart
code, performs the pull + build + relaunch **while the daemon is down** — owning the
build-gate and rollback. A Node process cannot cleanly rebuild and re-`exec` itself;
the supervisor is the half that can. Distinct from the daemon, which only detects and
drains.
_Avoid_: watchdog, init, daemon (when you mean the wrapper).

**Restart code (75)**:
The dedicated process exit code (`RESTART_EXIT_CODE`, EX_TEMPFAIL) the daemon uses to
ask its supervisor to pull + build + relaunch — a distinctive "restart me for an
update", never a generic crash. The daemon and the supervisor script hardcode the
same value.
_Avoid_: error code, crash code.

**Quarantine (record)**:
The shared file (`.ralph/quarantine`) by which the supervisor and daemon converge on a
persistently build/health-failing commit. On a build-gate or health-check failure the
supervisor writes the failed remote sha; the daemon's update checker treats a remote
HEAD equal to it as *not behind* (no drain), and clears it once origin advances past
the sha (a fix landed). Without it a single bad commit traps the box in an endless
drain → rebuild → rollback thrash.
_Avoid_: blocklist, denylist, ban.

**No-deferral rule**:
A standing prompt convention: agents never end with hedging tails ("one thing I
didn't do / we should defer X"). Either it matters → `escalate`; or it doesn't →
do it. There is no "deferred items" field in any output contract.

**Design-authority rule**:
The standing prompt convention that the design of record — the ADRs, `DESIGN.md`,
and this glossary — is **binding**, not advisory. When faithful implementation
hits an obstacle (a dependency conflict, a missing or awkward API, an ambiguity),
an agent must resolve it *in the direction the design already committed to* — it
must **not** silently substitute a different architecture, library, or approach to
route around it. If a binding decision genuinely cannot be honoured, the agent
[[escalate]]s rather than deviating. A drift the agent merely *mentions* is still
a drift. (Origin: a build agent once proposed swapping the Agent SDK for CLI
shell-out to dodge a zod-version conflict — see ADR-0010/0011.) Every `implement`,
`review`, and `address-review` prompt template embeds this rule alongside the
[[no-deferral-rule]].

**Target repo**:
**One of the set** of repos the daemon operates *on* (e.g.
`acme/example-monorepo`), each configured under `targets: [...]`. Distinct
from this repo, which is the daemon itself and is generic over targets. The daemon
works several at once — one [[per-repo-reconciler]] each — under one [[orchestrator]].
_Avoid_: the target, the repo (when the daemon works more than one).

**Account**:
The unit of the credential pool — one credential the daemon can run a session on:
`{ id, provider, <auth> }` and **no model**. Auth is provider-shaped (`configDir` for
Claude, `authTokenEnv` for z.ai, `codexHome` for Codex), abstracted behind one "bind
this account to a session" operation. The pool is flat and arbitrary: N per provider,
including zero. Generalises ADR-0028's two-Claude-login list. (ADR-0037.)
_Avoid_: subscription (the generic unit), login, key.

**Provider (kind)**:
A backend kind, not a credential: an auth style + how it is reached (native SDK, or an
Anthropic-compatible endpoint) + a **`toolsCapable`** flag. `claude` and `zai` are
tools-capable; `openai` (bare Codex SDK) is not yet. [[Account]]s are instances under a
provider and inherit its capability. (ADR-0033/0037.)

**Route / route resolution**:
A **route** is the concrete `{ provider, model, account }` an agent start runs on.
**Route resolution** produces one **at every agent start** by reading the *current*
routing — never a startup snapshot — walking the agent type's ordered `(provider, model)`
preference list and picking the first capability-allowed provider with a headroom
account. The extension of ADR-0033's `providerForAgentType`. (ADR-0037.)
_Avoid_: dispatch, dispatcher (CONTEXT reserves against these), scheduler.

**Capability gate**:
The one principled routing constraint: a type may route to a provider iff
`requiresTools(type) ⟹ provider.toolsCapable`. The capability is precisely **in-session
host-callback tools** — the agent calling a custom tool that runs daemon code mid-session
([[escalate]] / `stuck`) — **not** file read/write and **not** MCP boosters. `impl`
requires them; `review` / `fix` / [[moding-pass]] do not. One pure check enforced at
config load, the web edit API, and route resolution. (ADR-0037.)

**no-provider**:
A [[launch-plan]] `excluded` reason: an otherwise-[[eligible]] issue not launched this
tick because no allowed provider has a headroom [[account]]. A **wait, not a stuck** — it
keeps `ready-for-agent`, takes no human-attention label, and is re-resolved next tick
(picked up automatically when a usage window resets). Classifies as `eligible` under the
[[completeness-invariant]], so it is never an island. The per-type, per-pool
generalisation of ADR-0028's global pause. (ADR-0037.)
