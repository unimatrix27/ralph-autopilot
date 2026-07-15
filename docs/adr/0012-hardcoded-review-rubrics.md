# Review rubrics are hardcoded in the daemon, not read from the target (supersedes ADR-0005)

> **Amended by legacy issue 41 / [ADR-0014].** The two hardcoded rubrics below are now preceded
> by a **Phase 0 CI gate**: the harness awaits CI green *before* running either review
> phase, and treats red CI as the fix worklist. The rubrics themselves are unchanged.
> ([ADR-0014](0014-harness-owned-ci-gated-rebase-aware-merge.md))

ADR-0005 made the target repo's `AGENTS.md ## Review guidelines` the single review spec, shared with the external Codex bot. In practice that made the review **target-dependent** and a silent **no-op** on any target lacking that file (e.g. the daemon's own repo) — and with auto-merge (ADR-0009) that means unreviewed code merges (legacy issue 25). We now **hardcode both rubrics** in `src/review/prompts.ts`: Phase 1 a normal correctness / security / spec / tests rubric, Phase 2 the thermo-nuclear structural rubric. The review is self-contained and target-independent — each phase is a single agent call carrying its own criteria. The agent still reads the target's `CLAUDE.md` / `AGENTS.md` / ADRs as *context* for the codebase's idioms, but the gating criteria are baked in and never absent.

## Consequences

- **Resolves legacy issue 25** — there is no missing-spec case; the review (thermo included) always has teeth, on any target.
- Drops ADR-0005's "one spec, shared with Codex, zero drift" property: an external bot now reviews by its own config and our review is independent. Accepted — determinism and always-on teeth beat shared-spec elegance.
- **Target-specific P0s are no longer auto-gated.** A target's project-specific correctness rules (e.g. `example-monorepo`'s Result-pattern / event-sourcing / transaction-date rules, which lived in its `AGENTS.md`) now reach the reviewer only as *context*, not as hardcoded gating criteria. If a target needs its own P0s enforced as blockers, that's a future extension (an optional target rubric appended to the hardcoded baseline) — but the baseline is always present.
- A test (`prompts.test.ts`) now asserts Phase 2 embeds the thermo lens (`thermo-nuclear`, `code-judo`, behaviour-preserving) so the review can never silently regress to a no-op.
