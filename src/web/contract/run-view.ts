/**
 * The **pure message → render-model transform** (epic #106, issue #111) — the testable
 * heart of the run-detail viewer (epic Testing Decisions: "message → render-model …
 * tested in the node vitest env"). It folds a {@link RunDetailResponse} (the run header,
 * the permanent domain timeline, and the verbose/prunable transcript) into a {@link RunView}
 * the UI renders directly:
 *
 *   - the **conversation** as an ordered item list — assistant/user/result messages with
 *     their tool calls **collapsed to one-line summaries** (the raw input/result kept for
 *     on-demand expansion), file edits resolved to **line diffs**, Bash resolved to a
 *     command + **ANSI-parsed** output + a pass/fail exit status, and `escalate`/`stuck`
 *     tool calls lifted to **inline cards**;
 *   - **phase dividers** carrying per-phase outcomes (impl ✓, review-1 att 1/3), interleaved
 *     with the messages by their shared `globalPosition`;
 *   - a **timeline spine** of domain events, each resolved to the item it should scroll to;
 *   - the **pruned marker** when the verbose log has aged out (the timeline still renders).
 *
 * Browser-safe (zod-typed inputs, pure helpers, **zero node imports**) so the UI imports it
 * from `@contract` and the node vitest exercises it. Tolerant by construction — like
 * {@link import("./live").transcriptLatestLine} it never throws on a shape it does not fully
 * understand; an unrecognised block/event degrades to a generic rendering.
 */
import type {
  RunDetailResponse,
  RunModeWire,
  RunStatusWire,
  TranscriptBlockWire,
  TranscriptPruneReasonWire,
} from "./run-detail";
import { isLiveRunStatus } from "./run-detail";
import type { Route } from "./primitives";
import { formatRoute } from "./route-view";

// ── render-model types ─────────────────────────────────────────────────────────

/** A semantic tone shared by badges/dividers/timeline nodes (mapped to the status palette). */
export type RenderTone = "neutral" | "success" | "danger" | "running" | "waiting" | "attention";

/** The disposition of a tool call: its result came back ok, errored, or is still pending. */
export type ToolStatus = "ok" | "error" | "pending";

/** A syntax-highlight token kind (drives a colour class in the diff/code renderer). */
export type CodeTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "punctuation"
  | "plain";

/** One highlighted token of a code line. */
export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

/** One row of a rendered file-edit diff. */
export interface DiffRow {
  kind: "add" | "del" | "context" | "meta";
  text: string;
  /** 1-based line in the old file, or null for an added / meta row. */
  oldLine: number | null;
  /** 1-based line in the new file, or null for a deleted / meta row. */
  newLine: number | null;
}

