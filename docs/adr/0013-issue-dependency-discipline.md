# Issue dependency discipline — author `## Blocked by` to avoid the parallel-edit pileup

**Context.** The daemon runs up to `maxConcurrentAgents` issues in parallel, one
worktree each. On a small shared codebase, N agents that all edit the same files
produce N mutually-conflicting PRs: the first merges, the rest go stale and
conflict. We hit exactly this fanning 10 agents at the ~6k-LOC daemon core
(`reconciler.ts`, `executor.ts`, `review-loop.ts`, `gh-cli.ts`, `store.ts` were
each touched by 3–4 PRs at once). Only the first landed; the rest wedged.

There are **two complementary defenses**, and we use both:

1. **Runtime — the rebase-aware merge (legacy issue 41).** Before merging, the harness
   brings the branch current with base and has a fix agent resolve incidental
   conflicts (or `escalate` if structural). This makes high concurrency
   *self-heal* incidental file overlap. It is the reason we can run at cap 10.

2. **Authoring — this discipline.** When we *create* issues (via `/to-issues`
   or by hand), we encode known-heavy and genuinely-sequential dependencies as
   `## Blocked by #n` so the gate serialises them. The merge step heals
   *incidental* overlap; the author prevents *foreseeable* collisions and orders
   *logical* dependencies. Do not rely on the merge step to untangle a batch that
   was obviously going to collide.

## The rule

When authoring an issue, add `## Blocked by #n` when any of these hold:

- **Foundational / cross-cutting first.** The other issue changes a load-bearing
  contract everything else builds on — block dependents behind it:
  - the **merge / review pipeline** (`review/`, the merge step) — e.g. legacy issue 41;
  - the **reconciler core & eligibility gate** (`daemon/`, `core/gate`);
  - the **store schema / migrations** (`store/migrations`, `store/types`);
  - the **config schema** (`config/schema`);
  - the **agent prompt contracts** (`executor/prompts`, `review/prompts`).
- **Same-subsystem, heavy overlap.** Two issues that will clearly rewrite the
  *same* file/module → chain them (later `## Blocked by` earlier) instead of
  running them together. Use the map below.
- **Logical dependency.** B genuinely needs A's behaviour to exist (A defines the
  label/state/tool B consumes). Always chain these, regardless of file overlap.

When **none** hold — the issues touch disjoint subsystems, or only overlap
incidentally — leave them parallel and let the rebase-aware merge handle it.
Over-chaining serialises the queue and throws away the concurrency we built for.

## Subsystem → files map (consult when judging overlap)

| Subsystem | Files | Notes |
|---|---|---|
| reconciler / gate | `daemon/reconciler`, `core/gate`, `core/slug` | cross-cutting — chain dependents |
| executor | `executor/executor`, `executor/agent`, `executor/worktree`, `executor/wall-clock` | high-traffic |
| review pipeline | `review/review-loop`, `review/sdk-agents`, `review/agents`, `review/prompts`, `review/worklist` | cross-cutting — legacy issue 41 owns it |
| merge | the merge step in `review/` + `github/gh-cli` merge methods | legacy issue 41 |
| HITL | `hitl/*` (escalate, answer, resume, queue, ralph-answer) | |
| store | `store/store`, `store/migrations`, `store/types` | schema = cross-cutting |
| github | `github/gh-cli`, `github/types`, `github/marker` | shared client |
| config | `config/schema`, `config/load` | schema = cross-cutting |
| projection | `projection/*` | isolated — rarely conflicts |

## Consequences

- `/to-issues` (in the maintained skills fork) should reference this ADR when
  emitting a batch: order foundational issues first, chain same-subsystem work,
  leave the rest parallel.
- This is *advisory ordering*, not a hard wall: once legacy issue 41 ships, the steady
  state is **cap 10** and incidental conflicts self-heal. Blocked-by is reserved
  for foundational ordering, heavy known overlap, and logical dependencies.
- Until legacy issue 41 ships the bootstrap merge is direct (no rebase), so the transitional
  posture is **cap 1** (fully serial → zero conflicts) with legacy issue 41 built first.
