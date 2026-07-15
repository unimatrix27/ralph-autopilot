# `escalate` is an async, checkpointing tool — not a blocking call, not `AskUserQuestion`

When an agent needs a human decision it calls a custom `escalate` tool that
checkpoints its WIP (draft PR + resume context), writes a structured
`ralph-question` comment to GitHub, swaps `ready-for-agent → awaiting-answer`,
frees the concurrency slot, and exits. On answer the daemon **resumes** the agent
from its branch with the answer injected. A blocking call was rejected: it would
hold a process, a worktree, and one of five slots hostage for hours or days and
evaporate on any restart. Async survives restarts (the question lives in GitHub),
frees the slot instantly, and drops cleanly into the reconciler.

## Consequences

- The tool is named `escalate` specifically so it is never conflated with Claude's
  built-in `AskUserQuestion`, which blocks the live session for an in-conversation
  pick — a different mechanism entirely.
- The input schema is a forcing function for operator attention: `headline`,
  `feature`, `where_we_stand`, `decision`, `options?`, **`stakes`** (required —
  translates the decision to architecture/user level), `recommendation`. Validated
  at the tool boundary; an empty required field is rejected and re-asked.
- Beyond completeness, the boundary also enforces an **escalation quality bar**
  ([ADR-0015](0015-escalation-quality-bar.md)): a complete question is still rejected
  if it is a design-resolvable internal structure call (decide + ADR per ADR-0011
  instead) or if its stakes only parse with the diff open.
- Resume-not-restart preserves work and decision continuity; restarting clean was
  rejected because it discards progress and may re-decide differently.
