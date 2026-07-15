# Two-phase local review, driven by AGENTS.md, never waiting on an external bot

> **Amended by legacy issue 41 / [ADR-0014].** A **Phase 0 CI gate** now runs *before* Phase 1:
> the harness awaits the PR's CI to a terminal verdict and, if red, skips review and
> fixes the failing checks first (review only ever runs on a green tree). The two
> review phases below are otherwise unchanged. ([ADR-0014](0014-harness-owned-ci-gated-rebase-aware-merge.md))

Review runs as local Agent SDK sessions in two phases: Phase 1 normal review
(correctness/security/spec/tests) then Phase 2 behaviour-conserving thermo-nuclear
(structural quality), each with ≤3 fix attempts. Correctness comes first because
thermo is behaviour-preserving by definition — running it before behaviour is
verified just gets churned. Both phases read the *same* spec, the target repo's
`AGENTS.md ## Review guidelines`, which already encodes thermo-nuclear philosophy
adapted to the codebase with P0/P1 severities — so our agents and the external
Codex bot share one source of truth.

## Considered Options

- **Wait for the external GitHub review bot, then address** (the `ralph-harness`
  model) — rejected: a fragile timing dependency (the harness slept 10 minutes).
  Instead, local review is the authoritative gate, and existing automated PR
  comments are *ingested opportunistically* into the worklist, never waited on.
- **A separate "decide what to implement" agent** between review and fix —
  rejected: consolidation (dedupe, rank, scope) is folded into the review agent's
  worklist output. A fix agent escalates rather than applying a risky structural
  change blind.
