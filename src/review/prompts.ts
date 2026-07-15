/**
 * Review- and fix-session prompts (DESIGN §4). The review rubrics are
 * **hardcoded here** and target-independent (ADR-0005, superseded by ADR-0012):
 * Phase 1 carries a normal correctness/security/spec/tests rubric, Phase 2
 * carries the thermo-nuclear structural rubric. The agent may read the target's
 * own CLAUDE.md / AGENTS.md / ADRs as *context* for the codebase's idioms, but
 * the gating criteria are these baked-in rubrics — they never depend on the
 * target shipping a review spec. Every prompt embeds the two standing
 * conventions (no-deferral + design-authority, CONTEXT).
 */

import type { Issue, PrComment } from "../github/types";
import type { Mode, Phase } from "../store/types";
import type { Worklist } from "./worklist";
import type { EscalationQuestion } from "./escalation";
import type { RalphAnswer } from "../hitl/answer";
import type { FixContext } from "./agents";

/** Appended to the claude_code system prompt for review and fix sessions. */
export const REVIEW_SYSTEM_APPEND = [
  "You are an autonomous review/fix agent in the ralph-autopilot daemon.",
  "You run with fresh context every time — derive truth from the code, the diff, and GitHub, never from memory of past runs.",
  "",
  "Two rules are binding:",
  "- No-deferral rule: never end with hedging tails. There is no 'deferred items' outcome — a thing either matters enough to fix/escalate, or it is not worth mentioning.",
  "- Design-authority rule: the design of record (the ADRs, DESIGN.md, and the target repo's own documented conventions) is binding, not advisory. Resolve obstacles in the direction the design already committed to; never silently swap a different architecture, library, or approach to route around one. If a binding decision genuinely cannot be honoured, escalate rather than deviating. Phase-1 review must flag any diff that deviates from a binding decision without an escalation.",
].join("\n");

/**
 * PHASE 1 — normal review. Hardcoded correctness/security/spec/standards rubric.
 * Target-independent: applies to any codebase. P0 = a merge blocker.
 */
const PHASE1_RUBRIC = [
  "Apply these lenses to the PR diff (NOT the surrounding pre-existing code):",
  "- Correctness: the change satisfies every acceptance criterion of the issue; edge cases and error paths are handled; no logic bugs introduced.",
  "- Security: no secret is logged, echoed, or committed; shell-outs pass arguments as an argv array, never string-interpolated commands; inputs crossing a trust boundary are validated; no cast/`any` hides a real invariant.",
  "- Spec-match: every acceptance criterion is met, and nothing out of scope was added.",
  "- Conventions: the change follows the target codebase's documented conventions — read its CLAUDE.md / AGENTS.md / ADRs as context for naming, error-handling idioms, layering, and do-not-touch areas (generated code, migrations). A convention violation is a finding.",
  "- Design-authority: flag any diff that deviates from a binding design decision without an escalation.",
  "Severity in phase 1: `P0` = a correctness / security / spec / arch-rule violation that must block the merge. Do NOT raise pure structural / thermo-nuclear quality items here — those belong to phase 2.",
].join("\n");

/**
 * PHASE 2 — behaviour-conserving thermo-nuclear structural review. Hardcoded,
 * target-independent. Distilled from the thermo-nuclear-code-quality-review
 * rubric. P1 = a structural blocker. Every item must be behaviour-preserving.
 */