/** One styled run of ANSI-coloured terminal output. */
export interface AnsiSpan {
  text: string;
  /** A colour name (`red`, `brightGreen`, …) or null for the default foreground. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

/** A tool call's result, collapsed to a status + plain text (expandable on demand). */
export interface ToolResultView {
  status: ToolStatus;
  text: string;
}

/** A generic tool call (Read, Grep, …): one-line summary + raw input/result for expansion. */
export interface ToolRenderBlock {
  kind: "tool";
  id: string;
  toolName: string;
  /** A short, single-line collapsed summary (the most identifying input field). */
  summary: string;
  /** The raw tool input, kept for on-demand expansion. */
  input: unknown;
  status: ToolStatus;
  result: ToolResultView | null;
}

/** A file edit rendered as a syntax-highlightable line diff. */
export interface DiffRenderBlock {
  kind: "diff";
  id: string;
  toolName: string;
  filePath: string;
  /** Language inferred from the file extension (for syntax highlighting). */
  language: string;
  rows: DiffRow[];
  additions: number;
  deletions: number;
  status: ToolStatus;
  result: ToolResultView | null;
}

/** A Bash command with its ANSI-coloured output and pass/fail exit status. */
export interface BashRenderBlock {
  kind: "bash";
  id: string;
  command: string;
  description: string | null;
  status: ToolStatus;
  /** The parsed exit code if the result reported one, else null. */
  exitCode: number | null;
  /** The output as lines of ANSI-styled spans. */
  output: AnsiSpan[][];
  result: ToolResultView | null;
}

/** An `escalate` / `stuck` tool call, lifted to an inline card linking to the Inbox. */
export interface EscalationRenderBlock {
  kind: "escalation";
  id: string;
  variant: "escalate" | "stuck";
  headline: string;
  detail: string;
  status: ToolStatus;
}

/** A rendered content block within a conversation message. */
export type RenderBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ToolRenderBlock
  | DiffRenderBlock
  | BashRenderBlock
  | EscalationRenderBlock
  | { kind: "other"; raw: unknown };

/** A conversation message (an assistant/user/result turn) as a navigable item. */
export interface MessageItem {
  kind: "message";
  /** Stable anchor id (`gp-<globalPosition>`) the timeline scrolls to. */
  id: string;
  globalPosition: number;
  role: "assistant" | "user" | "result" | "system";
  blocks: RenderBlock[];
  /** Lowercased text index for in-transcript search. */
  searchText: string;
}

/** A phase divider carrying its per-phase outcome, interleaved with the messages. */
export interface PhaseDividerItem {
  kind: "phase";
  id: string;
  globalPosition: number;
  /** E.g. "Implementation", "Review · phase 1", "Thermo · phase 2", "CI gate". */
  label: string;
  /** E.g. "✓ passed", "att 1/3", "review-maxed (3/3)", "PR #42", or null. */
  outcome: string | null;
  tone: RenderTone;
  searchText: string;
}

/** One item of the rendered conversation: a message or a phase divider. */
export type RunViewItem = MessageItem | PhaseDividerItem;

/** One node of the clickable timeline spine. */
export interface TimelineNode {
  /** Own id (`tl-<globalPosition>`). */
  id: string;
  globalPosition: number;
  /** The raw event type (for the icon/colour). */
  type: string;
  label: string;
  detail: string | null;
  tone: RenderTone;
  /** The conversation item id this node scrolls to (its phase divider, or the next message). */
  targetId: string | null;
  /**
   * The route this phase dispatched on, present only on a `RouteResolved` node (ADR-0037 P3.2,
   * issue #165): its `{ provider, model, account }`. One route per container (no mid-phase
   * rotation) — a resume's re-dispatch is its own later node, never an in-phase transition.
   * Absent for every other node, and for a route-less (box-default) `RouteResolved`.
   */
  route?: Route;
}

/** The run header view model. */
export interface RunHeaderView {
  repo: string;
  issue: number;
  runId: string;
  status: RunStatusWire;
  statusLabel: string;
  statusTone: RenderTone;
  mode: RunModeWire;
  branch: string | null;
  prNumber: number | null;
  startedAt: string;
  updatedAt: string;
  /** Wall-clock duration in ms (updatedAt − startedAt), or null if unparseable. */
  durationMs: number | null;
  /** Non-zero per-phase fix-attempt counts. */
  fixAttempts: { phase: number; count: number }[];
  totalFixAttempts: number;
  /** A compact lifecycle summary, e.g. "impl ✓ · review-1 ✓ · merged". */
  phaseSummary: string;
}

/** The pruned-transcript marker, surfaced so the viewer can explain the missing conversation. */
export interface PrunedView {
  at: string;
  prunedMessageCount: number;
  reason: TranscriptPruneReasonWire;
}

/** The full render model the run-detail page consumes. */
export interface RunView {
  header: RunHeaderView;
  items: RunViewItem[];
  timeline: TimelineNode[];
  pruned: PrunedView | null;
}

/** One in-transcript search hit: the matching item and its ordinal among the hits. */
export interface SearchMatch {
  itemId: string;
  index: number;
}

// ── small pure utilities ────────────────────────────────────────────────────────

/** Max characters of a single collapsed summary line before it is elided. */
const MAX_SUMMARY = 140;
/** Max characters of captured result/output text retained in the view model. */
const MAX_RESULT = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return clamp(text.replace(/\s+/g, " ").trim(), MAX_SUMMARY);
}

const STATUS_LABELS: Record<RunStatusWire, string> = {
  running: "Running",
  "awaiting-answer": "Awaiting answer",
  "agent-stuck": "Agent stuck",
  "review-maxed": "Review maxed",
  "awaiting-ci": "Awaiting CI",
  "awaiting-merge": "Awaiting merge",
  merged: "Merged",
  closed: "Closed",
};

