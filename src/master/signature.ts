/**
 * The **normalized failure signature** (ADR-0041) — the identity of a failure *across*
 * attempts. The master loop budget turns on one question: "is this the same failure I
 * already tried to fix?" Answering it on raw text says *no* every time, because every rerun
 * carries a new head SHA, a new timestamp, a new temp path, a new duration. The budget would
 * then never bind and the master would loop until the wall-clock killed it.
 *
 * So the signature is the failure with everything *incidental* erased: SHAs, run/job ids,
 * timestamps, durations, absolute/temp paths, line:column pairs, hex blobs, and numbers that
 * are pure counters. What survives is the shape — the failing check, the error class, the
 * assertion text. Two failures with the same signature are "the same failure" for budget
 * purposes even when their head SHAs differ (explicitly binding: *a changed head SHA alone
 * does not make an otherwise identical CI/error signature new*).
 *
 * Pure, total, and deliberately lossy in one direction only: it may call two genuinely
 * different failures the same (costing one forced final adjudication), never two identical
 * failures different (which would cost an infinite loop). Erring that way is the whole point.
 */

import type { MasterRequestSource } from "../store/types";

/** The raw material a signature is computed from. */
export interface FailureSignatureInput {
  /** Which worker signal opened the request — a stuck and an escalate are never "the same". */
  source: MasterRequestSource;
  /** The run-phase key the failure occurred in (`impl`, `review-1`, …). */
  phase: string;
  /**
   * The failure text: the worker's stuck reason, its escalation headline + decision, the CI
   * failure names, the error message — whatever names *what went wrong*. Joined and normalized.
   */
  detail: string;
}

/** How many characters of normalized detail the signature keeps. */
const MAX_DETAIL_CHARS = 400;

/**
 * The ordered erasures. Each replaces an incidental token with a stable placeholder, so the
 * signature reads as a *shape* rather than a redaction — a human comparing two signatures can
 * still see what differed. Order matters: the wider patterns (hex blobs) run after the
 * narrower ones they would otherwise swallow (ISO timestamps, line:column pairs).
 */
const ERASURES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // ISO-8601 instants and bare clock times: every rerun stamps a new one.
  { pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi, replacement: "<ts>" },
  { pattern: /\b\d{1,2}:\d{2}:\d{2}\b/g, replacement: "<ts>" },
  // Durations ("3.24s", "1200 ms", "2m 3s") — pure noise across reruns.
  { pattern: /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h|hours)\b/gi, replacement: "<dur>" },
  // URLs (a CI run link is per-run by construction), before path/number erasure eats them.
  { pattern: /\bhttps?:\/\/\S+/gi, replacement: "<url>" },
  // Temp/absolute workspace paths: a fresh container clone lands somewhere new every run.
  { pattern: /(?:\/(?:tmp|var|home|Users|work|workspace)|[A-Za-z]:\\)[^\s"'`,;:)\]]*/g, replacement: "<path>" },
  // `file.ts:120:8` / `file.ts(120,8)` — a one-line edit above renumbers the whole file.
  { pattern: /:\d+:\d+\b/g, replacement: ":<pos>" },
  { pattern: /\(\d+,\s*\d+\)/g, replacement: "(<pos>)" },
  // UUIDs / run ids — BEFORE the hex-blob rule, which would otherwise eat only their
  // 8- and 12-character segments and leave a half-erased husk that still differs per run.
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: "<sha>" },
  // Git SHAs (7–40 hex) and other long hex blobs: THE canonical false-difference (ADR-0041).
  { pattern: /\b[0-9a-f]{7,40}\b/gi, replacement: "<sha>" },
  // Any surviving bare number is a counter (attempt 3, 12 tests, PID 8811) — never identity.
  { pattern: /\b\d+\b/g, replacement: "<n>" },
];

/**
 * Normalize one blob of failure text: lowercase, erase the incidentals above, collapse
 * whitespace, and clamp. Exported because the prompt shows the master *what* was normalized
 * away — a master that cannot see the normalization cannot argue with it.
 */
export function normalizeFailureText(detail: string): string {
  // Erase FIRST (several patterns are case-sensitive by nature — `/Users`, `T…Z`), then
  // lowercase, so casing differences between two reports never survive as a difference.
  let out = detail;
  for (const { pattern, replacement } of ERASURES) {
    out = out.replace(pattern, replacement);
  }
  return out.toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
}

/**
 * The normalized failure signature for one master request. Deterministic and comparable by
 * string equality — that comparison is the whole loop budget (`repeatedSignature`).
 * `source` and `phase` are part of the identity because a stuck in `impl` and an escalate in
 * `review-1` are genuinely different failures even when their text coincides.
 */
export function normalizeFailureSignature(input: FailureSignatureInput): string {
  return `${input.source}|${input.phase}|${normalizeFailureText(input.detail)}`;
}
