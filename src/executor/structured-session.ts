/**
 * The structured-output SDK session — the shared substrate under every harness
 * agent that must return a single, machine-parseable JSON object (the review
 * worklist, a fix outcome, an auto-mode verdict). It drives one fresh-context,
 * OAuth-only, curated-MCP {@link runReapedWallClockedSession}, then parses + validates
 * the final message at the boundary, re-prompting with a louder JSON contract a
 * bounded number of times before surfacing a typed {@link AgentOutputParseError}.
 *
 * Extracted from the review SDK agents (issue #15) so the same #15 structured-output
 * path can back the review/fix runners AND the auto-mode classifier without either
 * directory depending on the other — both import this one owner.
 */

import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { TargetConfig } from "../config/schema";
import type { QueryFn } from "./agent";
import type { SessionReaper } from "./process-reaper";
import type { TranscriptSink } from "./transcript-sink";
import type { RateLimitSignal } from "../core/usage";
import { WallClockExceededError } from "./wall-clock";
import type { SessionBackend, SessionRequest } from "../providers/backend";
import { ClaudeSessionBackend } from "../providers/claude-backend";

/**
 * Thrown by {@link runStructuredSession} when an agent's final message cannot be
 * parsed/validated as the required structured output even after the bounded
 * re-prompt budget. A *contract* failure, not a fault: callers catch it and degrade
 * gracefully (the review loop maxes the phase out with a heal-card; the auto-mode
 * pass leaves the issue unmoded) rather than letting the raw `SyntaxError` crash the
 * run. The trigger in the wild is a prose-/code-heavy task whose agent leaks markdown
 * backticks into the JSON body, producing invalid JSON (e.g. #15, the dedup-comment-
 * codec cleanup — its own subject matter is backticks and prose).
 */
export class AgentOutputParseError extends Error {
  constructor(
    /** Total parse attempts made (initial + retries). */
    readonly attempts: number,
    /** The last parser/validation error message. */
    readonly lastError: string,
    /** The tail of the final unparseable message, surfaced on the heal-card. */
    readonly rawTail: string,
  ) {
    super(`agent produced unparseable structured output after ${attempts} attempt(s): ${lastError}`);
    this.name = "AgentOutputParseError";
  }
}

/**
 * Extract the last parseable JSON object from an agent's final message. Candidates
 * are tried newest-first — fenced ``` blocks (last to first), then top-level
 * balanced `{…}` spans (last to first) — and a candidate that fails to parse falls
 * through to the next instead of aborting, so a trailing fenced *code* snippet in a
 * prose-heavy review no longer shadows the real JSON object elsewhere in the
 * message. Each candidate gets a strict `JSON.parse`, then one {@link repairJson}
 * retry. Only a candidate parsing to a (non-array) object counts.
 */
export function extractJsonObject(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenced: string[] = [];
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    fenced.push(m[1]!.trim());
  }
  const candidates = [...fenced.reverse(), ...balancedObjectSpans(text).reverse()];
  for (const candidate of candidates) {
    const value = parseLeniently(candidate);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value;
    }
  }
  throw new Error("no parseable JSON object found in agent output");
}

/**
 * All top-level balanced `{…}` spans in `text`, in order. The scan tracks JSON
 * string literals (quotes + escapes) so a brace inside a string value — routine in
 * review findings that quote code — cannot corrupt the balance. An opener that
 * never closes (a stray `{` in prose) would swallow everything after it, so when a
 * pass ends inside such a span the scan restarts just past that opener.
 */
function balancedObjectSpans(text: string): string[] {
  const spans: string[] = [];
  let from = 0;
  while (from < text.length) {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"' && depth > 0) {
        inString = true;
      } else if (ch === "{") {
        if (depth === 0) {
          start = i;
        }
        depth++;
      } else if (ch === "}" && depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
    if (depth === 0 || start === -1) {
      break;
    }
    from = start + 1;
  }
  return spans;
}

/** Strict `JSON.parse`, then one repaired retry; `undefined` when both fail. */
function parseLeniently(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJson(candidate));
    } catch {
      return undefined;
    }
  }
}

/**
 * Repair the two dominant malformations in model-emitted JSON — bare control
 * characters (usually literal newlines) inside string literals, and trailing
 * commas before a closing `}`/`]` — leaving everything else untouched.
 */
function repairJson(candidate: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === "\\") {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else if (ch.charCodeAt(0) < 0x20) {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "," && /^\s*[}\]]/.test(candidate.slice(i + 1))) {
      // trailing comma: the next non-whitespace closes the container — drop it
    } else {
      out += ch;
    }
  }
  return out;
}

