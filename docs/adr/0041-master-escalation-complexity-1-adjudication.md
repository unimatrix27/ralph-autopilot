# Master escalation: worker `escalate` and `stuck` are adjudicated by a tier-1 master before a human is asked

## Context

Until now the two worker exits went straight past the daemon to a human. `escalate`
manufactured a `ralph-question` and `awaiting-answer`; `stuck` manufactured a terminal
`agent-stuck`. Both meant the same thing in practice: **a lower-tier agent, working from one
issue and one run, decided the operator should look at this.**

That is the wrong decider for most of what actually arrives. A worker escalates because it
cannot see far enough — which contract is authoritative, whether a constraint still holds,
what the sibling subtree already settled. A worker gets stuck because *its* budget ran out,
not because the work is impossible. In both cases the missing ingredient is usually **more
capability and more context**, not a human. And operator attention is the system's scarcest
resource (CONTEXT: stakes), so spending it on questions a stronger model could answer from the
hierarchy and the decision ledger is the most expensive mistake this system can make.

ADR-0040 built the substrate — the native hierarchy zoom-out and the durable scoped decision
ledger — and deliberately stopped short of running anything on it. This ADR runs something on
it: the first complete master-escalation path, for worker-origin `escalate` and `stuck`.

## Decision

**1. Worker-visible `escalate` means internal escalation to the master, not "ask the human."**
Its schema, its bar (ADR-0015), and its worker-facing description are unchanged; what changes
is where it goes. `stuck` stays a *distinct signal* — "execution budget exhausted" rather than
"I need a decision" — because that distinction is real evidence for the master. Both enter the
same queue.

**2. Only the master receives `ask_human`.** It is the only tool in this slice that creates a
`ralph-question` / `awaiting-answer` state. This is the load-bearing invariant: if any other
path could reach a human, "the master adjudicates first" would be advisory. The container
runner therefore cannot post one either (it checkpoints and relays), and a runner build that
does not know that is refused pre-dispatch rather than tolerated additively.

**3. The worker exits and frees its ordinary slot; nothing is reserved.** The queued master
later acquires an ordinary slot like anything else. There is no reservation, no hand-off, and
no separate pool — which is why a master can *wait*, and why waiting is correct rather than a
deadlock.

**4. Master work outranks fresh admission, under the same cap.** The queue is serviced before
`admit` computes open slots. A run already worked, checkpointed and handed up is worth more
than one not yet started; but total running sessions never exceeds
`scheduler.maxConcurrentAgents`.

**5. V1 globally serializes master sessions.** One process-wide lease, shared by every per-repo
reconciler. This is blunter than per-root leasing and buys the property that matters now: the
decision ledger fails *closed* on two active records claiming one key with no supersession
between them (ADR-0040), which is exactly what two concurrent masters would produce. A global
lease makes that race unrepresentable rather than merely unlikely.

**6. Every master invocation is a fresh session** (ADR-0008). It consumes the ADR-0040
hierarchy/context packet and the active decision ledger plus current issue/run/transcript/diff/
CI evidence. Its memory of its own prior attempts is the **event-stream fold**, not a
conversation.

**7. The first master escalation permanently promotes the issue to `complexity:1`** — one
atomic label patch that removes every other complexity label and adds `complexity:1`. The
promotion is idempotent and permanent; nothing demotes a tier.

**8. The tier→model mapping is binding, not illustrative.** `complexity:1` resolves to
`{ provider: claude, model: claude-fable-5 }` and `complexity:2` to
`{ provider: claude, model: claude-opus-5 }`, pinned in the checked-in example config and in
routing tests.

**9. Tier 1 is *governing*: its profile applies to every subsequent lane** — impl, resume,
review, fix and master — not only impl (amending ADR-0039 decision 5). A promotion that let the
next review pass drop back to a cheaper model would be a promotion in name only. Tiers 2 and 3
stay impl-only, so ordinary issues keep the uniform review/fix routing that makes unattended
merge safe (ADR-0014). The `master` lane is *tier-derived by construction* at any tier: there
is no `agent.types.master` key.

