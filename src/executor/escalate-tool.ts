/**
 * The custom **`escalate`** tool (DESIGN §6, ADR-0004) — emphatically *not*
 * Claude's built-in `AskUserQuestion`, which blocks the live session for an
 * in-conversation pick. `escalate` is asynchronous: calling it checkpoints the
 * agent's WIP, writes a structured `ralph-question`, frees the slot, and ends the
 * session. The daemon resumes from the WIP branch once an answer lands.
 *
 * The input schema is the operator-attention forcing function — `headline ·
 * feature · where_we_stand · decision · options? · stakes · recommendation`, with
 * `stakes` required. Validation happens at the tool boundary: a call missing any
 * required field is rejected (the handler returns an error and the side effect
 * never runs), so the agent is forced to re-ask with the field filled in.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  escalationQuestionSchema,
  escalationQuestionShape,
  evaluateEscalationBar,
  type EscalationQuestion,
} from "../review/escalation";
import { createStuckTool, type StuckReport } from "./stuck-tool";

/** The MCP server name the `escalate` tool is registered under. */
export const ESCALATE_SERVER = "ralph";
/** The fully-qualified tool name the agent calls. */
export const ESCALATE_TOOL = "mcp__ralph__escalate";

/**
 * The tool prompt (issue #22). It encodes three things the operator's scarcest
 * resource — attention — depends on: **(A)** the escalation bar, tied to the
 * design-authority rule (ADR-0011) — escalate only what a human is genuinely
 * better-positioned to decide, never an internal behaviour-preserving structure
 * call; **(B)** zero-context readability — `whereWeStand`/`stakes` must be rulable
 * without reading the diff; **(C)** the pre-send self-check. Exported so the bar is
 * directly testable.
 */
export const ESCALATE_DESCRIPTION = [
  "Escalate a decision to the human operator and stop — never AskUserQuestion. Calling it checkpoints",
  "your work-in-progress to a draft PR, posts a structured ralph-question to GitHub, frees your slot,",
  "and ends your session; an operator answers out of band and the daemon resumes you from your branch",
  "with the answer injected. The operator's attention is the system's scarcest resource — an escalation",
  "that shouldn't exist, or that can't be ruled on without the code, is a product defect.",
  "",
  "THE BAR (what to escalate vs. decide-and-ADR). Escalate ONLY a decision a human is genuinely",
  "better-positioned to make: a product or behaviour choice, an ambiguous requirement, an irreversible",
  "or external effect, a financial-correctness or UX trade-off, or a hard blocker (a binding design",
  "decision you genuinely cannot honour). Do NOT escalate an internal, behaviour-preserving structure /",
  "layering / naming / abstraction call that the design of record or the repo's own conventions already",
  "imply — per the design-authority rule (ADR-0011) DECIDE it yourself in the direction the design",
  "committed to and record an ADR. Heuristic: if the design implies an answer, follow it; if answering",
  "the question requires having read the diff, you've either mis-framed it or shouldn't be escalating it.",
  "",
  "ZERO-CONTEXT READABILITY. Write `whereWeStand` and `stakes` for a reader who has NOT seen the code:",
  "define every domain term you use, and state each option's consequence in plain architecture/user",
  "terms — what breaks, what a user would notice, what becomes hard later. No bare symbol or file names",
  "as if the reader knows them. `stakes` is required: it translates the decision up to its",
  "architecture-level and user-facing consequences so the operator can rule without reloading your deep",
  "technical context.",
  "",
  "PRE-SEND SELF-CHECK. Before you emit, you MUST pass both: (1) 'Can I resolve this from the design +",
  "conventions?' — if yes, decide + ADR instead, do not escalate. (2) 'Would a non-implementer",
  "understand the stakes and consequences?' — if no, rewrite or don't send. The tool re-checks both and",
  "rejects an escalation that fails either, sending you back to decide-and-ADR or to rewrite.",
].join("\n");

/** Result of a `tool()`-built escalate tool, for direct unit testing of its handler. */
export type EscalateTool = ReturnType<typeof createEscalateTool>;

/**
 * Build the `escalate` tool. `onEscalate` performs the checkpoint side effect
 * (commit+push WIP, draft PR, `ralph-question`, label swap, resume context). It
 * is invoked only after the input validates against the full strict schema.
 */
export function createEscalateTool(onEscalate: (question: EscalationQuestion) => Promise<void>) {
  return tool(
    "escalate",
    ESCALATE_DESCRIPTION,
    escalationQuestionShape,
    async (args): Promise<CallToolResult> => {
      // Tool-boundary validation: reject (and force a re-ask) before any side
      // effect if a required field — including `stakes` — is missing or empty.
      const parsed = escalationQuestionSchema.safeParse(args);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `escalate rejected — the question is incomplete: ${detail}. Re-call escalate with every required field filled in (stakes is mandatory).`,
            },
          ],
        };
      }

      // The escalation bar (issue #22): even a complete question is rejected — with
      // no checkpoint side effect — if it is a design-resolvable internal structure
      // call (decide + ADR per ADR-0011 instead) or its stakes only parse with the
      // diff open (rewrite for a zero-context reader). The pre-send self-check, made
      // enforceable where it can be.
      const bar = evaluateEscalationBar(parsed.data);
      if (!bar.pass) {
        const detail = bar.failures.map((f) => f.message).join(" ");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `escalate rejected — this question does not clear the escalation bar. ${detail}`,
            },
          ],
        };
      }

      await onEscalate(parsed.data);
      return {
        content: [
          {
            type: "text",
            text: "Escalation recorded. Your WIP is checkpointed and a question was posted to the operator. Stop now — you will be resumed from your branch once it is answered.",
          },
        ],
      };
    },
  );
}

/**
 * Wrap the `escalate` tool in an in-process MCP server, ready to merge into a
 * session's `mcpServers`. The SDK runs it in-process — no subprocess, no extra
 * auth (ADR-0008).
 */
export function createEscalateServer(
  onEscalate: (question: EscalationQuestion) => Promise<void>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ESCALATE_SERVER,
    version: "1.0.0",
    tools: [createEscalateTool(onEscalate)],
  });
}

/** The side effects the agent's two custom exits (`stuck` always, `escalate` when wired) drive. */
export interface RalphToolHandlers {
  /** Records the `stuck` self-stop report (the runner relays it; the executor labels `agent-stuck`). */
  onStuck: (report: StuckReport) => void;
  /**
   * The `escalate` checkpoint side effect; absent → the server carries no `escalate` tool (the agent
   * cannot escalate from this run, e.g. no publisher was injected).
   */
  onEscalate?: (question: EscalationQuestion) => Promise<void>;
}

/**
 * Build the single `ralph` MCP server carrying the agent's two custom exits — `stuck` (always) and
 * `escalate` (only when an `onEscalate` side effect is wired). This is the one canonical place the
 * server identity (`ESCALATE_SERVER`/version) and the SDK's `SdkMcpToolDefinition<any>` element type
 * live, so the in-process agent ({@link import("./agent")}) and the in-container session
 * ({@link import("../container/in-container-session")}) cannot drift on the two wirings (issue #187).
 */
export function createRalphToolServer(handlers: RalphToolHandlers): McpSdkServerConfigWithInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the SDK's own Array<SdkMcpToolDefinition<any>>.
  const tools: SdkMcpToolDefinition<any>[] = [createStuckTool(handlers.onStuck)];
  if (handlers.onEscalate) {
    tools.push(createEscalateTool(handlers.onEscalate));
  }
  return createSdkMcpServer({ name: ESCALATE_SERVER, version: "1.0.0", tools });
}