const PHASE2_RUBRIC = [
  "This is an extremely strict maintainability review. Behaviour is already verified correct (phase 1) — every item here MUST be behaviour-preserving, and you must not re-litigate phase-1 correctness.",
  "Be AMBITIOUS about structural simplification — do not stop at local cleanups. Hunt the 'code-judo' move: a reframing that makes whole branches, helpers, modes, conditionals, or layers disappear, so the change feels inevitable in hindsight. Prefer deleting complexity over rearranging it.",
  "Flag aggressively (as `P1`):",
  "- Missed simplification: a reframing would delete branches/helpers/conditionals the diff adds.",
  "- Spaghetti growth: ad-hoc conditionals, one-off flags, or special cases bolted into an unrelated flow — push the logic behind its own abstraction, state machine, or the owning module.",
  "- Wrong layer / boundary leak: feature logic leaking into a shared path, or logic that belongs in a different module/layer — name the canonical home.",
  "- Weak abstraction: thin wrappers, identity pass-throughs, or generic 'magic' that hides a single simple shape — prefer direct, boring, legible code.",
  "- Duplication: copy-paste of something a canonical helper already does.",
  "- File-size smell: a file the diff pushes past ~1000 lines is a decomposition signal (a smell, not a hard block — waive with a clear structural reason).",
  "- Type-contract muddiness: needless `any` / `unknown` / casts / optionality papering over a real invariant — prefer an explicit typed model.",
  "- Non-atomic or needlessly sequential orchestration where the cleaner structure is obvious.",
  "Approval bar: do NOT approve merely because tests pass. Prefer a FEW high-conviction structural findings over a long nit list. If a worthwhile restructuring would change observable behaviour, it is out of scope here — escalate it instead of doing it.",
].join("\n");

function phaseGuidance(phase: Phase, mode: Mode): string {
  if (phase === 1) {
    const testLens =
      mode === "infra"
        ? "NOTE: this is a `mode:infra` change — the tests lens does NOT apply; verify the change in a mode-appropriate way instead of expecting a test suite."
        : mode === "ui"
          ? "NOTE: this is a `mode:ui` change — the tests lens applies only where tests are sensible (unit/component tests are additive, never a gate on pixel output); the mode's verification is the rendered evidence, so a PR body without screenshots + a statement of what was rendered and how is a finding."
          : "Tests lens: new behaviour has a meaningful test that asserts behaviour (not implementation) and is not gamed to pass; a behaviour change without test coverage is a finding.";
    return ["This is PHASE 1 — normal review.", PHASE1_RUBRIC, testLens].join("\n");
  }
  return ["This is PHASE 2 — behaviour-conserving thermo-nuclear review.", PHASE2_RUBRIC].join("\n");
}

function commentDigest(prComments: PrComment[]): string {
  if (prComments.length === 0) {
    return "There are no automated PR comments to ingest.";
  }
  const lines = prComments.map((c) => `- @${c.author}: ${c.body.replace(/\s+/g, " ").trim()}`);
  return ["Automated PR comments already present — ingest any that match this phase's rubric into your worklist (dedupe against your own findings); ignore the rest:", ...lines].join("\n");
}

/** Build the user prompt for a review pass; the agent outputs a JSON worklist. */
export function buildReviewPrompt(
  issue: Issue,
  mode: Mode,
  phase: Phase,
  prNumber: number,
  prComments: PrComment[],
): string {
  return [
    `Review pull request #${prNumber} for GitHub issue #${issue.number}.`,
    "",
    `Title: ${issue.title}`,
    "",
    phaseGuidance(phase, mode),
    "",
    "The rubric above is the complete, self-contained review spec — apply it to the PR diff. You do not need any review-guidelines file from the target; read the target's CLAUDE.md/AGENTS.md/ADRs only as context for its idioms.",
    "",
    commentDigest(prComments),
    "",
    "Produce ONE consolidated, deduplicated, severity-ranked worklist. Tag each item with exactly one disposition:",
    "- `P0` / `P1`: a blocker that gates the merge (P0 = must-fix correctness/security; P1 = structural).",
    "- `nit`: a minor suggestion that must NOT gate the merge.",
    "- `out-of-scope`: a real point that belongs to another issue; does NOT gate.",
    "- `escalate`: a finding that implies a risky structural change a fix agent should not apply blind.",
    "",
    "Output ONLY this JSON object as the final message, fenced as ```json:",
    '```json',
    '{ "items": [ { "severity": "P0", "title": "…", "detail": "…", "source": "review" } ] }',
    "```",
    "It MUST be valid JSON: every key and string value in double quotes, NEVER backticks as delimiters. A backtick, quote, or newline may appear only INSIDE a double-quoted, JSON-escaped string.",
    "An empty `items` array means the phase is clean.",
  ].join("\n");
}

