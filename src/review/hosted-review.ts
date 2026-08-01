/**
 * The **GitHub-hosted review gate** (issue #43, DESIGN §5a) — the pure half.
 *
 * A repository ruleset can block merging on *unresolved conversations*. When the hosted
 * Codex reviewer opens threads on a PR, GitHub reports `mergeStateStatus = BLOCKED` even
 * though every required check is green and Ralph's own phase-1/phase-2 reviews are clean.
 * Before this module the daemon read that BLOCKED as "a required check has not greened",
 * spent its whole CI polling budget waiting for a check that was never going to change,
 * and then emitted a CI heal-card naming the wrong cause (issue #3430).
 *
 * So the hosted reviewer is modelled as what it is: a **first-class integration gate**,
 * distinct from CI and from Ralph's internal reviews, with its own typed evidence.
 *
 * Everything here is pure and total — the I/O lives in {@link import("./hosted-gate")}. The
 * three decisions this module owns:
 *
 *  1. **Who authored a thread.** A hosted-reviewer thread may be replied to and resolved
 *     autonomously once a fix is pushed and verified. A human thread may *never* be
 *     auto-resolved. An unknown bot is neither — it fails closed, because "resolve anything
 *     that looks like a bot" is how an autonomous merge quietly dismisses a real reviewer.
 *  2. **Which threads are actionable.** Resolved, outdated, Ralph-authored, and old-head
 *     threads do not re-enter the worklist; a genuinely new thread on a new head does.
 *  3. **Why the merge is blocked.** `BLOCKED` is classified into typed causes *before* any
 *     retry, so the CI polling budget is never spent on an unresolved-conversation blocker.
 */

import { createHash } from "node:crypto";
import type {
  ChecksSnapshot,
  MergeStatusSnapshot,
  ReviewThread,
  ReviewThreadAuthorType,
  ReviewThreadComment,
} from "../github/types";

/**
 * Logins GitHub's hosted Codex reviewer posts under. Kept as an explicit allow-list rather
 * than "any bot": an unrecognised bot must fail closed (see {@link classifyThreadAuthor}),
 * and a list is the only shape in which "we have never seen this reviewer" is representable.
 */
export const HOSTED_REVIEWER_LOGINS: readonly string[] = [
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
  "codex",
  "codex[bot]",
  "openai-codex",
  "openai-codex[bot]",
];

/** Logins the daemon itself posts under — its own replies are never findings. */
export const RALPH_AUTHOR_LOGINS: readonly string[] = ["ralph-autopilot", "ralph-autopilot[bot]"];

const norm = (login: string): string => login.trim().toLowerCase();

/**
 * Classify a thread comment's author. A `Bot` actor that is neither the hosted reviewer nor
 * Ralph is `unknown-bot` — deliberately its own class rather than folded into `human`
 * (which would make it un-resolvable forever) or into `hosted-reviewer` (which would let an
 * arbitrary bot's thread be auto-resolved). It fails closed: the gate escalates it with
 * typed evidence naming the identity it could not classify.
 */
export function classifyThreadAuthor(comment: {
  author: string;
  authorIsBot: boolean;
}): ReviewThreadAuthorType {
  const login = norm(comment.author);
  if (RALPH_AUTHOR_LOGINS.some((l) => norm(l) === login)) {
    return "ralph";
  }
  if (HOSTED_REVIEWER_LOGINS.some((l) => norm(l) === login)) {
    return "hosted-reviewer";
  }
  return comment.authorIsBot ? "unknown-bot" : "human";
}

/** The author type of a thread — its FIRST comment's author, which is who raised the finding. */
export function threadAuthorType(thread: ReviewThread): ReviewThreadAuthorType {
  const first = thread.comments[0];
  return first ? classifyThreadAuthor(first) : "unknown-bot";
}

/** The latest comment in a thread (the current statement of the finding), or null. */
export function latestComment(thread: ReviewThread): ReviewThreadComment | null {
  return thread.comments.length > 0 ? thread.comments[thread.comments.length - 1]! : null;
}

/**
 * A stable content hash of a finding's latest comment. Two reads of a thread whose body has
 * not materially changed hash identically, which is what makes "the same finding after a
 * claimed fix" detectable — and therefore what stops the same repair from looping.
 * Whitespace-insensitive so a reflowed body is not a new finding.
 */
