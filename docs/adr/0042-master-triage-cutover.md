# Master triage cutover: every issue-scoped failure is adjudicated before a human is interrupted

## Context

ADR-0041 routed the two *worker* exits — `escalate` and `stuck` — through a fresh tier-1 master
before any human is asked. It deliberately stopped there, and named what it was leaving out:
"automatic triage of `review-maxed`, CI/merge/rebase failures and daemon anomalies (the next
slice)".

That leftover is most of the volume. A review phase that spends its fix attempts, a CI gate that
never greens, a rebase that loses the race with a hot base, a merge preparation that never becomes
mergeable, a session that wedges, a reconciler anomaly — each of these manufactured its own
human-attention state on its own authority. A heal-card. A `review-maxed` label. An `agent-stuck`
terminal with the PR auto-closed. A `daemon-anomaly`.

Every one of them is a **diagnosable issue-scoped fault**: it has a branch, a PR, a transcript, a
CI log and a hierarchy behind it. That is exactly the class of problem a stronger model with the
whole context in front of it usually resolves — and exactly the class we were spending operator
attention on, the system's scarcest resource (CONTEXT: stakes). "The master adjudicates first" was
true for two paths and false for seven, which means it was not a property of the system.

Separately, issue #3430 exposed a *specific* mis-attribution with the same shape. A repository
ruleset blocks merging on unresolved conversations. GitHub-hosted Codex opened threads on a PR
whose CI was green and whose Ralph reviews were clean, so `mergeStateStatus` read `BLOCKED`. The
merge gate read that as "a required check has not greened", spent its entire CI polling budget
waiting for a check that was never going to change, and emitted a CI heal-card naming the wrong
cause. Flat review comments cannot model this — they carry no thread identity, no
resolved/outdated state and no resolver — so the hosted reviewer was invisible to the harness
even though it was the thing holding the merge.

## Decision

**1. Every issue-scoped failure source enters the ADR-0041 master queue.** `review-maxed` in the
CI/correctness/quality phases; exhausted or non-trivial rebase/sync/merge preparation; issue-run
session and container wedging after the existing bounded mechanical cleanup; issue-level
reconciler/completeness anomalies with issue and run context; and any remaining path that would
otherwise terminalize to `agent-stuck`. One door: `HarnessMasterEscalation`.

**2. Source facts are preserved as history, never replaced.** `ReviewMaxed`, `RunStuck` and
`AnomalyDetected` keep their exact meaning and schema (ADR-0024/0026). `MasterTriageRequested` is
appended in the **same commit**, so the latest projection is `master-triage` and no reader — not a
live consumer, not a notification sink, not a crash landing between two writes — can ever observe
the intermediate human-facing state. Atomicity here is what makes "no operator is paged for work
the daemon is about to do" a guarantee rather than a race.

**3. Cheap deterministic retries still run first.** The bounded fix loop, the container re-dispatch
budget, the rebase rounds, the CI poll budget: all unchanged, all spent before an escalation. The
master receives what survived them.

**4. Usage limits and GitHub rate limits keep their defer/rotation semantics.** Neither enqueues a
master, neither consumes an intervention attempt, neither becomes stuck. A cap is a wait, not a
fault, and the distinction is load-bearing: routing waits into the master queue would burn the
two-per-phase budget on conditions that resolve themselves.

**5. Host-wide and supervisor/self-update anomalies stay operator-owned.** They have no issue
worktree to scope an adjudication to, and the master may not restart services, mutate supervisor
state, or repair host resources. `daemon-anomaly` is retained for exactly two issue-level cases —
a broken/unavailable **master path itself** (an invalid tier-1 route: a master cannot repair the
master) and genuinely **unclassifiable** issue state — and it must name the operator action.

**6. `review-maxed` becomes an event, not a state.** No heal-card is posted, no operator question
is indexed, no durable label is applied, and there is no separate resume protocol. The
`buildHealCardQuestion` / `formatHealCard` surface is *removed*, not merely unused: a renderer
nothing calls is a renderer something will call again.

