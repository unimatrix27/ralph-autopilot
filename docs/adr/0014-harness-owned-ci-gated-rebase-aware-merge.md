# Harness-owned, CI-gated, rebase-aware merge (supersedes ADR-0009's mechanism)

`gh pr merge --auto` (ADR-0009) is the wrong mechanism. It is plan-gated **off**
on free private repos — `allow_auto_merge` refuses to flip, so it never worked on
the dogfood repo — and it delegates the merge *decision* to GitHub. The harness
already owns the gate (two-phase local review, ADR-0005/0012), so **the merge must
be a deterministic harness action**. It must also work on targets that *do* run CI
(e.g. `example-monorepo`'s `pr-checks`): wait for CI green before merging, and
treat red CI as work to fix. This ADR replaces the *mechanism* of ADR-0009; the
*principles* (autonomous merge, no human gate, the no-deferral twin) still hold.

## Pipeline — CI is awaited BEFORE review

After the impl agent opens the PR the review loop drives, in order:

0. **Phase 0 — CI gate.** Poll `gh pr checks <pr>` until every check is terminal.
   - **red** → *skip review*; the failing checks become the fix worklist; run the
     bounded fix loop (≤ `merge`/`review.maxFixAttempts`), push, re-await CI. Still
     red (or a `timeout`) → `review-maxed` (ci) + heal-card.
   - **green / no checks** → proceed. On a repo with no checks this is a no-op.
1. **Phase 1** — normal correctness/security/spec/tests review + fix (unchanged).
2. **Phase 2** — behaviour-conserving thermo review + fix (unchanged).
3. **Rebase-aware merge.** Bring the branch current with base first
   (`git fetch && git rebase origin/<base>` in the worktree, force-push).
   - clean → if the branch moved, re-await CI green → `gh pr merge <pr> --squash
     --delete-branch`.
   - conflicts → a fix agent resolves them (keeping build+test green) and continues
     the rebase; the **harness** then force-pushes the rebased branch (force-push is
     blocked inside agent sessions per the git-guardrails, §8, so the harness — not
     the agent — owns the rebase force-push, mirroring the clean-rebase path);
     a conflict implying a risky structural change → `escalate` (never resolve
     blind).
4. Terminal: merged + the issue auto-closes via `Closes #n`; the slot frees.

Why CI *before* review: a red build is the cheapest, most objective signal that the
change is wrong. Spending review/fix budget on a PR that does not even compile is
wasted; gating on CI first means review only ever runs on a green tree.

## Consequences

- **The merge is deterministic and harness-owned.** `awaitChecks(pr)` returns
  `{state: green|red|none|timeout, failures[]}`; `mergePullRequest(pr, {method,
  deleteBranch})` is a direct `gh pr merge`. `enableAutoMerge` / `--auto` are gone.
- **No-op on a no-CI repo.** Phase 0 and the merge-time re-await resolve to `none`
  immediately, so the dogfood repo merges the instant both review phases are clean
  — same end-state as before, without depending on a plan-gated GitHub feature.
- **High concurrency self-heals.** The rebase-aware merge is what lets the
  concurrency cap (10) survive the parallel-edit conflict pileup: without it,
  agents on a shared codebase produce mutually-conflicting PRs where only the first
  lands. With it, each PR is brought current with base and incidental overlap is
  resolved automatically (a risky conflict escalates rather than merging blind).
  Complements the "fork the latest default branch per worktree" fix (ADR-0002).
- **`master` itself stays ungated** — we do not alter the repo's rulesets. The only
  discipline on the merge is CI-green, now enforced by the harness rather than by
  `--auto`. Safe because merging to `master` is not a prod deploy (prod requires an
  explicit tag release). ([ADR-0009](0009-auto-merge.md) for the unchanged twin
  principle and the no-deferral rule.)
- Config gains a `merge` block: `{ method: squash, waitForChecks: true,
  ciTimeoutMinutes: 30, pollIntervalSeconds: 30, deleteBranch: true }`.
