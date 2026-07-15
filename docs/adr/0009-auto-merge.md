# Auto-merge from day 1; the no-deferral prompt rule is its twin

> **Superseded by legacy issue 41.** `gh pr merge --auto` is plan-gated off on free private
> repos and delegates the merge to GitHub. The mechanism is being replaced by a
> harness-owned, CI-gated, rebase-aware merge (await CI *before* review; merge
> directly on green). The *principles* below — autonomous merge, no human gate,
> the no-deferral twin — still hold; only the mechanism changes.
Once both review phases are clean the daemon runs `gh pr merge --auto --squash` —
fully autonomous, no human merge gate. This is safe even on a financial monorepo
because **merging to `master` is not a prod deploy**: production requires an
explicit tag release, which no agent will trigger under these clear prompts. The
only discipline kept on the merge is CI-green (enforced by `--auto`, which waits
for `pr-checks`). `master` itself stays ungated; we do not alter the repo's
rulesets.

## Consequences

- Success terminal is *merged + issue closed*, so `ready-for-human` is not a loop
  state — the only human-attention states are `agent-stuck`, `awaiting-answer`,
  `review-maxed`.
- **No-deferral rule** (the twin): impl/fix output contracts have exactly three
  outcomes — done, `escalate`, `agent-stuck` — and *no* "deferred items" field.
  Agents never end with hedging tails; a thing either matters enough to `escalate`
  or it gets done. Without a human reading every PR before merge, a silently
  deferred "we should also…" would otherwise ship unnoticed.
