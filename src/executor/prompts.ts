/**
 * Impl-session prompts (DESIGN §3 "Implementation call"). Mode selects the body:
 * `mode:tdd` drives red-green-refactor to a green suite; `mode:infra` drops the
 * test gate for a mode-appropriate verification; `mode:ui` verifies by rendering —
 * headless-chromium screenshots delivered to the PR via net-zero branch commits.
 * Every prompt embeds the two
 * standing conventions — the no-deferral rule and the design-authority rule
 * (CONTEXT) — so the agent's only endgame is *finish as designed* or *escalate*.
 */

import type { TargetConfig } from "../config/schema";
import type { Issue } from "../github/types";
import type { Mode } from "../store/types";
import { buildLaunchMarker } from "../github/marker";
import type { EscalationQuestion } from "../review/escalation";
import type { RalphAnswer } from "../hitl/answer";
import type { StuckHealGuidance } from "../hitl/heal-readmit";

/** Appended to the claude_code system prompt for every impl session. */
export const SYSTEM_APPEND = [
  "You are an autonomous implementation agent in the ralph-autopilot daemon.",
  "You run with fresh context every time — derive truth from the code and GitHub, never from memory of past runs.",
  "",
  "Two rules are binding:",
  "- No-deferral rule: never end with hedging tails ('one thing I didn't do', 'we should defer X'). If it matters, do it; if it doesn't, it is not worth mentioning. There is no 'deferred items' outcome.",
  "- Design-authority rule: the design of record (ADRs, DESIGN.md, the target repo's conventions) is binding, not advisory. If faithful implementation hits an obstacle, resolve it in the direction the design already committed to — never silently swap a different architecture, library, or approach to route around it. If a binding decision genuinely cannot be honoured, escalate rather than deviating.",
].join("\n");

/**
 * The stuck-budget guidance (DESIGN §3, CONTEXT: stuck budget). Two hard ceilings
 * bound every agent — a wall-clock the daemon enforces, and this bounded effort
 * budget the agent enforces on itself with the `stuck` tool.
 */
const STUCK_BUDGET = [
  "You run under a bounded effort budget. If you exhaust it — you have retried the same failure too",
  "many times (`fix-iterations`), made many edits and the build/tests still will not go green",
  "(`no-green-build`), or you judge the task cannot be completed as scoped (`futility`) — call the",
  "`stuck` tool to self-stop with no PR. Use `stuck` only when no human answer would help; if a human",
  "*decision* would unblock you, `escalate` instead.",
].join("\n");

function modeInstructions(mode: Mode, config: TargetConfig): string {
  if (mode === "tdd") {
    return [
      "This is a `mode:tdd` issue. Work test-first (red → green → refactor):",
      "1. Write a failing test that captures the acceptance criteria.",
      "2. Implement the minimum to make it pass.",
      "3. Refactor with the suite green.",
      `Build with \`${config.commands.build}\` and test with \`${config.commands.test}\`; both must pass before you open the PR.`,
    ].join("\n");
  }
  if (mode === "ui") {
    return [
      "This is a `mode:ui` issue (view-layer work). Verification is *rendering*, not a test gate on pixels:",
      `1. Build with \`${config.commands.build}\`; it must pass before you open the PR.`,
      "2. Write unit/component tests where they are sensible — they are additive, never a gate on pixel output.",
      "3. Render the changed surface with headless chromium (baked into this image), e.g.",
      "   `chromium --headless --screenshot=<file>.png <url-or-file>`, and capture screenshot(s) of what changed.",
      "4. Deliver the screenshots to the PR via NET-ZERO branch commits: commit the PNGs to the PR branch,",
      "   embed them in the PR body as pinned-SHA `https://raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/<path>`",
      "   image links, then REMOVE the files in a follow-up commit — the squash-merge must land no screenshot files.",
      "5. The PR body must state exactly what was rendered and how (page/route, viewport, command used).",
      "If chromium is missing, or the surface cannot be rendered without an unavailable backend, `escalate` —",
      "never open a PR with unverified rendering described as verified.",
    ].join("\n");
  }
  return [
    "This is a `mode:infra` issue (no-code / no-test work). The test gate does not apply — do NOT",
    "write a test suite as the merge gate, and do not block on red-green-refactor.",
    `Instead, complete with a mode-appropriate verification (e.g. \`${config.commands.build}\`, a dry-run, a config lint, or a schema/plan check) and describe exactly what you verified, and how, in the PR body.`,
  ].join("\n");
}

