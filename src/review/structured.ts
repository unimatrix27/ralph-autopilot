/**
 * The provider-agnostic definitions of "a review pass" and "a fix attempt" (issue #131).
 * The in-container review/fix session hosts (`createReviewSessionHost`/`createFixSessionHost`) —
 * driving whichever {@link SessionBackend} they build (a Claude backend on the container's
 * mounted login) — delegate here, so there is exactly one place that builds the prompt, drives
 * the shared structured-output retry/parse contract ({@link runStructuredWithBackend}), and
 * validates the worklist / fix outcome. Swapping the provider is swapping the
 * {@link SessionBackend}; the contract above it is identical.
 */

import { z } from "zod";
import type { TargetConfig } from "../config/schema";
import { extractJsonObject, runStructuredWithBackend } from "../executor/structured-session";
import type { SessionBackend } from "../providers/backend";
import type { FixContext, FixOutcome, ReviewContext } from "./agents";
import { escalationQuestionSchema } from "./escalation";
import { buildFixPrompt, buildReviewPrompt, REVIEW_SYSTEM_APPEND } from "./prompts";
import { parseWorklist, type Worklist } from "./worklist";

/**
 * The fix session's structured-output contract: exactly `fixed` or `escalate` (with a
 * question). Lives here — the one owner of the fix attempt — so every provider validates
 * the same shape.
 */
export const fixOutcomeSchema = z.union([
  z.object({ outcome: z.literal("fixed") }).strict(),
  z.object({ outcome: z.literal("escalate"), question: escalationQuestionSchema }).strict(),
]);

/**
 * Run one review pass through any {@link SessionBackend} and return the consolidated,
 * deduped, severity-ranked worklist. The session-kind rubric ({@link REVIEW_SYSTEM_APPEND})
 * is passed as `systemAppend`: the Claude backend appends it to the system prompt; the
 * Codex backend folds it into the prompt.
 */
export async function reviewWithBackend(backend: SessionBackend, ctx: ReviewContext): Promise<Worklist> {
  const prompt = buildReviewPrompt(ctx.issue, ctx.mode, ctx.phase, ctx.prNumber, ctx.prComments);
  return runStructuredWithBackend(
    backend,
    { prompt, worktreePath: ctx.worktreePath, systemAppend: REVIEW_SYSTEM_APPEND, abortSignal: ctx.abortSignal },
    (text) => parseWorklist(extractJsonObject(text)),
  );
}

/**
 * Run one fix attempt through any {@link SessionBackend} and map its structured output to
 * a {@link FixOutcome}. `config` supplies the per-target build/test commands the fix
 * prompt gates on.
 */
export async function fixWithBackend(
  backend: SessionBackend,
  config: TargetConfig,
  ctx: FixContext,
): Promise<FixOutcome> {
  const prompt = buildFixPrompt(ctx, config.commands.build, config.commands.test);
  const parsed = await runStructuredWithBackend(
    backend,
    { prompt, worktreePath: ctx.worktreePath, systemAppend: REVIEW_SYSTEM_APPEND, abortSignal: ctx.abortSignal },
    (text) => fixOutcomeSchema.parse(extractJsonObject(text)),
  );
  return parsed.outcome === "fixed" ? { kind: "fixed" } : { kind: "escalate", question: parsed.question };
}