/** Everything one structured SDK session needs; the base for {@link runStructuredSession}. */
export interface StructuredSessionParams {
  config: TargetConfig;
  available: Record<string, McpServerConfig>;
  prompt: string;
  worktreePath: string;
  abortSignal?: AbortSignal;
  reaperFactory: () => SessionReaper;
  queryFn: QueryFn;
  /**
   * System-prompt append for this session kind (the review rubric, the auto-mode
   * rubric, …). Omit to inherit the impl session's append ({@link import("./prompts").SYSTEM_APPEND}).
   */
  systemAppend?: string;
  /**
   * `CLAUDE_CONFIG_DIR` of the OAuth login this session is bound to (ADR-0028): the
   * review/fix/moding runners route their credential the same way the impl runner
   * does. Absent → the box-default login.
   */
  configDir?: string;
  /**
   * Forward each streamed plan rate-limit signal to the meter, so a review/fix/moding
   * session's usage folds into its bound login's state and can trigger a failover
   * (ADR-0028). Absent → signals are dropped (e.g. tests).
   */
  onRateLimit?: (signal: RateLimitSignal) => void;
  /**
   * The transcript capture sink for this session (ADR-0030). Review/fix/moding sessions
   * route through this one substrate, so forwarding the sink here is what makes capture
   * uniform across them and the impl/resume runner. Absent → no capture (e.g. tests).
   */
  transcriptSink?: TranscriptSink;
}

/**
 * Corrective re-prompts allowed when an agent's final message will not parse as the
 * required structured output. A prose-/code-heavy task (e.g. #15) can make the agent
 * emit invalid JSON — backticks used as string delimiters; rather than crash the run
 * we re-run the session with a louder contract a bounded number of times.
 */
export const MAX_PARSE_RETRIES = 2;

/** Appended to the prompt on a retry, after the agent's prior output failed to parse. */
export const STRICT_JSON_REMINDER =
  "CRITICAL OUTPUT CONTRACT: a prior attempt's final message could not be parsed as JSON. " +
  "Your final message MUST be exactly one valid JSON object and nothing else — every key and " +
  "every string value wrapped in double quotes, NEVER backticks. A backtick, quote, newline or " +
  "other control character may appear ONLY inside a double-quoted, JSON-escaped string. No " +
  "markdown prose before or after the object.";

/**
 * Run a structured session through any {@link SessionBackend} and parse its final
 * message into structured output, retrying with a louder JSON contract when the output
 * is unparseable or invalid (bounded by {@link MAX_PARSE_RETRIES}). A
 * {@link WallClockExceededError} is never retried — it is a kill, not a contract
 * violation. On exhaustion throws {@link AgentOutputParseError} so the caller degrades
 * gracefully rather than the raw `SyntaxError` crashing the run.
 *
 * This is the provider-neutral retry/parse contract (issue #131): the same loop backs
 * the Claude and Codex review/fix runners and the moding classifier, so "a review pass"
 * / "a fix attempt" has one definition regardless of which provider produced the text.
 */
export async function runStructuredWithBackend<T>(
  backend: SessionBackend,
  req: SessionRequest,
  parse: (text: string) => T,
): Promise<T> {
  const attempts = MAX_PARSE_RETRIES + 1;
  let lastError = "";
  let rawTail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const prompt = attempt === 1 ? req.prompt : `${req.prompt}\n\n${STRICT_JSON_REMINDER}`;
    const text = await backend.run({ ...req, prompt });
    try {
      return parse(text);
    } catch (err) {
      if (err instanceof WallClockExceededError) {
        throw err;
      }
      lastError = err instanceof Error ? err.message : String(err);
      rawTail = text.slice(-500);
    }
  }
  throw new AgentOutputParseError(attempts, lastError, rawTail);
}

/**
 * Run a Claude SDK session and parse its final message into structured output. A thin
 * adapter (issue #131): it builds a {@link ClaudeSessionBackend} from the legacy
 * {@link StructuredSessionParams} and delegates to {@link runStructuredWithBackend}, so
 * every existing caller and test keeps its unchanged signature while the retry/parse
 * contract is now provider-neutral underneath.
 */
export async function runStructuredSession<T>(
  base: StructuredSessionParams,
  parse: (text: string) => T,
): Promise<T> {
  const backend = new ClaudeSessionBackend({
    config: base.config,
    available: base.available,
    reaperFactory: base.reaperFactory,
    queryFn: base.queryFn,
    configDir: base.configDir,
    onRateLimit: base.onRateLimit,
    transcriptSink: base.transcriptSink,
  });
  return runStructuredWithBackend(
    backend,
    {
      prompt: base.prompt,
      worktreePath: base.worktreePath,
      systemAppend: base.systemAppend,
      abortSignal: base.abortSignal,
    },
    parse,
  );
}