export function hashFindingBody(body: string): string {
  return createHash("sha256").update(body.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** Severity a hosted reviewer states in its comment, when it states one. */
export type HostedSeverity = "P0" | "P1" | "P2";

const SEVERITY_PATTERNS: ReadonlyArray<{ severity: HostedSeverity; pattern: RegExp }> = [
  { severity: "P0", pattern: /\b(?:p0|critical|blocker|must[- ]fix)\b/i },
  { severity: "P1", pattern: /\b(?:p1|high|major|important)\b/i },
  { severity: "P2", pattern: /\b(?:p2|minor|nit|nitpick|low)\b/i },
];

/** Extract the reviewer's stated severity, or null when it states none. */
export function readSeverity(body: string): HostedSeverity | null {
  for (const { severity, pattern } of SEVERITY_PATTERNS) {
    if (pattern.test(body)) {
      return severity;
    }
  }
  return null;
}

/** One normalized hosted-reviewer finding — the durable unit of the hosted worklist. */
export interface HostedFinding {
  /** The stable thread node id; the idempotency key for reply and resolve. */
  threadId: string;
  /** The stable node id of the latest comment the finding was read from. */
  latestCommentId: string;
  /** Content hash of that comment — "materially unchanged" is hash equality. */
  latestCommentHash: string;
  /** The commit the reviewer anchored the thread to. */
  reviewedSha: string | null;
  severity: HostedSeverity | null;
  path: string | null;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  /** The finding itself — the reviewer's own words, verbatim. */
  finding: string;
  /** Supporting context (author, anchor, prior replies) an agent needs to act. */
  evidence: string;
  authorType: ReviewThreadAuthorType;
  author: string;
}

/** The bounded, deduped worklist one gate pass hands to a fix agent or the master. */
export interface HostedWorklist {
  /** Actionable hosted-reviewer findings, oldest thread first. */
  findings: HostedFinding[];
  /**
   * Human-authored unresolved threads. Carried into context so an agent can implement and
   * reply, but NEVER auto-resolved — resolution follows the repository's human-review policy.
   */
  humanThreads: HostedFinding[];
  /** Threads whose author could not be classified — a fail-closed condition. */
  unknownBotThreads: HostedFinding[];
}

/** Why a thread did not enter the worklist — logged, so an empty worklist is never mysterious. */
export type ThreadSkipReason = "resolved" | "outdated" | "ralph-authored" | "stale-head" | "empty";

/** Whether a thread is anchored to the head under consideration. */
function anchoredToHead(thread: ReviewThread, headSha: string | null): boolean {
  // No anchor reported, or no head to compare against ⇒ we cannot prove it stale, so it
  // counts. Failing the other way would silently drop a real finding.
  if (!headSha || !thread.reviewedSha) {
    return true;
  }
  return thread.reviewedSha === headSha;
}

/** Classify one thread for worklist admission, or say why it was skipped. */
export function admitThread(
  thread: ReviewThread,
  headSha: string | null,
): { admit: true } | { admit: false; reason: ThreadSkipReason } {
  if (thread.comments.length === 0) {
    return { admit: false, reason: "empty" };
  }
  if (thread.isResolved) {
    return { admit: false, reason: "resolved" };
  }
  if (thread.isOutdated) {
    return { admit: false, reason: "outdated" };
  }
  if (threadAuthorType(thread) === "ralph") {
    return { admit: false, reason: "ralph-authored" };
  }
  if (!anchoredToHead(thread, headSha)) {
    return { admit: false, reason: "stale-head" };
  }
  return { admit: true };
}

/** Turn one admitted thread into a normalized finding. */
export function normalizeThread(thread: ReviewThread): HostedFinding {
  const first = thread.comments[0]!;
  const last = latestComment(thread)!;
  const authorType = threadAuthorType(thread);
  const anchor = thread.path ? `${thread.path}${thread.line !== null && thread.line !== undefined ? `:${thread.line}` : ""}` : "(no file anchor)";
  const priorReplies = thread.comments.slice(1);
  const evidence = [
    `thread ${thread.id} by ${first.author} (${authorType})`,
    `anchored at ${anchor}${thread.side ? ` [${thread.side}]` : ""}`,
    `reviewed head ${thread.reviewedSha ?? "(unreported)"}`,
    priorReplies.length > 0
      ? `${priorReplies.length} prior repl${priorReplies.length === 1 ? "y" : "ies"}; latest by ${last.author}`
      : "no replies yet",
  ].join("; ");
  return {
    threadId: thread.id,
    latestCommentId: last.id,
    latestCommentHash: hashFindingBody(last.body),
    reviewedSha: thread.reviewedSha ?? null,
    severity: readSeverity(first.body),
    path: thread.path ?? null,
    line: thread.line ?? null,
    side: thread.side ?? null,
    finding: first.body,
    evidence,
    authorType,
    author: first.author,
  };
}

/**
 * Build the bounded hosted worklist for one head. Deterministic and pure: the same threads
 * and head always produce the same worklist, which is what makes a restart mid-gate
 * reconstruct exactly one pending action rather than a different one.
 */
export function buildHostedWorklist(
  threads: readonly ReviewThread[],
  headSha: string | null,
): HostedWorklist {
  const worklist: HostedWorklist = { findings: [], humanThreads: [], unknownBotThreads: [] };
  for (const thread of threads) {
    if (!admitThread(thread, headSha).admit) {
      continue;
    }
    const finding = normalizeThread(thread);
    switch (finding.authorType) {
      case "hosted-reviewer":
        worklist.findings.push(finding);
        break;
      case "human":
        worklist.humanThreads.push(finding);
        break;
      case "unknown-bot":
        worklist.unknownBotThreads.push(finding);
        break;
      case "ralph":
        break;
    }
  }
  return worklist;
}

/** Whether a worklist has anything at all that blocks the merge. */
export function hostedGateClean(worklist: HostedWorklist): boolean {
  return (
    worklist.findings.length === 0 &&
    worklist.humanThreads.length === 0 &&
    worklist.unknownBotThreads.length === 0
  );
}

// ── typed BLOCKED classification ─────────────────────────────────────────────

/**
 * Why GitHub reports a PR as unmergeable. Typing this is the whole point: each cause has a
 * *different* correct response, and the pre-#43 code applied the "wait for CI" response to
 * all of them — which is why an unresolved-conversation blocker burned the entire CI budget
 * and then blamed CI.
 */
export type MergeBlockCause =
  /** Unresolved hosted-reviewer conversations — fix, reply, resolve, re-observe. */
  | { kind: "hosted-review"; findings: HostedFinding[] }
  /** Unresolved human conversations or a missing/《changes requested》human approval. */
  | { kind: "human-review"; reviewDecision: MergeStatusSnapshot["reviewDecision"]; threads: HostedFinding[] }
  /** A required status check is pending or failing — the one cause waiting can cure. */
  | { kind: "required-checks"; failures: string[]; pending: boolean }
  /** The head is behind base or conflicts — cured by a rebase, never by waiting. */
  | { kind: "behind-or-conflict"; state: "BEHIND" | "DIRTY" }
  /** The PR is a draft — cured by marking it ready. */
  | { kind: "draft" }
  /** A thread read that failed closed: no evidence, so no merge. */
  | { kind: "threads-unavailable"; reason: "permissions" | "rate-limited" | "error"; detail: string }
  /** An unclassifiable bot raised a conversation the daemon must not resolve. */
  | { kind: "unknown-bot"; threads: HostedFinding[] }
  /** BLOCKED with no identified cause — an unknown ruleset restriction. */
  | { kind: "unknown-ruleset"; detail: string }
  /** Not blocked at all. */
  | { kind: "mergeable" };

export interface MergeBlockInput {
  merge: MergeStatusSnapshot;
  /** The hosted worklist for the current head, or null when the read failed. */
  worklist: HostedWorklist | null;
  /** Why the thread read failed, when it did. */
  threadsUnavailable?: { reason: "permissions" | "rate-limited" | "error"; detail: string };
  /** The latest CI snapshot, when the caller has one. */
  checks?: ChecksSnapshot | null;
}

/** Merge-state values that permit a merge (mirrors the review loop's MERGEABLE_STATES). */
const MERGEABLE: ReadonlySet<string> = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

/**
 * Classify a merge-state read into exactly one typed cause. Ordered by *specificity of the
 * evidence*, not by severity: a cause we can name from a thread read beats a cause we would
 * be guessing at from `mergeStateStatus` alone. In particular unresolved conversations are
 * tested BEFORE required checks, because that is the mis-attribution of issue #3430.
 */
export function classifyMergeBlock(input: MergeBlockInput): MergeBlockCause {
  const { merge } = input;
  if (merge.state === "BEHIND" || merge.state === "DIRTY") {
    return { kind: "behind-or-conflict", state: merge.state };
  }
  if (merge.state === "DRAFT") {
    return { kind: "draft" };
  }
  if (MERGEABLE.has(merge.state)) {
    // Mergeable by branch protection — but an unresolved conversation the ruleset does not
    // enforce is still a finding Ralph must not merge past silently.
    if (input.worklist && !hostedGateClean(input.worklist)) {
      return hostedCause(input.worklist, merge);
    }
    return { kind: "mergeable" };
  }
  // BLOCKED / UNKNOWN: attribute it.
  if (input.threadsUnavailable) {
    return {
      kind: "threads-unavailable",
      reason: input.threadsUnavailable.reason,
      detail: input.threadsUnavailable.detail,
    };
  }
  if (input.worklist && !hostedGateClean(input.worklist)) {
    return hostedCause(input.worklist, merge);
  }
  if (merge.reviewDecision === "CHANGES_REQUESTED" || merge.reviewDecision === "REVIEW_REQUIRED") {
    return { kind: "human-review", reviewDecision: merge.reviewDecision, threads: [] };
  }
  if (input.checks && (input.checks.state === "red" || input.checks.state === "pending")) {
    return {
      kind: "required-checks",
      failures: [...input.checks.failures],
      pending: input.checks.state === "pending",
    };
  }
  return {
    kind: "unknown-ruleset",
    detail: `mergeStateStatus=${merge.state} with no identified blocker (reviewDecision=${
      merge.reviewDecision ?? "null"
    })`,
  };
}

/** Pick the hosted/human/unknown arm for a non-clean worklist, in fail-closed order. */
function hostedCause(worklist: HostedWorklist, merge: MergeStatusSnapshot): MergeBlockCause {
  if (worklist.unknownBotThreads.length > 0) {
    return { kind: "unknown-bot", threads: worklist.unknownBotThreads };
  }
  if (worklist.findings.length > 0) {
    return { kind: "hosted-review", findings: worklist.findings };
  }
  return {
    kind: "human-review",
    reviewDecision: merge.reviewDecision ?? null,
    threads: worklist.humanThreads,
  };
}

/** Whether a cause can be cured by *waiting* — the only case the CI poll budget may fund. */
export function curableByWaiting(cause: MergeBlockCause): boolean {
  return cause.kind === "required-checks" && cause.pending;
}

// ── failure signatures + rendering ───────────────────────────────────────────

/**
 * The normalized failure text a hosted-review escalation carries into the master's loop
 * budget. Built from **thread identity + latest finding content + verification result** so
 * that a re-push which changes only the head SHA does not read as a new failure — the
 * explicit anti-loop requirement of issue #43.
 */
export function hostedFailureDetail(input: {
  findings: readonly HostedFinding[];
  /** What the last repair attempt claimed, and whether it actually changed the finding. */
  verification?: string;
}): string {
  const parts = input.findings
    .slice()
    .sort((a, b) => a.threadId.localeCompare(b.threadId))
    .map((f) => `${f.threadId}#${f.latestCommentHash}@${f.path ?? "-"}`);
  return [`hosted-review unresolved: ${parts.join(", ")}`, input.verification ?? ""]
    .filter(Boolean)
    .join(" | ");
}

/** Render a hosted worklist as the evidence block injected into a fix or master context. */
export function renderHostedWorklist(worklist: HostedWorklist): string {
  const lines: string[] = [];
  const render = (title: string, items: HostedFinding[], note: string): void => {
    if (items.length === 0) {
      return;
    }
    lines.push(`### ${title}`, note, "");
    for (const f of items) {
      lines.push(
        `- **${f.severity ?? "unrated"}** \`${f.path ?? "(no file)"}${f.line !== null ? `:${f.line}` : ""}\` — ${f.author}`,
        `  - thread: \`${f.threadId}\` (latest comment \`${f.latestCommentId}\`, reviewed head \`${f.reviewedSha ?? "unreported"}\`)`,
        `  - finding: ${f.finding.trim()}`,
        `  - evidence: ${f.evidence}`,
      );
    }
    lines.push("");
  };
  render(
    "Hosted reviewer findings (actionable)",
    worklist.findings,
    "Fix or reason about each one. A finding is NOT accepted merely because a bot recommended it — " +
      "if you conclude it is invalid, say why and show the verification that proves it.",
  );
  render(
    "Human-authored conversations (never auto-resolve)",
    worklist.humanThreads,
    "You may implement and reply. Resolution and approval follow the repository's human-review policy.",
  );
  render(
    "Unclassifiable bot conversations (fail closed)",
    worklist.unknownBotThreads,
    "The author could not be classified as the hosted reviewer, so nothing here may be auto-resolved.",
  );
  return lines.join("\n").trimEnd();
}

/** A one-line, human-readable summary of a typed blocker — for logs and heal evidence. */
export function describeMergeBlock(cause: MergeBlockCause): string {
  switch (cause.kind) {
    case "hosted-review":
      return `hosted review has ${cause.findings.length} unresolved conversation(s)`;
    case "human-review":
      return `human review policy unsatisfied (reviewDecision=${cause.reviewDecision ?? "null"}, ${cause.threads.length} thread(s))`;
    case "required-checks":
      return `required checks ${cause.pending ? "pending" : "failing"}: ${cause.failures.join(", ") || "(unnamed)"}`;
    case "behind-or-conflict":
      return `branch ${cause.state === "BEHIND" ? "behind base" : "conflicts with base"}`;
    case "draft":
      return "pull request is a draft";
    case "threads-unavailable":
      return `review threads unreadable (${cause.reason}): ${cause.detail}`;
    case "unknown-bot":
      return `${cause.threads.length} conversation(s) from an unclassifiable bot author`;
    case "unknown-ruleset":
      return cause.detail;
    case "mergeable":
      return "mergeable";
  }
}