const STATUS_TONES: Record<RunStatusWire, RenderTone> = {
  running: "running",
  "awaiting-answer": "attention",
  "agent-stuck": "danger",
  "review-maxed": "danger",
  "awaiting-ci": "waiting",
  "awaiting-merge": "waiting",
  merged: "success",
  closed: "neutral",
};

// ── ANSI parsing ────────────────────────────────────────────────────────────────

const ANSI_FG: Record<number, string> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "brightBlack",
  91: "brightRed",
  92: "brightGreen",
  93: "brightYellow",
  94: "brightBlue",
  95: "brightMagenta",
  96: "brightCyan",
  97: "brightWhite",
};
const ANSI_BG: Record<number, string> = {
  40: "black",
  41: "red",
  42: "green",
  43: "yellow",
  44: "blue",
  45: "magenta",
  46: "cyan",
  47: "white",
  100: "brightBlack",
  101: "brightRed",
  102: "brightGreen",
  103: "brightYellow",
  104: "brightBlue",
  105: "brightMagenta",
  106: "brightCyan",
  107: "brightWhite",
};

interface AnsiStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function emptyStyle(): AnsiStyle {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function applySgr(style: AnsiStyle, codes: number[]): AnsiStyle {
  let next = { ...style };
  for (const code of codes) {
    if (code === 0) {
      next = emptyStyle();
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 39) {
      next.fg = null;
    } else if (code === 49) {
      next.bg = null;
    } else if (ANSI_FG[code]) {
      next.fg = ANSI_FG[code] ?? null;
    } else if (ANSI_BG[code]) {
      next.bg = ANSI_BG[code] ?? null;
    }
  }
  return next;
}

const ANSI_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Parse a string carrying ANSI SGR escape sequences into lines of styled spans. Pure and
 * tolerant: an unrecognised escape is dropped, never thrown on. Splits on `\n` so the
 * Bash renderer can lay output out line-by-line.
 */
export function parseAnsiLines(text: string): AnsiSpan[][] {
  const lines: AnsiSpan[][] = [];
  let current: AnsiSpan[] = [];
  let style = emptyStyle();
  let lastIndex = 0;

  const pushText = (chunk: string): void => {
    if (chunk.length === 0) {
      return;
    }
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      if (part.length > 0) {
        current.push({ text: part, ...style });
      }
      if (i < parts.length - 1) {
        lines.push(current);
        current = [];
      }
    }
  };

  ANSI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_PATTERN.exec(text)) !== null) {
    pushText(text.slice(lastIndex, match.index));
    const raw = match[1] ?? "";
    const codes = raw.length === 0 ? [0] : raw.split(";").map((c) => Number(c) || 0);
    style = applySgr(style, codes);
    lastIndex = ANSI_PATTERN.lastIndex;
  }
  pushText(text.slice(lastIndex));
  lines.push(current);
  return lines;
}

/** Strip ANSI escapes from a string (for the searchable text index). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// ── line diff (LCS) ──────────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  // Drop a single trailing newline so "a\n" is one line, not two.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

/**
 * A minimal LCS line diff: returns the rows to render old→new with 1-based line numbers.
 * Pure; O(n·m) over the two line arrays (the edit strings are small). Added-only input
 * (an empty `oldText`) yields all-add rows — the {@link Write}/new-file case.
 */
export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i]!, oldLine, newLine });
      i++;
      j++;
      oldLine++;
      newLine++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]!, oldLine, newLine: null });
      i++;
      oldLine++;
    } else {
      rows.push({ kind: "add", text: b[j]!, oldLine: null, newLine });
      j++;
      newLine++;
    }
  }
  while (i < n) {
    rows.push({ kind: "del", text: a[i]!, oldLine, newLine: null });
    i++;
    oldLine++;
  }
  while (j < m) {
    rows.push({ kind: "add", text: b[j]!, oldLine: null, newLine });
    j++;
    newLine++;
  }
  return rows;
}

// ── syntax highlighting (lightweight, dependency-free) ────────────────────────────

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

/** Infer a highlight language from a file path's extension, or "text" when unknown. */
export function languageForPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) {
    return "text";
  }
  const ext = filePath.slice(dot + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? "text";
}

