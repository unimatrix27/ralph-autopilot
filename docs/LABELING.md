# Labeling issues for ralph

How to hand a GitHub issue to the daemon, and what every label means. This is the
*practical* guide for whoever files or triages issues (human or agent); the full label
state machine is DESIGN §9, and the vocabulary lives in `src/core/labels.ts`.

Labels are the protocol: **desired state is expressed only through labels** (plus the
`## Blocked by` body section). There are no commands — the reconciler observes labels
each tick and acts on the difference.

## The recipe

To have ralph pick an issue up, apply **all three**:

| Label | Meaning |
| --- | --- |
| `mode:tdd` \| `mode:infra` \| `mode:ui` | **Required.** The verification contract (below). No mode = never picked up. Auto-mode is retired (legacy issue 227): apply it by hand. |
| `ready-for-agent` | The issue is specified well enough to implement unattended. |
| `afk` | You consent to fully unattended execution (implement → review → **auto-merge**). |

Optionally add:

| Label | Meaning |
| --- | --- |
| `complexity:1` \| `complexity:2` \| `complexity:3` | Selects the agent profile (ADR-0039, amended by ADR-0041). **Lower = more demanding** (the `priority:p0` convention): `1` hard/architectural, `2` standard, `3` routine/mechanical. The tier→model mapping is **binding**: `complexity:1` → `claude-fable-5`, `complexity:2` → `claude-opus-5` (see `agent.tiers` in the example config). Unlabeled = the global default profile — absence never stalls an issue. Duplicates resolve to the most demanding. **Tier 1 governs every lane** (impl, resume, review, fix, master); tiers 2–3 are impl-only, so review/fix stay uniform. **The daemon may set `complexity:1` itself:** the first master escalation promotes the issue permanently — that is expected, not a stray edit. |
| `priority:p0`, `priority:p1` | Admission ordering when slots are scarce: p0 before p1 before unlabelled. Not urgency theater — only ordering. |
| `hitl` | Explicitly bars the issue from unattended pickup even while `ready-for-agent` is present (e.g. specced but you want to be around when it runs). Remove it to release. |

Dependencies go in the **issue body**, not labels: a `## Blocked by` heading followed by
references written as `#123`, a same-repo issue URL
(`https://github.com/<owner>/<repo>/issues/123`, including as a markdown link), or
`<owner>/<repo>#123` shorthand — all gate identically (issue #8). Every listed issue must
be closed **and** its PR merged before the gate opens (`src/github/blocked.ts`). A
cross-repo reference cannot be evaluated: it holds the issue blocked and is warned every
tick, and a section whose list items parse to zero references is warned the same way.

## Choosing the mode

A mode is a **verification contract, not a domain tag** (DESIGN §3). Pick by how the
work is honestly verified, never by what part of the stack it touches:

- **`mode:tdd`** — the result is provable by tests. Red → green → refactor to a green
  suite. Default for behaviour changes in code.
- **`mode:infra`** — no-code/no-test work (config, docs, CI, schemas). Drops the test
  gate; the agent must perform and *describe* a mode-appropriate verification (build,
  dry-run, lint, plan check) in the PR body.
- **`mode:ui`** — view-layer work where *rendering* is the point (legacy issue 277). Keeps the
  build gate, treats tests as additive, and verifies by rendering: headless-chromium
  screenshots delivered to the PR via net-zero branch commits. Requires a
  chromium-equipped target image (example-monorepo has one) — operator-applied only.

There are deliberately no domain modes (`mode:frontend`, `mode:marketing`, …) — a new
surface is a new *target*, not a new mode.

## Labels the daemon owns — never apply or remove these by hand

The reconciler writes these to report state; hand-editing them desyncs the label state
machine from the store (see the runbooks for safe recovery):

- `awaiting-ci`, `awaiting-merge` — automated in-flight states (parked on CI / queued
  for integration).
- `master-triage` — the **only** non-human pause state, and **not** a request for you
  (ADR-0041, ADR-0042). Since the triage cutover *every* issue-scoped failure lands here
  first: a worker `escalate`/`stuck`, a review phase that spent its fix attempts, a CI gate
  that never greened, an exhausted rebase, a merge preparation that never became mergeable,
  an unresolved GitHub-hosted (Codex) review conversation, a wedged session, or an
  issue-level reconciler anomaly. The work is checkpointed on the issue branch and a fresh
  highest-tier session is adjudicating it. Nothing is waiting on you; if the master concludes
  only a human can decide, it will post a real `ralph-question` and swap to `awaiting-answer`.
  Removing this label by hand takes the issue out of the master queue and re-admits it as
  ordinary work, discarding the adjudication in progress.
- `awaiting-answer` — a **master** escalation asked you a question; answer it with
  `ralph-answer` (which performs the label swap itself). Your answer resumes the master's
  adjudication, not the original worker.
- `agent-stuck`, `daemon-anomaly` — the two human-attention states left. Fix the cause, then
  re-arm by swapping back to `ready-for-agent` (for `agent-stuck` after a manual branch
  force-push: do **not** re-arm — see the legacy issue 255 guard note in the runbooks; reopen
  and merge the PR by hand instead).

  Since ADR-0042 **only a completed master adjudication selects `agent-stuck`** — no worker,
  review loop, executor guard or reconciler path can project it. Seeing it means a master
  investigated and concluded nothing further helps, or the two-interventions-per-phase budget
  was exhausted. It always left a card explaining what was tried; read it before re-arming. It
  is *not* answerable through `ralph-answer`.

  `daemon-anomaly` is now **operator-owned only**: an issue-level anomaly the daemon can scope
  to a run goes to `master-triage` instead. What is left is a broken master path (an invalid
  tier-1 route — a master cannot repair the master), genuinely unclassifiable issue state, or a
  host/supervisor fault. The reason names the operator action required.

- `review-maxed` — **retired** (ADR-0042). No path applies it any more; a maxed-out review
  phase enqueues master triage with its blockers as evidence. If you still see one, it is a
  pre-cutover park the reconciler will adopt into `master-triage` on its next tick — leave it
  alone.

Success has **no label**: a finished issue is simply *merged + closed*.

## Worked example

A standard, test-provable feature that should run tonight without you:

> labels: `mode:tdd`, `ready-for-agent`, `afk`, `complexity:2`
>
> body ends with:
>
> ```
> ## Blocked by
> - #341
> ```

The daemon picks it up on the first tick after #341 is closed-and-merged and a slot is
free, implements it on the tier-2 profile, reviews, and squash-merges.
