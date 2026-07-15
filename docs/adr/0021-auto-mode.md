# Auto-mode — the daemon fills the missing `mode:*` label, opt-in per target

## Context

The eligibility gate (DESIGN §2, [ADR-0006](0006-mode-routing.md)) requires every
picked-up issue to carry a **mode** — `mode:tdd` or `mode:infra`. The mode is meant
to be stamped at triage. But not every target's triage funnel stamps it: on
`acme/example-monorepo`, for example, the "Design unification" issues
arrive `ready-for-agent` + `afk` with no mode. The gate then rejects them with
reason `no-mode`, and the backlog silently stalls — the daemon picks up only the
handful that happen to be moded, while an operator who has explicitly marked issues
ready sees nothing happen.

The missing piece is small and mechanical: choose `tdd` vs `infra` and apply the
label. That is a judgement a fresh-context agent can make from the issue text and
the target's own conventions — exactly the kind of bounded call the daemon already
makes for impl/review. The question is whether the daemon should make it, and under
what discipline, given that GitHub labels are the protocol (DESIGN §9) and that the
human's control over *what* gets worked must not be eroded.

## Decision

The daemon runs an opt-in, per-target **moding pass** (CONTEXT: moding pass): each
tick, when `autoMode.enabled`, it finds the OPEN issues the gate rejects **solely**
because they lack a `mode:*` label, classifies each with a bounded SDK call, and
applies the chosen `mode:tdd` / `mode:infra` label so the issue becomes eligible on
the next tick.

It is bound by five rules:

1. **It fills the mode gap only — it does not auto-triage.** A candidate must pass
   *every* eligibility-gate condition except the mode (OPEN + `ready-for-agent` +
   `afk` + not `hitl` + not paused + not `[log]` + every `## Blocked by` dependency
   closed-and-merged). The "only the mode is missing" test reuses the gate itself
   (`evaluateGate` over a synthetic moded copy), so it can never drift from
   admission. A human still decides *what* is ready; the daemon supplies the one
   missing label. Already-moded, paused, in-flight, blocked, or closed issues are
   never touched, and the pass is idempotent (a moded issue stops qualifying the
   instant its label lands).

2. **The rubric is the harness's, not the target's** ([ADR-0012](0012-hardcoded-review-rubrics.md)).
   `tdd` for a code change that should be driven by a failing test; `infra` for
   no-code / no-test work (config, docs, infra, schema/plan, deps). The target's
   `CLAUDE.md` / `AGENTS.md` are *context* the classification reads
   ([ADR-0019](0019-per-target-project-context.md)) — never a gate the target can
   weaken.

3. **The classification is one short, bounded SDK session** — fresh-context,
   OAuth-only, curated MCP, wall-clock-bounded, the same shape as the impl/review
   agents, driven through the shared structured-output path (legacy issue 15) so a
   malformed reply degrades gracefully. It runs read-only in the target's base clone
   (no per-issue worktree exists pre-pickup) and returns a validated
   `{ mode, reason }`.

4. **It is off the build pool and capped.** At most `autoMode.maxPerTick`
   classifications run concurrently (small default), so a large unmoded backlog
   cannot stampede the SDK or the plan budget — the rest wait for later ticks. Like
   the single-concurrency merge lease ([ADR-0017](0017-single-concurrency-integration-flow.md)),
   the pass does **not** consume the global build budget; it must never block the
   reconcile tick, so it runs fire-and-forget.

5. **No silent loss.** If the classifier cannot decide — low confidence, a
   wall-clock kill, or repeated unparseable output — the issue is left unmoded and
   logged, never guess-labelled and never surfaced as a `daemon-anomaly`. An unmoded
   issue is a plainly-visible `no-mode` exclusion the completeness invariant
   ([ADR-0016](0016-reconciler-completeness-invariant.md)) already classifies as
   `awaiting-human` (pre-gate) — the pass perturbs nothing.

Config is a per-target block, deep-merged like `agent` / `merge` / `review`:
`autoMode: { enabled: boolean (default false), maxPerTick: number, model?: string }`.
**Off by default** — an operator opts a target in explicitly. When off, the pass is
an exact no-op (no SDK call, no label write). `model` optionally runs the (cheap,
short) triage call on a different model from the impl/review agents.

## Consequences

- A target whose triage doesn't stamp modes stops stalling at `no-mode` once
  auto-mode is enabled for it, without weakening the gate (the mode is still
  required; the daemon just supplies it) or the human's control over readiness.
- The peak concurrent SDK sessions become `cap + (repos integrating) +
  (Σ autoMode.maxPerTick over enabled repos)`. With a small `maxPerTick` this is a
  bounded, accepted overage on top of the build cap — the same trade the merge lease
  already makes.
- Auto-mode is a *binding* decision in the same family as ADR-0012 and ADR-0019: the
  rubric stays harness-owned and target-independent, and the target's conventions
  are context only. A future change must not let a target's files re-route the
  tdd/infra choice.
- The legacy issue 15 structured-output substrate (`runStructuredSession` + `AgentOutputParseError`)
  moved to `executor/structured-session.ts` so the review runners and the auto-mode
  classifier share it without a cross-directory dependency — a refactor with no
  behavioural change to review.