const KEYWORDS = new Set([
  // a broad, language-agnostic set — over-matching a keyword is harmless colour.
  "const","let","var","function","return","if","else","for","while","do","switch","case","break",
  "continue","new","class","extends","implements","interface","type","enum","import","export","from",
  "default","async","await","yield","try","catch","finally","throw","typeof","instanceof","in","of",
  "this","super","static","public","private","protected","readonly","void","null","undefined","true",
  "false","def","elif","lambda","pass","with","as","is","not","and","or","none","True","False","func",
  "package","struct","fn","let","mut","pub","use","impl","match","select","go","defer","map","range",
  "echo","then","fi","done","local","exit",
]);

const HL_PATTERNS: { kind: CodeTokenKind; re: RegExp }[] = [
  { kind: "comment", re: /^(\/\/[^\n]*|#[^\n]*|--[^\n]*)/ },
  { kind: "string", re: /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/ },
  { kind: "number", re: /^(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/ },
  { kind: "plain", re: /^([A-Za-z_$][A-Za-z0-9_$]*)/ }, // identifier; reclassified below
  { kind: "punctuation", re: /^([{}()[\];:,.<>+\-*/%=!&|^~?@]+)/ },
  { kind: "plain", re: /^(\s+)/ },
];

/**
 * Tokenise one line of code into highlight tokens. A pragmatic, single-line, regex-based
 * tokeniser (no multi-line block-comment state) covering comments, strings, numbers,
 * keywords, function calls and punctuation — enough to colour a diff readably without a
 * heavyweight highlighter dependency. Pure and total: any leftover char becomes `plain`.
 */
export function highlightCode(line: string, _language = "text"): CodeToken[] {
  const tokens: CodeToken[] = [];
  let rest = line;
  let guard = 0;
  while (rest.length > 0 && guard++ < 10_000) {
    let matched = false;
    for (const { kind, re } of HL_PATTERNS) {
      const m = re.exec(rest);
      if (m && m[0].length > 0) {
        const text = m[0];
        let resolved: CodeTokenKind = kind;
        if (kind === "plain" && /^[A-Za-z_$]/.test(text)) {
          if (KEYWORDS.has(text)) {
            resolved = "keyword";
          } else if (rest.slice(text.length).match(/^\s*\(/)) {
            resolved = "function";
          }
        }
        tokens.push({ kind: resolved, text });
        rest = rest.slice(text.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ kind: "plain", text: rest[0]! });
      rest = rest.slice(1);
    }
  }
  return tokens;
}

// ── tool-result extraction ────────────────────────────────────────────────────────

/** Flatten a tool_result `content` (string | block array | object) into plain text. */
export function extractResultText(content: unknown): string {
  if (typeof content === "string") {
    return clamp(content, MAX_RESULT);
  }
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (isRecord(block) && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    });
    return clamp(parts.join("\n"), MAX_RESULT);
  }
  if (isRecord(content) && typeof content.text === "string") {
    return clamp(content.text, MAX_RESULT);
  }
  if (content == null) {
    return "";
  }
  return clamp(JSON.stringify(content), MAX_RESULT);
}

// ── tool-call classification ────────────────────────────────────────────────────

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function escalationVariant(name: string): "escalate" | "stuck" | null {
  const n = name.toLowerCase();
  if (n === "mcp__ralph__escalate" || n.endsWith("__escalate") || n === "escalate") {
    return "escalate";
  }
  if (n === "mcp__ralph__stuck" || n.endsWith("__stuck") || n === "stuck") {
    return "stuck";
  }
  return null;
}

/** A short, single-line rendering of a tool call's input (the most identifying field). */
export function summariseToolInput(input: unknown): string {
  if (typeof input === "string") {
    return oneLine(input);
  }
  if (!isRecord(input)) {
    return "";
  }
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) {
      return oneLine(v);
    }
  }
  return "";
}

function escalationCard(
  id: string,
  variant: "escalate" | "stuck",
  input: unknown,
  status: ToolStatus,
): EscalationRenderBlock {
  const rec = isRecord(input) ? input : {};
  if (variant === "escalate") {
    const headline = str(rec.headline) ?? str(rec.question) ?? str(rec.summary) ?? "Escalation";
    const detail = str(rec.stakes) ?? str(rec.whereWeStand) ?? str(rec.recommendation) ?? "";
    return { kind: "escalation", id, variant, headline: oneLine(headline), detail: clamp(detail, MAX_RESULT), status };
  }
  const headline = str(rec.reason) ?? str(rec.summary) ?? "Agent stuck";
  const category = str(rec.category);
  const detail = category ? `${category}: ${str(rec.reason) ?? ""}`.trim() : str(rec.reason) ?? "";
  return { kind: "escalation", id, variant, headline: oneLine(headline), detail: clamp(detail, MAX_RESULT), status };
}

