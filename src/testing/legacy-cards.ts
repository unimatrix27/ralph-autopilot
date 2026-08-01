/**
 * Renderers for **pre-cutover** durable GitHub comments, for tests only.
 *
 * ADR-0042 retired the review heal-card: no code path posts one any more. But comments already
 * on GitHub outlive the build that wrote them, and the migration contract is explicit — old
 * `review-maxed` heal-cards must still *parse*, so an adopted issue can carry its evidence into
 * the master's context and a `ralph-answer` mid-flight is not stranded.
 *
 * So the renderer moves here rather than being deleted: production has no way to emit one, the
 * parser is still exercised against exactly the bytes production used to write, and the
 * retirement is enforceable (see `escalation.test.ts`) instead of aspirational.
 */

import { formatRalphQuestion, type EscalationQuestion } from "../review/escalation";

/** One blocker line, as the pre-cutover heal-card rendered it. */
export interface LegacyHealBlocker {
  severity: "P0" | "P1" | "escalate";
  title: string;
  detail?: string;
}

/** The exact {@link EscalationQuestion} the pre-cutover `buildHealCardQuestion` produced. */
export function legacyHealCardQuestion(input: {
  phase: 0 | 1 | 2;
  attempts: number;
  blockers: LegacyHealBlocker[];
}): EscalationQuestion {
  const { phase, attempts, blockers } = input;
  const concern = phase === 0 ? "CI" : phase === 1 ? "correctness" : "quality";
  const rendered = blockers.map((b) => `[${b.severity}] ${b.title}${b.detail ? ` — ${b.detail}` : ""}`);
  return {
    headline:
      phase === 0
        ? "CI gate maxed out (could not get checks green)"
        : `Review maxed out on ${concern} (phase ${phase})`,
    feature:
      phase === 0
        ? "Phase-0 CI gate (harness-owned merge)"
        : `Phase-${phase} ${phase === 1 ? "normal" : "behaviour-conserving"} review`,
    whereWeStand: [
      phase === 0
        ? `The fix agent spent its ${attempts} attempt(s) and CI is still not green:`
        : `The fix agent spent its ${attempts} attempt(s) and the phase-${phase} review still reports blockers:`,
      ...rendered.map((b) => `- ${b}`),
    ].join("\n"),
    decision:
      phase === 0
        ? "How should the failing CI checks be resolved?"
        : `How should the remaining phase-${phase} ${concern} blockers be resolved?`,
    options: [
      "Provide guidance and re-enable the run (heal) so the fix agent retries with it injected",
      "Accept the PR as-is and merge manually",
      "Close the PR and re-scope the issue",
    ],
    stakes:
      phase === 0
        ? "CI is red (or never reached a terminal state): the harness will not merge a PR whose checks are not green."
        : phase === 1
          ? "Correctness is unverified: merging now risks shipping behaviourally-wrong code to master."
          : "Behaviour is verified correct; only structural quality remains. The PR is mergeable but below the thermo-nuclear bar.",
    recommendation:
      "Answer with concrete guidance on the listed blockers so the daemon resumes the fix agent from its WIP branch.",
  };
}

/** The pre-cutover heal-card comment body, byte-for-byte as production used to write it. */
export function legacyHealCardComment(input: {
  phase: 0 | 1 | 2;
  attempts: number;
  blockers: LegacyHealBlocker[];
}): string {
  return formatRalphQuestion(legacyHealCardQuestion(input));
}
