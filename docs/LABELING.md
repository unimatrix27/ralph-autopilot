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
| `complexity:1` \| `complexity:2` \| `complexity:3` | Selects the impl agent profile (ADR-0039). **Lower = more demanding** (the `priority:p0` convention): `1` hard/architectural, `2` standard, `3` routine/mechanical. Which model each tier maps to is operator config (`agent.tiers`), not fixed here. Unlabeled = the global default profile — absence never stalls an issue. Duplicates resolve to the most demanding. Impl only; review/fix are unaffected. |
| `priority:p0`, `priority:p1` | Admission ordering when slots are scarce: p0 before p1 before unlabelled. Not urgency theater — only ordering. |
| `hitl` | Explicitly bars the issue from unattended pickup even while `ready-for-agent` is present (e.g. specced but you want to be around when it runs). Remove it to release. |

Dependencies go in the **issue body**, not labels: a `## Blocked by` heading followed by
`#123`-style references. Every listed issue must be closed **and** its PR merged before
the gate opens (`src/github/blocked.ts`).

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
- `awaiting-answer` — the agent escalated a question; answer it with `ralph-answer`
  (which performs the label swap itself).
- `review-maxed`, `agent-stuck`, `daemon-anomaly` — human-attention states. Fix the
  cause, then re-arm by swapping back to `ready-for-agent` (for `agent-stuck` after a
  manual branch force-push: do **not** re-arm — see the legacy issue 255 guard note in the
  runbooks; reopen and merge the PR by hand instead).

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