function diffRowsForEdit(toolName: string, input: Record<string, unknown>): DiffRow[] {
  if (toolName === "Write") {
    return computeLineDiff("", typeof input.content === "string" ? input.content : "");
  }
  if (toolName === "NotebookEdit") {
    return computeLineDiff("", typeof input.new_source === "string" ? input.new_source : "");
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const rows: DiffRow[] = [];
    input.edits.forEach((edit, i) => {
      if (i > 0) {
        rows.push({ kind: "meta", text: "⋯", oldLine: null, newLine: null });
      }
      const e = isRecord(edit) ? edit : {};
      rows.push(
        ...computeLineDiff(
          typeof e.old_string === "string" ? e.old_string : "",
          typeof e.new_string === "string" ? e.new_string : "",
        ),
      );
    });
    return rows;
  }
  // Edit (and any unknown edit-shaped tool): old_string → new_string.
  return computeLineDiff(
    typeof input.old_string === "string" ? input.old_string : "",
    typeof input.new_string === "string" ? input.new_string : "",
  );
}

function bashBlock(id: string, input: Record<string, unknown>, result: ToolResultView | null, status: ToolStatus): BashRenderBlock {
  const command = typeof input.command === "string" ? input.command : "";
  const description = str(input.description);
  const rawOutput = result?.text ?? "";
  const exitMatch = rawOutput.match(/exit code:?\s*(\d+)/i);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  return {
    kind: "bash",
    id,
    command,
    description,
    status,
    exitCode,
    output: parseAnsiLines(rawOutput),
    result,
  };
}

function renderToolUse(block: Extract<TranscriptBlockWire, { kind: "tool_use" }>, result: ToolResultView | null): RenderBlock {
  const status: ToolStatus = result ? result.status : "pending";
  const id = block.id || `tool-${block.name}`;
  const variant = escalationVariant(block.name);
  if (variant) {
    return escalationCard(id, variant, block.input, status);
  }
  if (EDIT_TOOLS.has(block.name)) {
    const input = isRecord(block.input) ? block.input : {};
    const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
    const rows = diffRowsForEdit(block.name, input);
    return {
      kind: "diff",
      id,
      toolName: block.name,
      filePath,
      language: languageForPath(filePath),
      rows,
      additions: rows.filter((r) => r.kind === "add").length,
      deletions: rows.filter((r) => r.kind === "del").length,
      status,
      result,
    };
  }
  if (block.name === "Bash") {
    return bashBlock(id, isRecord(block.input) ? block.input : {}, result, status);
  }
  return {
    kind: "tool",
    id,
    toolName: block.name || "tool",
    summary: summariseToolInput(block.input),
    input: block.input,
    status,
    result,
  };
}

// ── phase / timeline derivation ──────────────────────────────────────────────────

function phaseLabel(phase: number): string {
  if (phase === 0) return "CI gate";
  if (phase === 2) return "Thermo · phase 2";
  return `Review · phase ${phase}`;
}

function phaseShort(phase: number): string {
  if (phase === 0) return "ci";
  if (phase === 2) return "thermo";
  return `review-${phase}`;
}

interface DomainEvent {
  globalPosition: number;
  type: string;
  data: Record<string, unknown>;
  /** The typed per-phase route a `RouteResolved` timeline entry carries (ADR-0037 P3.2, #165). */
  route?: Route;
}

function asPhase(data: Record<string, unknown>): number | null {
  return typeof data.phase === "number" ? data.phase : null;
}

interface DerivedTimeline {
  dividers: PhaseDividerItem[];
  nodes: TimelineNode[];
  prNumber: number | null;
  /** Tokens for the compact header summary, e.g. ["impl ✓", "review-1 ✓", "merged"]. */
  summaryTokens: string[];
}

