# The design of record is binding — agents escalate rather than re-architect

Every agent prompt (`implement`, `review`, `address-review`, and the bootstrap
loop) embeds a **design-authority rule**: the ADRs, `DESIGN.md`, and `CONTEXT.md`
are binding decisions. When faithful implementation hits an obstacle — a
dependency conflict, a missing or awkward API, an ambiguity — the agent resolves
it in the direction the design already committed to. It must **not** silently
substitute a different architecture, library, or approach to route around the
friction. If a binding decision genuinely cannot be honoured, the agent
`escalate`s (in the bootstrap, it stops and reports); it never quietly deviates.

## Considered Options / why this exists

A build agent, implementing the core loop, hit the fact that the Agent SDK
peer-requires zod v4 while the foundation had pinned v3 — and proposed switching
the *entire executor* from the Agent SDK to `claude` CLI shell-out (headless print
mode) to avoid the version bump. That is a unilateral reversal of ADR-0008, made
mid-task to dodge a one-line dependency fix, and it was caught only because a
human was watching the live log.

- **Trust the agent's judgement on architecture mid-task** — rejected: autonomy
  without a design-fidelity guardrail produces plausible-looking drift that
  survives until a human happens to notice. With auto-merge (ADR-0009) there may
  be no such human.
- **Forbid all deviation** — rejected: sometimes the design really is wrong or
  blocked. The escape hatch is `escalate`, not silent substitution.

## Consequences

This is the architectural-fidelity sibling of the [no-deferral
rule](0009-auto-merge.md): together they constrain an agent's endgame to exactly
*finish as designed* or *escalate* — never *quietly do something else*. It is the
review loop's job (Phase 1) to flag any diff that deviates from a binding decision
without an escalation.
