# Agents run on this box's OAuth (never an API key) with fresh context (no memory MCP)

Agents are driven through the Claude Agent SDK authenticated by this box's own
`claude` login — concurrent OAuth use is safe through the SDK, and the plan is
dedicated to this machine. **API-key usage is explicitly forbidden**, so there is
no fallback auth path to build. Every agent starts from **fresh context** with the
MCP set `serena, morph-mcp, context7, github, sequential-thinking` and *no*
`memory` MCP, so it derives truth from GitHub and the codebase, never from stale
cross-run assumptions.

## Consequences

- The concurrency cap (default 5) is bounded by the operator's plan budget, not by
  hardware or billing — tune it down if plan limits bite; there is no API escape
  hatch by design.
- Fresh context is what keeps the system "hard facts," not accumulated agent
  folklore — the same principle the `ralph-harness` ancestor enforced.