function deriveTimeline(events: DomainEvent[]): DerivedTimeline {
  const dividers: PhaseDividerItem[] = [];
  const nodes: TimelineNode[] = [];
  // The latest divider per phase, to fold its attempts/outcome as later events arrive.
  const latestDividerForPhase = new Map<number, { item: PhaseDividerItem; attempts: number; passed: boolean; maxed: boolean }>();
  let implDivider: PhaseDividerItem | null = null;
  let prNumber: number | null = null;
  let merged = false;
  let stuck = false;

  for (const ev of events) {
    const gp = ev.globalPosition;
    const data = ev.data;
    switch (ev.type) {
      case "RunStarted": {
        implDivider = { kind: "phase", id: `phase-${gp}`, globalPosition: gp, label: "Implementation", outcome: null, tone: "running", searchText: "implementation" };
        dividers.push(implDivider);
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Run started", detail: null, tone: "running", targetId: null });
        break;
      }
      case "PrOpened": {
        prNumber = typeof data.prNumber === "number" ? data.prNumber : prNumber;
        if (implDivider) {
          implDivider.outcome = prNumber !== null ? `PR #${prNumber}` : "✓";
          implDivider.tone = "success";
        }
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "PR opened", detail: prNumber !== null ? `#${prNumber}` : null, tone: "neutral", targetId: null });
        break;
      }
      case "ReviewPhaseEntered": {
        const phase = asPhase(data) ?? 1;
        const item: PhaseDividerItem = { kind: "phase", id: `phase-${gp}`, globalPosition: gp, label: phaseLabel(phase), outcome: "att 0/3", tone: "neutral", searchText: phaseLabel(phase).toLowerCase() };
        dividers.push(item);
        latestDividerForPhase.set(phase, { item, attempts: 0, passed: false, maxed: false });
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: phaseLabel(phase), detail: "entered", tone: "neutral", targetId: null });
        break;
      }
      case "FixAttempted": {
        const phase = asPhase(data) ?? 1;
        const span = latestDividerForPhase.get(phase);
        if (span) {
          span.attempts += 1;
          if (!span.passed && !span.maxed) {
            span.item.outcome = `att ${span.attempts}/3`;
            span.item.tone = "waiting";
          }
        }
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Fix attempt", detail: `${phaseShort(phase)}`, tone: "waiting", targetId: null });
        break;
      }
      case "ReviewPhasePassed": {
        const phase = asPhase(data) ?? 1;
        const span = latestDividerForPhase.get(phase);
        if (span) {
          span.passed = true;
          span.item.outcome = "✓ passed";
          span.item.tone = "success";
        }
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: `${phaseLabel(phase)} passed`, detail: null, tone: "success", targetId: null });
        break;
      }
      case "ReviewMaxed": {
        const phase = asPhase(data) ?? 1;
        const span = latestDividerForPhase.get(phase);
        if (span) {
          span.maxed = true;
          span.item.outcome = `review-maxed (${span.attempts}/3)`;
          span.item.tone = "danger";
        }
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Review maxed", detail: phaseShort(phase), tone: "danger", targetId: null });
        break;
      }
      case "ReviewPassed":
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Review passed", detail: null, tone: "success", targetId: null });
        break;
      case "CiAwaited":
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Awaiting CI", detail: null, tone: "waiting", targetId: null });
        break;
      case "Escalated": {
        const headline = str(data.headline);
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Escalated", detail: headline ? oneLine(headline) : str(data.kind), tone: "attention", targetId: null });
        break;
      }
      case "QuestionAnswered":
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Question answered", detail: null, tone: "neutral", targetId: null });
        break;
      case "Resumed":
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Resumed", detail: null, tone: "running", targetId: null });
        break;
      case "RunStuck": {
        stuck = true;
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Agent stuck", detail: str(data.reason) ? oneLine(String(data.reason)) : null, tone: "danger", targetId: null });
        break;
      }
      case "Merged": {
        merged = true;
        prNumber = typeof data.prNumber === "number" ? data.prNumber : prNumber;
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Merged", detail: prNumber !== null ? `#${prNumber}` : null, tone: "success", targetId: null });
        break;
      }
      case "RunEnded": {
        const outcome = str(data.outcome) ?? "ended";
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Run ended", detail: outcome, tone: outcome === "merged" ? "success" : outcome === "stuck" ? "danger" : "neutral", targetId: null });
        break;
      }
      case "AnomalyDetected":
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Anomaly", detail: str(data.reason) ? oneLine(String(data.reason)) : null, tone: "danger", targetId: null });
        break;
      case "AnomalyCleared":
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: "Anomaly cleared", detail: null, tone: "success", targetId: null });
        break;
      case "RouteResolved": {
        // One route per container (ADR-0037/0038): this phase's single dispatched route, as its
        // own node — a cross-phase / resume account change is simply the next RouteResolved node,
        // never an in-phase A→B transition. A route-less (box-default) dispatch renders no route.
        const route = ev.route;
        nodes.push({
          id: `tl-${gp}`,
          globalPosition: gp,
          type: ev.type,
          label: "Route",
          detail: route ? formatRoute(route) : null,
          tone: "neutral",
          targetId: null,
          ...(route ? { route } : {}),
        });
        break;
      }
      default:
        nodes.push({ id: `tl-${gp}`, globalPosition: gp, type: ev.type, label: ev.type, detail: null, tone: "neutral", targetId: null });
    }
  }

  // Compact header summary tokens, in divider order, then the terminal.
  const summaryTokens: string[] = [];
  for (const d of dividers) {
    if (d.label === "Implementation") {
      summaryTokens.push(d.outcome ? "impl ✓" : "impl");
    } else {
      const phaseName = d.label.includes("Thermo") ? "thermo" : d.label.includes("CI") ? "ci" : d.label.toLowerCase().replace("review · phase ", "review-");
      const mark = d.outcome === "✓ passed" ? "✓" : d.outcome?.startsWith("review-maxed") ? "✗" : (d.outcome ?? "");
      summaryTokens.push(mark ? `${phaseName} ${mark}` : phaseName);
    }
  }
  if (merged) {
    summaryTokens.push("merged");
  } else if (stuck) {
    summaryTokens.push("stuck");
  }

  return { dividers, nodes, prNumber, summaryTokens };
}

