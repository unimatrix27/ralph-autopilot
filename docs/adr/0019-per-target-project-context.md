# Per-target project context — agents honour the *target* repo's CLAUDE.md / AGENTS.md

ADR-0008 gives every agent session **fresh context**: it runs with the Agent SDK's
`settingSources: []`, deliberately inheriting no user settings, no project
`CLAUDE.md`, and — crucially — no auto-memory section. The intent was twofold: a run
must derive truth from the code and GitHub (not from a prior run's memory), and the
operator's personal `~/.claude` settings must never leak into an autonomous run.

Multi-repo support (ADR-0020) makes one of those exclusions wrong. When the daemon
works a real product repo (e.g. `acme/example-monorepo`), that repo's own
`CLAUDE.md` / `AGENTS.md` / `.claude/` ARE the design of record the agent must obey —
its build/test conventions, its architecture rules, its review rubric pointers. An
agent that ignores them violates the design-authority rule (ADR-0011) against the
*target's* design, not ours.

## Decision

An agent session loads the **target repo's project context**, and only the project
layer — never the operator's user layer.

- `settingSources` defaults to `["project"]` (configurable per target via
  `agent.settingSources`). The SDK resolves the `project` layer relative to the
  session `cwd`, which is already the per-issue worktree — so it reads *that target
  repo's* `CLAUDE.md` and `.claude/settings.json`, fetched from the worktree, not the
  daemon's own. `"user"` is deliberately omitted, preserving ADR-0008's no-leak
  intent: the operator's settings and auto-memory stay out.
- The `memory` MCP server remains excluded (the `selectCuratedMcpServers`
  enforcement is unchanged) — "fresh context, no memory" still holds.
- **`AGENTS.md` is injected by the harness.** The installed Agent SDK
  (`@anthropic-ai/claude-agent-sdk`) loads `CLAUDE.md` via the `project` setting
  source but does **not** auto-load `AGENTS.md`. So `buildAgentOptions` reads
  `<worktree>/AGENTS.md` (if present) and appends it to the system prompt under a
  labeled header, for impl, resume, review, and fix sessions alike — that one wiring
  point is shared by all session kinds.

## Consequences

- This refines ADR-0008 from *blanket* isolation to *per-target project* isolation:
  fresh context + the target's project instructions, minus the operator's user layer
  and minus memory. ADR-0008's reproducibility and no-leak guarantees survive intact.
- The reproducibility caveat: a run's behaviour now also depends on the target
  worktree's `CLAUDE.md`/`AGENTS.md` at that commit — which is correct, since those
  files ARE part of the target's design of record (they are versioned in the target).
- The review rubrics stay **hardcoded and target-independent** (ADR-0012): a target's
  `AGENTS.md` is *context* for the review/fix agents, never a gate the target could
  weaken. The gating rubric remains the harness's.
- `settingSources` is a per-target config knob (default `["project"]`); a target with
  no project files simply gets the default Claude Code behaviour, no-op.