function worklistDigest(worklist: Worklist): string {
  const gating = worklist.items.filter(
    (i) => i.severity === "P0" || i.severity === "P1" || i.severity === "escalate",
  );
  return gating
    .map((i) => `- [${i.severity}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`)
    .join("\n");
}

/** The JSON output contract shared by every fix prompt (fixed | escalate). */
const FIX_OUTCOME_CONTRACT = [
  "Output ONLY one of these JSON objects as the final message, fenced as ```json:",
  '```json',
  '{ "outcome": "fixed" }',
  "```",
  "or, to escalate:",
  '```json',
  '{ "outcome": "escalate", "question": { "headline": "…", "feature": "…", "whereWeStand": "…", "decision": "…", "options": ["…"], "stakes": "…", "recommendation": "…" } }',
  "```",
  "It MUST be valid JSON: every key and string value in double quotes, NEVER backticks as delimiters. A backtick, quote, or newline may appear only INSIDE a double-quoted, JSON-escaped string.",
];

/**
 * Fix prompt for a rebase conflict (issue #41 / ADR-0014, containerised by #273). A sibling PR
 * merged into base while this PR was under review and the two touch the same code, so the branch
 * must be rebased onto base. Under the container model the fix agent runs in a fresh clone of
 * the PR branch where NO rebase is in progress — it STARTS one, resolves the conflicts, and
 * reports `fixed` WITHOUT pushing: the runner force-pushes the rewritten history (force-push is
 * blocked in agent sessions, DESIGN §8), exactly as the harness owned it in the in-process past.
 * The "never resolve blind" rule routes risky structural divergences to `escalate`.
 */
function buildRebaseConflictPrompt(
  issue: Issue,
  mode: Mode,
  worklist: Worklist,
  buildCommand: string,
  testCommand: string,
  baseBranch: string | undefined,
): string {
  const base = baseBranch ?? "the base branch";
  const verify =
    mode === "infra"
      ? `run \`${buildCommand}\` and re-verify your reconciliation in a mode-appropriate way (the test gate does not apply to a \`mode:infra\` change)`
      : `run \`${buildCommand}\` and \`${testCommand}\` — both must pass`;
  return [
    `A sibling PR merged into \`${base}\` while this PR (issue #${issue.number}) was under review, and the two touch the same code. Your clone is on this PR's branch — bring it current with ${base} by REBASING onto it (start a fresh rebase here; none is in progress yet).`,
    "",
    `The base ref is already fetched into your clone as \`origin/${base}\`. Start the rebase:`,
    `- \`git rebase origin/${base}\``,
    "",
    "It will stop on the conflicts below. Resolve every one:",
    worklistDigest(worklist),
    "",
    "Mechanics — this is a rebase, NOT a normal commit:",
    "- Open each conflicted file and reconcile BOTH sides: preserve the intent of this branch's change AND the change already on the base branch. Never blindly keep one side and delete the other, and never throw away base's work just to make the conflict markers disappear.",
    "- After resolving a file, stage it with `git add <file>`. When every conflict in the current step is staged, run `git rebase --continue`.",
    "- The rebase may stop again on a later commit — repeat resolve → `git add` → `git rebase --continue` until the rebase reports it is complete. Do NOT run `git commit`, `git merge`, or `git rebase --abort`.",
    "",
    `Once the rebase completes, ${verify}. Do NOT push: once you report \`fixed\`, the runner force-pushes the rebased branch for you (force-push is blocked inside agent sessions; the harness owns the rebase push, and a plain \`git push\` would be rejected as non-fast-forward anyway).`,
    "",
    "Never resolve blind: if a conflict reflects a risky structural divergence — base deleted, moved, or heavily refactored code this branch depends on, or two semantically incompatible changes that you cannot reconcile with confidence — report `escalate` instead of guessing. Leave the rebase where it is (do not abort it) and escalate.",
    "",
    ...FIX_OUTCOME_CONTRACT,
  ].join("\n");
}