// ── the transform ────────────────────────────────────────────────────────────────

/** Build the run-detail render model from the wire response. Pure and total. */
export function buildRunView(detail: RunDetailResponse): RunView {
  // 1. Domain timeline → phase dividers + clickable nodes (+ header bits).
  const domainEvents: DomainEvent[] = detail.timeline
    .map((e) => ({
      globalPosition: e.globalPosition,
      type: e.type,
      data: isRecord(e.data) ? e.data : {},
      // Carry the typed per-phase route through so the RouteResolved node can render it (#165).
      ...(e.route ? { route: e.route } : {}),
    }))
    .sort((a, b) => a.globalPosition - b.globalPosition);
  const derived = deriveTimeline(domainEvents);

  // 2. Pair every tool_result to its tool_use across the whole transcript.
  const resultsByToolUseId = new Map<string, ToolResultView>();
  let pruned: PrunedView | null = null;
  for (const entry of detail.transcript) {
    if (entry.type === "TranscriptPruned") {
      pruned = { at: entry.data.at, prunedMessageCount: entry.data.prunedMessageCount, reason: entry.data.reason };
      continue;
    }
    for (const block of entry.data.blocks) {
      if (block.kind === "tool_result") {
        resultsByToolUseId.set(block.toolUseId, {
          status: block.isError ? "error" : "ok",
          text: extractResultText(block.content),
        });
      }
    }
  }
  if (!pruned && detail.pruned) {
    pruned = { at: detail.pruned.at, prunedMessageCount: detail.pruned.prunedMessageCount, reason: detail.pruned.reason };
  }

  // 3. Transcript messages → conversation items (tool_result blocks folded into their calls).
  const messageItems: MessageItem[] = [];
  for (const entry of detail.transcript) {
    if (entry.type !== "TranscriptMessage") {
      continue;
    }
    const blocks: RenderBlock[] = [];
    const searchParts: string[] = [];
    for (const block of entry.data.blocks) {
      switch (block.kind) {
        case "text": {
          if (block.text.trim()) {
            blocks.push({ kind: "text", text: block.text });
            searchParts.push(block.text);
          }
          break;
        }
        case "thinking": {
          if (block.text.trim()) {
            blocks.push({ kind: "thinking", text: block.text });
            searchParts.push(block.text);
          }
          break;
        }
        case "tool_use": {
          const rendered = renderToolUse(block, resultsByToolUseId.get(block.id) ?? null);
          blocks.push(rendered);
          searchParts.push(searchTextForBlock(rendered));
          break;
        }
        case "tool_result":
          // Folded into the matching tool call above.
          break;
        default: {
          if (block.kind === "other" && block.raw != null) {
            blocks.push({ kind: "other", raw: block.raw });
          }
        }
      }
    }
    if (blocks.length === 0) {
      continue;
    }
    messageItems.push({
      kind: "message",
      id: `gp-${entry.globalPosition}`,
      globalPosition: entry.globalPosition,
      role: entry.data.role,
      blocks,
      searchText: searchParts.join("\n").toLowerCase(),
    });
  }

  // 4. Interleave messages + phase dividers by global position (dividers first on a tie).
  const items: RunViewItem[] = [...messageItems, ...derived.dividers].sort((a, b) => {
    if (a.globalPosition !== b.globalPosition) {
      return a.globalPosition - b.globalPosition;
    }
    return (a.kind === "phase" ? 0 : 1) - (b.kind === "phase" ? 0 : 1);
  });

  // 5. Resolve each timeline node to the item it scrolls to (nearest at/after its position).
  const timeline = derived.nodes.map((node) => ({ ...node, targetId: resolveTarget(node.globalPosition, items) }));

  // 6. Header.
  const header = buildHeader(detail, derived);

  return { header, items, timeline, pruned };
}