**7. `agent-stuck` is selectable only by a completed master adjudication**, after the autonomous
budget is exhausted or once the master proves no useful next action exists — **and it is not
answerable through `ralph-answer`.** Two invariants, enforced two ways, because they fail in
opposite directions:

- *Who may write it* — source scan (`master/terminal-authority.test.ts`), which admits a fallback
  only at a site carrying an explicit marker and pins the exact set of marked sites. A path nobody
  thought of must be unable to reach the terminal quietly.
- *Who may lift it* — the **type**: `agent-stuck` is not in `ANSWERABLE_LABELS`, so
  `OpenQuestionItem["label"]` cannot hold it and the queue never serves it. Answering it used to
  re-admit a fresh worker run, silently un-terminalizing a finished adjudication into a second
  lifecycle for the same condition.

The terminal still carries a self-explaining card — the master's conclusion has to stay readable
on the issue — but the card is *evidence*, not a question, and it offers only moves that work:
re-scope and re-label, or close. Every surface refuses an answer explicitly rather than reporting
an indistinguishable "nothing here".

**7a. A master decision is recorded before its effect; its attempt span closes after.** The window
between them is real — a crash, or a failed GitHub/SQLite write inside the effect — and it used to
close the span with nothing having happened, wedging the run in `master-triage` where no later
tick could pick it up (`pending` and `inProgress` both null → `no-request`, forever). So
`MasterResolutionSelected` carries the validated outcome payload and the next tick **replays that
exact ruling**, rather than spending a fresh session to reach a possibly different one. Replay is
idempotent where it must be: the two card-posting arms adopt an already-posted card instead of
publishing a second copy GitHub cannot un-post. A *new* triage request supersedes an undelivered
effect — a fresh failure is something to adjudicate, never the old hand-back to re-run.

**8. `awaiting-answer` is the only state that means a human decision is requested**, it carries
exactly one structured `ralph-question`, and `ralph-answer` resumes the checkpointed *master*
first (ADR-0041 §16).

**9. The GitHub-hosted reviewer is a first-class integration gate**, distinct from CI and from
Ralph's phase-1/phase-2 reviews. The GitHub port grows thread-aware GraphQL reads
(`reviewThreads`: stable ids, author/type, body, path/line/side, `isResolved`, `isOutdated`,
reviewed commit, replies, resolver) plus reply and resolve mutations. Flat comments are not
sufficient and are not used for this.

**10. `mergeStateStatus = BLOCKED` is classified into typed causes before any retry** —
hosted-review conversations, human-review policy, required status checks, behind/conflict, or an
unknown ruleset restriction. The CI polling budget funds exactly one of those (a *pending*
required check). Everything else returns immediately with its own evidence.

**11. Hosted findings are normalized into a durable worklist** — thread id, latest-comment
id/hash, reviewed head, severity when stated, path/line, the finding verbatim, and evidence — and
the **actual findings** are injected into the fix or master context. Never a generic "merge
blocked": the whole defect of #3430 was that the evidence named the wrong cause.

**12. A bot finding is never accepted (nor dismissed) because a bot raised it.** An agent may
conclude a finding is invalid, but must persist its own rationale and the verification supporting
it, and both appear in the reply body.

**13. Reply and resolve only after the fix or reasoned disposition is pushed and verified on the
relevant head**, idempotently by thread id, recorded as append-only facts
(`HostedReviewThreadReplied` / `HostedReviewThreadResolved` / `HostedReviewObserved`). A restart
between observation, worklist, fix, reply, resolution and re-review reconstructs exactly one
pending action and repeats no mutation.

**14. A human-authored thread is never auto-resolved.** It is carried into master context; the
master may implement and reply, but resolution and approval follow the repository's human-review
policy. An **unclassifiable bot** identity fails closed — neither safe to resolve nor safe to
ignore.

**15. The merge command is unreachable until CI, internal review, hosted review, human-review
policy, head freshness and mergeability are simultaneously satisfied** on one stable head.

