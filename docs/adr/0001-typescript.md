# Build ralph-autopilot fresh, in TypeScript

The daemon is pure I/O orchestration (shells out to `gh`, `git`, and the Agent
SDK; polls GitHub) with zero CPU-bound work, so a compiled language buys nothing.
TypeScript gives first-class Claude Agent SDK support, runtime-validated typed
schemas for the JSON hand-off contracts, and one language end-to-end through the
eventual web UI. Built fresh rather than forking `ralph-harness` because the
architecture differs fundamentally (local worktrees + long-lived reconciler vs.
throwaway EC2 single-fire) — we reference the harness's proven patterns, not its
code.

## Considered Options

- **Go/Rust single binary** — rejected: the work is I/O-bound, and the agent
  orchestration logic is TS-shaped, so a compiled daemon would straddle two
  languages for no gain.
- **Python** — viable (same Agent SDK tier) but makes the eventual web UI a second
  stack.