function searchTextForBlock(block: RenderBlock): string {
  switch (block.kind) {
    case "tool":
      return `${block.toolName} ${block.summary} ${block.result?.text ?? ""}`;
    case "diff":
      return `${block.toolName} ${block.filePath} ${block.rows.map((r) => r.text).join("\n")}`;
    case "bash":
      return `${block.command} ${block.output.map((line) => line.map((s) => s.text).join("")).join("\n")}`;
    case "escalation":
      return `${block.variant} ${block.headline} ${block.detail}`;
    default:
      return "";
  }
}

function resolveTarget(gp: number, items: RunViewItem[]): string | null {
  let best: RunViewItem | null = null;
  for (const item of items) {
    if (item.globalPosition >= gp) {
      best = item;
      break;
    }
  }
  if (best) {
    return best.id;
  }
  const last = items[items.length - 1];
  return last ? last.id : null;
}

function buildHeader(detail: RunDetailResponse, derived: DerivedTimeline): RunHeaderView {
  const run = detail.run;
  const started = Date.parse(run.startedAt);
  const updated = Date.parse(run.updatedAt);
  // `durationMs` is the SETTLED wall-clock — present only once the run is terminal. While the
  // run is live the row's `updated_at` is NOT advanced by status changes (the lifecycle status
  // is event-sourced, never written to the row — issue #83), so `updated - started` would
  // freeze the duration at the last row write (often `created_at`, i.e. "0s"). For a live run
  // we leave it null and the header ticks elapsed time from `startedAt` against its own clock.
  const durationMs =
    isLiveRunStatus(run.status) || !(Number.isFinite(started) && Number.isFinite(updated) && updated >= started)
      ? null
      : updated - started;
  const fixAttempts = Object.entries(run.fixAttempts)
    .map(([phase, count]) => ({ phase: Number(phase), count }))
    .filter((f) => Number.isFinite(f.phase) && f.count > 0)
    .sort((a, b) => a.phase - b.phase);
  const totalFixAttempts = fixAttempts.reduce((sum, f) => sum + f.count, 0);
  return {
    repo: run.repo,
    issue: run.issue,
    runId: run.runId,
    status: run.status,
    statusLabel: STATUS_LABELS[run.status],
    statusTone: STATUS_TONES[run.status],
    mode: run.mode,
    branch: run.branch,
    prNumber: run.prNumber ?? derived.prNumber,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    durationMs,
    fixAttempts,
    totalFixAttempts,
    phaseSummary: derived.summaryTokens.join(" · "),
  };
}

/** Find every conversation item whose text matches `query` (case-insensitive), in order. */
export function searchRunView(view: RunView, query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const matches: SearchMatch[] = [];
  for (const item of view.items) {
    const haystack = item.kind === "message" ? item.searchText : item.searchText;
    if (haystack.includes(needle)) {
      matches.push({ itemId: item.id, index: matches.length });
    }
  }
  return matches;
}
