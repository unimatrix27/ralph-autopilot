/**
 * The **`stuck`** tool — the agent half of the stuck budget (DESIGN §3,
 * CONTEXT: stuck budget / agent-stuck). It is the bounded-effort escape hatch: an
 * agent calls it to *self-stop* — with no PR — when it has exhausted its budget:
 * too many fix iterations on one failure, too many edits without a green build, or
 * self-judged futility. Distinct from `escalate` (which checkpoints a draft PR and
 * asks a human a question) and from `review-maxed` (which has a PR).
 *
 * The tool only records the agent's self-report; the executor owns the single
 * side effect of labelling the issue `agent-stuck` and tearing the worktree down,
 * so the wall-clock kill (daemon-imposed, no tool call) and this self-stop share
 * one terminal path. The `category` enum admits only the three self-stop reasons —
 * `wall-clock` is daemon-imposed and never a valid tool category.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** The MCP server the `stuck` tool shares with `escalate`. */
export const STUCK_SERVER = "ralph";
/** The fully-qualified tool name the agent calls. */
export const STUCK_TOOL = "mcp__ralph__stuck";

/** The three conditions under which an agent may self-stop on its stuck budget. */
export const STUCK_CATEGORIES = ["fix-iterations", "no-green-build", "futility"] as const;
export type StuckSelfStopCategory = (typeof STUCK_CATEGORIES)[number];

/** Stuck categories the daemon records — the self-stop set plus the wall-clock kill. */
export type StuckCategory = StuckSelfStopCategory | "wall-clock";

export interface StuckReport {
  category: StuckCategory;
  /** Plain-language account of why the bounded budget is exhausted. */
  reason: string;
}

const stuckReportShape = {
  category: z.enum(STUCK_CATEGORIES),
  reason: z.string().min(1, "reason is required"),
} as const;

const stuckReportSchema = z.object(stuckReportShape).strict();

const DESCRIPTION = [
  "Self-stop on your stuck budget and end the session with NO pull request. Call this — not escalate —",
  "when you have exhausted your bounded effort and further work is not productive:",
  "`fix-iterations` (you have retried the same failure too many times), `no-green-build`",
  "(too many edits and the build/tests still will not go green), or `futility` (you judge the task",
  "cannot be completed as scoped). The issue is labelled `agent-stuck` for a human to look at.",
  "Prefer escalate when a human *decision* would unblock you; use stuck only when nothing they could",
  "answer would help. `reason` is required: state plainly what you tried and why you are stopping.",
].join(" ");

/** Result of a `tool()`-built stuck tool, for direct unit testing of its handler. */
export type StuckTool = ReturnType<typeof createStuckTool>;

/**
 * Build the `stuck` tool. `onStuck` records the validated self-report (the runner
 * captures it so it can return `stuck` and the executor performs the terminal side
 * effect). It runs only after the input validates against the strict schema.
 */
export function createStuckTool(onStuck: (report: StuckReport) => void) {
  return tool("stuck", DESCRIPTION, stuckReportShape, async (args): Promise<CallToolResult> => {
    const parsed = stuckReportSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `stuck rejected — ${detail}. Re-call stuck with a valid category (${STUCK_CATEGORIES.join(", ")}) and a non-empty reason.`,
          },
        ],
      };
    }
    onStuck(parsed.data);
    return {
      content: [
        {
          type: "text",
          text: "Stuck recorded. The issue will be labelled agent-stuck for a human. Stop now — do not open a PR.",
        },
      ],
    };
  });
}
