# Multi-repo orchestration — one daemon, many target repos, one shared budget

The daemon was generic over *one* target repo (`config.targetRepo`). We need it to
work several at once — the daemon's own repo (self-improvement) **and** the product
repo `acme/example-monorepo` — from one process on one box.

The naïve approach (make every module repo-aware) fights the existing design: the
pure cores (`admit`, `classifyIssueState`) and the per-tick state (`inFlight`,
`mergeInFlight`, the SQLite `runs.issue_number UNIQUE`) all assume **one repo's issue
space**, and GitHub issue numbers are **not unique across repos** (both repos can
have `legacy issue 15`). Any shared keying collides.

## Decision

**One reconciler instance per target repo, orchestrated by a single process loop,
sharing one SQLite store (with a `repo` column) and one global build budget.**

### Per-repo reconcilers, repo-scoped store

Each target gets its own `Reconciler` — its own `GhCliClient` (scoped to that repo),
its own target clone + worktree root, its own base branch, executor, review loop,
and **merge lease**. Its `inFlight` / `mergeInFlight` / `claimFailures` maps are
naturally per-repo, so the collision disappears. The pure cores are untouched (each
reconciler still reconciles one repo's issue set).

The store gains a `repo` column on every issue-keyed table (`runs` swaps
`UNIQUE(issue_number)` for `UNIQUE(repo, issue_number)`; `open_questions`, `run_log`,
and `daemon_snapshot` become per-repo). Each reconciler is handed a **`ScopedStore`**
(`store.forRepo(repo)`) — a view that auto-injects its repo into every
issue-number-keyed lookup. id-keyed tables (`agents`, `fix_attempts`,
`resume_context`, keyed by the globally-unique autoincrement `runs.id`) need no
scoping. This is load-bearing for the completeness invariant (ADR-0016): a scoped
store can never return another repo's run for a colliding issue number, so each
repo's no-silent-loss guarantee holds independently.

### The orchestrator owns the loop

A single `Orchestrator` (`daemon/orchestrator.ts`) owns the process-level concerns
that must be singular: the tick cadence, the graceful drain across *all* repos
(legacy issue 35), the *one* self-update checker over the daemon's own repo (ADR-0018,
unchanged — independent of the targets), and the exit outcome. Each tick it drives
the reconcilers **sequentially and awaited**. The drain pumps every repo's merge
worker and completes only when **every** repo is idle (build pool + merge lease +
`awaiting-merge` queue all empty).

### One global BUILD budget; merge stays free per repo

`scheduler.maxConcurrentAgents` is **one global cap** shared across all repos — it is
the operator's Claude plan budget, which is about total concurrent agents on the box,
not per repo. Each reconciler reads a shared `ReconcileBudget` live: free slots are
`cap − Σ all repos' in-flight BUILD runs`. Because the orchestrator drives
reconcilers sequentially and the budget is read live (Node is single-threaded; the
awaited `claim → occupySlot` increment is atomic), two repos filling in the same tick
can never oversubscribe the cap.

The single-concurrency merge lease (ADR-0017) is **NOT** counted against the build
budget. Gating it by the build cap would regress ADR-0017's "integration always
progresses" property — a single repo at full build cap would never merge. Instead the
lease stays free per-repo concurrency (≤1 per repo, exactly as ADR-0017), so the peak
agent count is `cap + (repos currently integrating)`. With a handful of targets the
overage is small and bounded, and matches ADR-0017's original "build cap + 1 merge"
philosophy — generalised to per-repo.

### Config

`targetRepo` (singular) becomes `targets: [...]`. Each target carries its required
`repo` + build/test `commands`, and may override the daemon-wide `agent` / `merge` /
`review` / `priorityLabels` defaults (deep-merged in `config/load.ts`). Per-target
clone/worktree paths default to `.target-repo/<owner>-<repo>` and `.wt/<owner>-<repo>`
so two targets never collide; `resolveTargets` validates uniqueness. The database and
`scheduler.maxConcurrentAgents` are global. The orchestrator auto-clones a target on
startup if its clone is absent.

### Migration — rebuild from GitHub (leans on ADR-0003)

A migration's static SQL cannot know the legacy single `targetRepo`, so v4 does not
guess: it clears the runtime tables (they are rebuildable) and recreates `runs` with
the `repo` column + `UNIQUE(repo, issue_number)`. On the next boot, each repo's
`rehydrate()` re-derives its in-flight/paused runs from open PRs. Cut over with the
daemon drained (no in-flight work) and nothing is lost — GitHub is the source of
truth (ADR-0003).

## Consequences

- The completeness invariant (ADR-0016) now holds **per repo**, guaranteed by the
  scoped store; `classifyIssueState` stays total and pure.
- The TUI aggregates across repos: running agents / queues / outcomes are global
  lists (keyed by unique run ids), the backlog concatenates every repo's snapshot,
  and the health header summarises all repos.
- Peak concurrency is `cap` build agents + up to one merge per repo. Operators sizing
  their plan budget should account for the small merge overage.
- One process, one PID file, one supervisor — multi-repo is internal to the daemon;
  `ops/ralph-start.sh` / `ralph-supervisor.sh` (which manage the daemon's *own* repo)
  are unchanged.