**16. The #42 budget applies across all sources.** Two interventions per run phase; a repeated
normalized failure signature forces final adjudication. A hosted-review signature is built from
**thread identity + latest finding content + verification result**, so a push that changes only
the head SHA is the same failure — new findings on a new head do not reset the budget.

**17. Pre-cutover states are adopted, once.** On reconcile, an issue carrying `review-maxed` or a
non-master `agent-stuck` has its run/phase/heal-card evidence preserved, one idempotent master
request appended, and moves to `master-triage`. A live unanswered `ralph-question` is *not*
adopted — that is a real question a human is genuinely being asked. An `agent-stuck` a master
already adjudicated is not re-queued.

**18. Drain starts no master session.** The queue is durable on GitHub and in the event log, so
the next normal startup services it. An already-running master obeys the existing session
shutdown contract.

## Considered options

- **Keep `review-maxed` as a durable label and add master triage alongside it** — rejected: two
  active lifecycles for one condition, and every operator surface would have to explain which one
  applies today. The migration cost is one adoption pass; the cost of keeping both is permanent.
- **Route usage/rate limits through the master too, "for uniformity"** — rejected outright. A cap
  is a wait that resolves itself. Spending an intervention on it would guarantee that the *real*
  failure underneath arrives with the budget already gone.
- **Let the master repair host/supervisor faults** — rejected: the box is the blast radius
  (OPERATING), and a master with host control is a strictly larger blast radius than the workers
  it adjudicates. There is also no issue scope to adjudicate against.
- **Treat hosted-Codex threads as ordinary PR comments the review agent ingests** — rejected: that
  is what the pre-#43 code did. Comments carry no thread identity or resolution state, so the
  harness could neither tell a stale finding from a live one nor ever satisfy the ruleset.
- **Resolve any bot thread automatically** — rejected: "looks like a bot" is how an autonomous
  merge quietly dismisses a real reviewer. An unrecognised bot identity fails closed.
- **Signature hosted findings on the head SHA** — rejected: every repair pushes a new head, so the
  same unfixed finding would read as new forever and the budget would never bind. Thread identity
  plus finding content is the stable key.
- **Keep the claim-park projecting `agent-stuck`** — rejected: it contradicts decision 7 for a case
  where no run ever started and the daemon could not even mutate the issue's labels. Its span now
  closes effect-neutrally and `daemon-anomaly` remains its sole, operator-owned surface.

## Consequences

- `MasterRequestSource` grows eight harness-origin members and `MasterLane` grows three harness
  lanes; the event vocabulary grows three additive hosted-review facts, and three existing master
  facts grow optional fields (`MasterInterventionStarted` restates its request's
  `source`/`lane`/`headline`, so a *running* triage can still be named once its queue entry is
  consumed; `MasterResolutionSelected` carries `conclusion` and the replayable `outcome`). Nothing
  is rewritten, so a rebuild from the append-only log produces the same queues and labels — and
  `IssueEventLog.rebuildIssueProjection()` now makes that executable rather than asserted, folding
  the read model from the log with the same pure `foldIssueState` the inline projection uses.
- `ReviewLoopOutcome`'s `review-maxed` arm becomes `master-triage`. The rename is deliberate: the
  compiler finding every consumer is the point, because a caller that still believes it means "a
  human must act" is a bug.
- `GitHubClient` grows `readReviewThreads` / `replyToReviewThread` / `resolveReviewThread`, and
  `MergeStatusSnapshot` grows optional `reviewDecision` + `headSha` (both ride free on the existing
  `gh pr view` read).
- The snapshot projection, the web overview API and the PWA grow a **master-triage band** — visible,
  never in "Needs you". Notifications fire for `awaiting-answer`, a terminal `MasterStuck`, and a
  genuine operator-owned anomaly; never merely because triage began.
- `recordTerminalResult` (an unused container helper that pinned `agent-stuck` off a result frame)
  is removed rather than left as a second lifecycle implementation.
- Out of scope, deliberately: automatic host/service/supervisor repair; direct master merge/close
  or gate bypass; parallel master sessions or reserved concurrency; persistent conversational
  master memory beyond the decision ledger and event stream.
