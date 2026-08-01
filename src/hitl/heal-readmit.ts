/**
 * **Retired lane** (#86 → ADR-0042 / issue #43). `agent-stuck` was once a *healable*
 * human-attention state: the operator answered its stuck-card through `ralph-answer`, which
 * swapped `agent-stuck → ready-for-agent`, and because a stuck run kept no WIP branch the next
 * tick **re-admitted** a fresh run with the operator's guidance injected into its impl prompt.
 * `findStuckHealGuidance` was the GitHub-only detector for that guidance (the latest
 * stuck-card, plus the `ralph-answer` that post-dated it).
 *
 * The triage cutover deleted the mechanism at its root: `agent-stuck` is now a terminal only a
 * completed master adjudication may select, `ANSWERABLE_LABELS` no longer contains it, and
 * `hitl/queue.ts` types such an issue `terminal` and refuses to serve it. No `ralph-answer` can
 * therefore ever post-date a stuck-card, so the detector's input is never written — it would
 * have been a second, dormant lifecycle implementation sitting behind the live one, and issue
 * #43 is explicit that only one may exist. It is gone; the executor no longer reads the thread
 * for guidance, and a re-admitted issue starts from its (re-scoped) body.
 *
 * What remains is the *shape* the impl prompt still accepts. `executor/agent.ts`
 * (`AgentRunContext.stuckHeal`) and `executor/prompts.ts` (`stuckHealBlock`) still carry the
 * optional field; nothing populates it any more, so it renders nothing. Removing that plumbing
 * is a follow-up in those modules — the type stays here, and only here, so there is exactly one
 * declaration to delete when it goes.
 */

import type { EscalationQuestion } from "../review/escalation";
import type { RalphAnswer } from "./answer";

/**
 * Operator guidance threaded into a re-admitted run's impl prompt. **Never produced** since
 * the triage cutover (see the module note); retained only as the type of the vestigial
 * `stuckHeal` field on the agent run context.
 */
export interface StuckHealGuidance {
  /** The stuck-card the prior attempt posted — its fields say why it stopped. */
  question: EscalationQuestion;
  /** The operator's answer to that stuck-card — the guidance to inject. */
  answer: RalphAnswer;
}
