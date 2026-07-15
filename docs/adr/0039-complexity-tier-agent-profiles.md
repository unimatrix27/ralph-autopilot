# Complexity-tier agent profiles — `complexity:1|2|3` labels select impl routes, effort, and wall-clock

## Context

Route resolution (ADR-0037) knows the agent *type* — impl, review, fix, autoMode — but
nothing about the *issue*. Every impl run therefore costs the same regardless of whether
the issue is a one-line rename or an architectural change, on one global
`(provider, model)` preference list, one `agent.effort`, and one
`agent.wallClockSeconds`. With three impl-capable model tiers available on the box
(Fable, Opus, GLM via z.ai — legacy issue 278), the operator has no per-issue lever to spend
the strongest model and the biggest budget only where the work demands it.

## Decision

An operator-applied **`complexity:1|2|3`** issue label selects a per-tier **agent
profile** for the issue's impl runs. Decisions, each deliberate:

1. **Lower = more demanding** — `1` = hard/architectural, `2` = standard, `3` =
   routine/mechanical — following the existing `priority:p0` convention, so the two
   label families read the same way.

2. **A tier is an agent profile, not just a route.** `agent.tiers["1"|"2"|"3"]` carries
   optional `routes` + `effort` + `wallClockSeconds`. `routes` replaces the impl
   preference list **whole** (the ADR-0037 legacy issue 169 per-phase merge semantics — never
   concatenation, so a gated tier pool is a `no-provider` wait, not a silent downgrade);
   `effort`/`wallClockSeconds` override the matching globals for the run's session. Every
   field optional; absent fields inherit the globals. Keys are `.strict()` — a `"4"` or a
   typo fails loud at load, and load-time validation walks tier routes exactly like
   base/per-phase routes (capability gate + provider block + account pool).

3. **Unlabeled = the globals, and never a gate condition.** The tier is NOT part of the
   eligibility gate — no repeat of the no-mode backlog stall. "What runs when I do
   nothing" stays readable from one place in the config.

4. **Duplicate labels resolve by precedence** — `readTier` scans `1 → 2 → 3`, most
   demanding wins — the established `readMode`/`pausedStateOf` convention. Label
   sloppiness is never a `daemon-anomaly` (that is reserved for unclassifiable runtime
   state).

5. **Impl-only.** Review/fix routing and budgets are untouched: the review loop is what
   makes unattended merge safe (ADR-0014), and cheap review on "easy" issues is exactly
   where a mislabeled issue would hurt. Tier-aware review is a possible follow-up, with
   evidence.

6. **Resolved daemon-side; the runner applies, never re-derives.** The daemon reads the
   tier from the live labels at dispatch, threads it through route resolution
   (`resolveDispatchRoute(deps, "impl", undefined, tier)`), and rides the resolved
   `effort`/`wallClockSeconds` deltas on the assignment as an additive
   `profile` field. The in-container runner swaps them into its mounted config exactly
   like the route's model override (`withProfileOverride` beside `withModelOverride`) —
   no tier logic, no label read inside the container.

7. **The tier is recorded on the run row** (nullable `runs.tier`, migration v8) as
   non-derived bookkeeping like `branch`, and the dispatched route already carries the
   effective model onto the web route chip (legacy issue 268). The reconciler's queue-wide
   `no-provider` admission wait stays on the base impl route; a tier route with no
   headroom defers per-run via the existing `limited` path.

## Consequences

- The operator labels an issue `complexity:1` and its impl run dispatches on Fable with
  `effort: max` and a 3-hour wall-clock; the same backlog's `complexity:3` chores run on
  GLM at `effort: medium` — with zero change for unlabeled issues.
- The mounted-config schema grows a key, so in-container runners baked into an older
  agent-base reject a config that *sets* `agent.tiers` (unknown-keys-rejected, the legacy issue 270
  outage class). Operational sequencing: land this, rebuild agent-base (the runner ships
  in it), re-key target images via the FROM-pin bump, and only then set `agent.tiers` in
  the live config.
- Per-target tier overrides come free from the existing global + per-target spread-merge
  (a target's `tiers` replaces the whole block, like every array/object agent field).
- The web routing editor (legacy issue 166) does not yet edit tiers; they are config-file-owned for
  now. A follow-up may surface them alongside the per-type lists.