/**
 * The heal block woven into a *re-admitted* impl prompt (#86). A prior attempt on
 * this issue bounded out (`agent-stuck`) and the operator answered its stuck-card
 * through `ralph-answer`, re-admitting the issue for a fresh run. The stuck run kept
 * no WIP branch, so this is a clean start — but the new agent must begin knowing why
 * the last attempt stopped (the stuck-card's category + the agent's reason) and what
 * the operator wants done differently (the answer). Without this the re-admitted
 * agent retries blind, exactly the dead end #86 removes.
 */
function stuckHealBlock(stuckHeal: StuckHealGuidance): string[] {
  return [
    "--- a previous attempt stopped; the operator has given guidance ---",
    "An earlier run on this issue stopped before opening a PR. There is no prior WIP branch —",
    "you are starting fresh — but begin by reading why it stopped and what to do differently:",
    "",
    stuckHeal.question.headline,
    stuckHeal.question.whereWeStand,
    "",
    "Operator guidance:",
    stuckHeal.answer.text,
    "--- end previous-attempt guidance ---",
    "",
  ];
}

/**
 * Build the user prompt for an impl session. When `stuckHeal` is present the issue
 * is being **re-admitted** after a stuck terminal the operator healed (#86): the
 * operator's guidance is woven in so the fresh agent does not retry blind.
 */
export function buildImplPrompt(
  issue: Issue,
  mode: Mode,
  branch: string,
  config: TargetConfig,
  stuckHeal?: StuckHealGuidance,
): string {
  const marker = buildLaunchMarker({ issueNumber: issue.number, branch });
  return [
    `Implement GitHub issue #${issue.number} of ${config.targetRepo}, end to end.`,
    "",
    `Title: ${issue.title}`,
    "",
    "--- issue body ---",
    issue.body,
    "--- end issue body ---",
    "",
    ...(stuckHeal ? stuckHealBlock(stuckHeal) : []),
    modeInstructions(mode, config),
    "",
    "You are already on the correct git worktree and branch — implement, commit, and push here.",
    "Implement the FULL scope of the acceptance criteria. No deferral, no partial completion with caveats.",
    "",
    "When done, open a pull request with the GitHub CLI / MCP. The PR body MUST:",
    `- contain the line \`Closes #${issue.number}\` so merging closes the issue, and`,
    `- contain this exact marker on its own line: \`${marker}\``,
    "",
    STUCK_BUDGET,
    "",
    "Your only outcomes are: PR opened, escalate, or stuck. Never stop with work left undone and unmentioned.",
  ].join("\n");
}

/** The question + answer injected when a paused run resumes. */
export interface ResumeInjection {
  question: EscalationQuestion;
  answer: RalphAnswer;
}

/**
 * Build the user prompt for a *resumed* impl session (CONTEXT: resume, not
 * restart). The agent is back on its own WIP branch — the work it had done before
 * pausing is already committed there — with the operator's ruling injected. It
 * continues from where it left off; it does not start over.
 */
export function buildResumePrompt(
  issue: Issue,
  mode: Mode,
  branch: string,
  config: TargetConfig,
  resume: ResumeInjection,
): string {
  const { question, answer } = resume;
  return [
    `Resume work on GitHub issue #${issue.number} of ${config.targetRepo}.`,
    "",
    `Title: ${issue.title}`,
    "",
    "You previously paused this issue to escalate a decision to the operator. You are back on",
    `your own WIP branch \`${branch}\` — your earlier work is already committed here. Continue from`,
    "where you left off; do NOT start over from a clean slate.",
    "",
    "--- the question you escalated ---",
    `${question.headline}`,
    `Decision: ${question.decision}`,
    "--- the operator's answer ---",
    answer.text,
    "--- end answer ---",
    "",
    "Apply the operator's ruling and carry the issue to completion.",
    "",
    "--- issue body ---",
    issue.body,
    "--- end issue body ---",
    "",
    modeInstructions(mode, config),
    "",
    "Implement the FULL scope of the acceptance criteria. No deferral, no partial completion with caveats.",
    "",
    "When done, ensure a pull request is open from this branch (update the existing draft if present).",
    `The PR body MUST contain the line \`Closes #${issue.number}\` and the ralph-launch marker.`,
    "",
    STUCK_BUDGET,
    "",
    "Your only outcomes are: PR ready for review, escalate again, or stuck. Never stop with work left undone and unmentioned.",
  ].join("\n");
}