/**
 * Build the operator guidance injected into the fix agent when a review-origin
 * pause resumes the review loop (issue #9): a `review-maxed` heal-card or a
 * fix-agent `escalate`. The operator answered the question; the fix agent applies
 * that ruling as it resolves the worklist at the re-entered phase. Folds the
 * decision asked and the answer given into one block.
 */
export function buildHealGuidance(question: EscalationQuestion, answer: RalphAnswer): string {
  return [
    "An operator answered an open question on this PR — apply their ruling as you resolve the worklist:",
    `Decision asked: ${question.decision}`,
    `Operator's answer: ${answer.text}`,
  ].join("\n");
}

/**
 * The slice of a {@link FixContext} the fix prompt reads. The fix agent already
 * holds a `FixContext`; the prompt builder takes it as-is (plus the resolved
 * build/test commands from config) rather than re-flattening it into positionals.
 */
export type FixPromptContext = Pick<
  FixContext,
  | "issue"
  | "mode"
  | "phase"
  | "worklist"
  | "behaviourPreserving"
  | "baseBranch"
  | "guidance"
  | "rebaseConflict"
  | "reviewComment"
>;

/** Build the user prompt for a fix attempt; the agent outputs a JSON outcome. */
export function buildFixPrompt(
  ctx: FixPromptContext,
  buildCommand: string,
  testCommand: string,
): string {
  const { issue, mode, phase, worklist, behaviourPreserving, baseBranch, guidance, rebaseConflict, reviewComment } =
    ctx;
  // A rebase-conflict fix is a different job (start + resolve the rebase; the runner pushes),
  // so it gets its own prompt rather than the generic "commit and push" gate.
  if (rebaseConflict) {
    return buildRebaseConflictPrompt(issue, mode, worklist, buildCommand, testCommand, baseBranch);
  }
  // `mode:infra` drops the test gate (DESIGN §3): keep the build green and
  // re-verify in a mode-appropriate way rather than gating on a test suite.
  const gate =
    mode === "infra"
      ? `After fixing, keep the build green — run \`${buildCommand}\` — and re-verify your change in a mode-appropriate way (the test gate does not apply to a \`mode:infra\` change). Then commit and push to the PR branch.`
      : `After fixing, keep the build and tests green — run \`${buildCommand}\` and \`${testCommand}\`, both must pass — then commit and push to the PR branch.`;
  // A review-phase fix reads its findings from the PR (GitHub is the source of
  // truth, issue #47): the rolling `ralph-review` comment for this phase is
  // authoritative, alongside any new automated/human comments since. The inline
  // digest below is only a cache that may be stale. A CI-gate/conflict fix has no
  // such comment — its inline worklist is authoritative.
  const sourcing = reviewComment
    ? [
        `The authoritative worklist for this fix is the latest \`ralph-review\` comment for phase ${reviewComment.phase} on PR #${reviewComment.prNumber}. Read that comment (and any new automated/human PR comments since) before you start — it is the source of truth; the inline list below is only a cache that may be stale.`,
        "",
      ]
    : [];
  return [
    `Resolve the review worklist for issue #${issue.number} (phase ${phase}).`,
    "",
    // A heal re-entry injects the operator's ruling ahead of the worklist so the
    // fix agent applies it rather than re-deriving the maxed-out decision blind.
    ...(guidance ? ["Operator guidance:", guidance, ""] : []),
    ...sourcing,
    "Worklist (gating items — resolve every one):",
    worklistDigest(worklist),
    "",
    behaviourPreserving
      ? "These are PHASE 2 structural fixes: they MUST be behaviour-preserving. Do not change observable behaviour; if a fix would, escalate instead."
      : "Apply the P0/P1 fixes to make the code correct.",
    "",
    gate,
    "",
    "If a finding implies a risky structural change (e.g. 'delete this whole layer') that you should not apply blind, call `escalate` instead of applying it.",
    "",
    ...FIX_OUTCOME_CONTRACT,
  ].join("\n");
}