**10. The master route is derived from `agent.tiers["1"]`, and fails CLOSED.** No new live
config key (V1 avoids re-running the deployed-runner schema skew of issue #19). A missing or
non-tools-capable tier-1 profile is a **configuration defect**, surfaced as an actionable
attention state naming the defect — never a silent fallback to a cheaper master, which would
defeat the entire escalation. It consumes no intervention budget.

**11. The worker's recommendation is primary evidence, never an automatically accepted
answer.** The context packet labels it as a recommendation *before* the instruction to act, and
the outcome schema requires the master's own `conclusion` and `rationale` on every arm. A
schema that let the master reply "agreed" would quietly turn it into a rubber stamp — the one
failure mode this slice exists to prevent.

**12. The master is a flexible senior recovery agent.** It may inspect and edit the exclusive
WIP worktree, run commands and tests, commit and push the issue branch, inspect GitHub/CI,
publish scoped decisions, and delegate a fresh tier-1 worker. Capability is the point.

**13. Harness invariants remain non-bypassable.** No direct merge or issue close, no CI bypass,
no force-push or destructive git, no branch but the issue's own, no host/supervisor control.
Enforced two ways: the merge/close capabilities are simply **not wired** into a master session,
and a `PreToolUse` guardrail hook (advisory, like DESIGN §8's git guardrails) denies the
commands. Repaired work re-enters the normal CI/review/merge pipeline.

**14. Exactly five outcomes, exactly one per intervention:** `resolved-and-continue`,
`redispatch-tier-1`, `retry-pipeline`, `ask-human`, `terminal-stuck`. There is no "deferred"
arm — the no-deferral rule is enforced by the schema, not by exhortation.

**15. The loop budget is mechanical.** At most **two** interventions per run phase; a third
cannot launch. A repeated **normalized failure signature** forces final adjudication: the
master may not repeat a resolution already tried for that signature, and the harness re-checks
its answer, coercing a forbidden repeat to a human question rather than executing it. **A
changed head SHA does not make a signature new** — the signature erases SHAs, timestamps,
paths, line numbers and counters precisely so a rerun cannot masquerade as a new failure. A new
run span resets the per-run budget; the prior history stays in context.

**16. A human answer resumes the *checkpointed master*, once.** It re-opens the same numbered
attempt (spending no fresh budget — otherwise answering the second intervention's question
would land straight on the ceiling and throw the answer away), and that resumed master may not
ask again. Ask → answer → ask cannot cycle.

**17. Master queue and attempt state are append-only issue-stream facts**, with GitHub as
desired-state truth: the daemon-owned `master-triage` label says *that* an escalation is
queued, and a fenced `ralph-master-request` comment carries *what* must be adjudicated. A cold
store rebuilds both, so a restart between request / start / outcome rehydrates exactly one
pending intervention and duplicates no session or decision comment.

**18. The projected non-human state is `master-triage`** — a run status and a daemon-owned
label, level-triggered through the ADR-0027 outbox like every other state effect. It excludes
the issue from ordinary admission and classifies as **in-flight**, never `awaiting-human`: the
daemon is working, nobody is being paged.

## Considered options

- **Keep `escalate` human-facing and add a separate `escalate_to_master` tool** — rejected:
  two tools with overlapping meaning means every worker prompt has to teach the distinction,
  and workers would get it wrong in the direction that costs operator attention. Changing what
  the *existing* tool means costs one ADR and no worker-facing surface area.
- **Let `stuck` stay terminal and only route `escalate` to the master** — rejected: a bounded-out
  worker is the single best candidate for "a stronger model finishes this", and discarding its
  WIP to terminalize was throwing away exactly the evidence the master needs.
- **Per-root master leasing instead of a global lease** — rejected for V1: it is the right end
  state, but it is only *safe* once the ledger's cross-root independence is proven, and the
  master queue is rare enough that global serialization costs latency nobody will notice.
- **An `agent.types.master` config key** — rejected: a daemon-only key added to the mounted
  config re-runs the unknown-keys-rejected outage against stale container runners documented in
  issue #19, for no benefit — tier 1 already means "the strongest profile".
- **Fall back to the global provider when tier 1 is unconfigured** — rejected outright. A
  master running on a cheaper model than the worker that escalated to it is worse than no
  master: it burns an intervention, produces a confident wrong adjudication, and hides the
  misconfiguration. Failing closed costs one operator fix; falling back costs trust in every
  adjudication.
- **Let the master merge its own repair** — rejected: ADR-0014 makes the merge harness-owned
  precisely because unattended merge is safe only when *nothing* can route around the gate.
  A stronger model is a stronger argument for the rule, not an exception to it.
- **Count a human-answer resumption as a fresh intervention** — rejected: it means answering
  the second question is indistinguishable from ignoring it, since the budget is already spent.
  Re-opening the same attempt is what makes the answer usable.

## Consequences

- `RunStatus` gains `master-triage`; the label vocabulary gains the daemon-owned
  `master-triage`; the event vocabulary gains eight additive facts. `Escalated`, `ReviewMaxed`
  and `RunStuck` keep their exact meaning and schema (ADR-0024/0026).
- The reconcile tick gains one step (`serviceMasterQueue`) before fill. It is synchronous down
  to `occupySlot`, so an unwired or empty queue perturbs the tick's scheduling by nothing.
- `providerPreferenceList` grows a `master` type and the governing-tier rule; `AGENT_TYPES`
  (the *configurable* set) deliberately does not include `master`.
- Container dispatch/result schemas grow additively (`kind: "master"`, `escalationMode`, the
  `master` result frame), and the runner declares an `io.ralph.runner-capabilities` label the
  daemon reads pre-dispatch. A stale runner fails with a precise, actionable compatibility
  error naming the missing capability — never a generic no-result cascade.
- Out of scope, deliberately: automatic triage of `review-maxed`, CI/merge/rebase failures and
  daemon anomalies (the next slice); direct master merge/close; host recovery; persistent
  conversational memory; parallel master sessions.
