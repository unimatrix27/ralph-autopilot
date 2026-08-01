/**
 * The **GitHub-hosted review gate** (issue #43, DESIGN §5a) — the driving half.
 *
 * {@link import("./hosted-review")} decides *what* a set of threads means; this decides
 * *when to look*, *what one pass does*, and *what survives a restart*. Three properties:
 *
 *  1. **Bounded observation, anchored to a head.** After PR creation and after every push or
 *     rebase the hosted reviewer needs time to look. The gate waits boundedly for the
 *     reviewer's observation of the CURRENT head, then reads. It never waits forever, and it
 *     never treats "the reviewer has not looked yet" as "the reviewer is happy".
 *  2. **Never spend the CI budget on a conversation.** The gate classifies the blocker before
 *     any retry (issue #3430): an unresolved-conversation `BLOCKED` returns immediately with
 *     the actual findings, rather than polling checks that were green all along.
 *  3. **Idempotent mutations.** A reply and a resolution are GitHub writes that cannot be
 *     undone. Both are keyed on `(threadId, latestCommentHash)` facts folded from the
 *     append-only stream, so a restart between "pushed the fix", "replied", and "resolved"
 *     reconstructs exactly ONE pending action and repeats none of the completed ones.
 *
 * What the gate deliberately cannot do: resolve a human-authored thread (never, under any
 * disposition), resolve an unclassifiable bot's thread, or reply before the corresponding fix
 * or reasoned disposition is pushed and verified on the head the reply names.
 */

import type { GitHubClient, MergeStatusSnapshot, ReviewThreadsRead } from "../github/types";
import type { Logger } from "../log/logger";
import type { RecordedStreamEvent } from "../store/event-log";
import type { ScopedStore } from "../store/store";
import {
  buildHostedWorklist,
  classifyMergeBlock,
  describeMergeBlock,
  hostedGateClean,
  type HostedFinding,
  type HostedWorklist,
  type MergeBlockCause,
} from "./hosted-review";

/** How many times the gate re-reads while waiting for the reviewer to observe a new head. */
export const DEFAULT_OBSERVATION_POLLS = 6;
/** Seconds between observation polls. */
export const DEFAULT_OBSERVATION_INTERVAL_SECONDS = 20;

/** The folded, restart-exact record of what the gate has already done on this run. */
export interface HostedGateState {
  /** `threadId → commentHash` of the finding Ralph has already replied to. */
  repliedTo: Map<string, string>;
  /** Thread ids Ralph has already resolved. */
  resolved: Set<string>;
  /** `headSha → unresolved count` for every head the gate has observed. */
  observed: Map<string, number>;
}

/** Fold the hosted-gate dispositions out of an issue's append-only stream. Pure and total. */
export function foldHostedGateState(events: readonly RecordedStreamEvent[]): HostedGateState {
  const state: HostedGateState = { repliedTo: new Map(), resolved: new Set(), observed: new Map() };
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const threadId = typeof data.threadId === "string" ? data.threadId : "";
    switch (event.type) {
      case "RunStarted":
        // A fresh run span re-observes from scratch: the branch may have been rebuilt, and a
        // reply recorded against a superseded span is not evidence about this one. The
        // GitHub-side resolution state is re-read anyway, so nothing is lost.
        state.repliedTo.clear();
        state.resolved.clear();
        state.observed.clear();
        break;
      case "HostedReviewThreadReplied":
        if (threadId) {
          state.repliedTo.set(threadId, typeof data.commentHash === "string" ? data.commentHash : "");
        }
        break;
      case "HostedReviewThreadResolved":
        if (threadId) {
          state.resolved.add(threadId);
        }
        break;
      case "HostedReviewObserved": {
        const head = typeof data.headSha === "string" ? data.headSha : "";
        if (head) {
          state.observed.set(head, typeof data.unresolved === "number" ? data.unresolved : 0);
        }
        break;
      }
      default:
        break;
    }
  }
  return state;
}

/**
 * Whether Ralph has already replied to a finding's CURRENT content. A *new* comment on the
 * same thread (a different hash) is a new finding and gets its own reply; a re-run over the
 * same finding does not.
 */
export function alreadyRepliedTo(state: HostedGateState, finding: HostedFinding): boolean {
  return state.repliedTo.get(finding.threadId) === finding.latestCommentHash;
}

/** The verdict of one hosted-review gate pass. */
export type HostedGateVerdict =
  /** Nothing hosted blocks the merge on this head. */
  | { kind: "clean"; headSha: string | null }
  /**
   * Actionable findings the ordinary fix lane may address. The cause is narrowed to the
   * hosted-review arm on purpose: this verdict is only ever built when the blocker IS the
   * hosted reviewer, and the fix lane needs `findings` without re-testing a union it already
   * knows the shape of.
   */
  | {
      kind: "findings";
      worklist: HostedWorklist;
      cause: Extract<MergeBlockCause, { kind: "hosted-review" }>;
      headSha: string | null;
    }
  /** A typed blocker the fix lane cannot address — fail closed with evidence. */
  | { kind: "blocked"; cause: MergeBlockCause; headSha: string | null }
  /** The read failed in a way the rate-limit path owns: defer, do not escalate. */
  | { kind: "defer"; detail: string };

export interface HostedGateDeps {
  github: GitHubClient;
  store: ScopedStore;
  logger: Logger;
  /** Injected sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Observation bounds; defaults are the module constants. */
  polls?: number;
  intervalSeconds?: number;
}

export interface HostedGateContext {
  issueNumber: number;
  runId: number;
  prNumber: number;
  /** The head the gate must see the reviewer's verdict on. Null ⇒ accept any head. */
  headSha: string | null;
  logger: Logger;
  abortSignal?: AbortSignal;
}

export class HostedReviewGate {
  constructor(private readonly deps: HostedGateDeps) {}

  /**
   * Read the hosted reviewer's verdict on `ctx.headSha`, waiting boundedly for it to observe
   * that head. "Observed" means: the read returned threads anchored to this head, OR the
   * reviewer reports nothing at all after the bounded wait (a repo with no hosted reviewer
   * must not stall the merge forever — it simply has no hosted gate).
   */
  async observe(ctx: HostedGateContext): Promise<HostedGateVerdict> {
    const naps = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const polls = Math.max(1, this.deps.polls ?? DEFAULT_OBSERVATION_POLLS);
    const intervalMs = Math.max(0, (this.deps.intervalSeconds ?? DEFAULT_OBSERVATION_INTERVAL_SECONDS) * 1000);

    let last: ReviewThreadsRead | null = null;
    for (let poll = 0; poll < polls; poll += 1) {
      ctx.abortSignal?.throwIfAborted();
      const read = await this.deps.github.readReviewThreads(ctx.prNumber);
      last = read;
      if (read.kind === "unavailable") {
        if (read.reason === "rate-limited") {
          // GitHub rate limits defer through the existing rate-limit path: never an
          // escalation, never a consumed master attempt.
          ctx.logger.warn("hosted-review.rate-limited", { pr: ctx.prNumber });
          return { kind: "defer", detail: read.detail };
        }
        // Permissions / hard error: fail closed with typed evidence rather than merging blind.
        return {
          kind: "blocked",
          cause: { kind: "threads-unavailable", reason: read.reason, detail: read.detail },
          headSha: ctx.headSha,
        };
      }
      const head = ctx.headSha ?? read.headSha;
      const worklist = buildHostedWorklist(read.threads, head);
      // The reviewer has spoken about this head once it has ANY thread anchored to it — or once
      // it reports NO threads at all, which is genuinely indistinguishable from "this repo has
      // no hosted reviewer" and must not stall every merge for the whole observation budget.
      //
      // "Every thread it has is resolved/outdated" is deliberately NOT a third disjunct: that is
      // precisely the state a repair leaves behind (the reviewer's old findings go outdated the
      // instant the head moves), so treating it as an observation would skip the bounded wait at
      // the one moment the reviewer demonstrably has NOT looked at the new head yet — the "an
      // empty read is the reviewer being happy" antipattern this module exists to forbid. The
      // wait stays bounded: the last poll returns the verdict either way.
      const sawThisHead =
        head === null || read.threads.length === 0 || read.threads.some((t) => t.reviewedSha === head);
      if (sawThisHead || poll === polls - 1) {
        await this.recordObservation(ctx, head, worklist);
        return this.verdict(ctx, worklist, head);
      }
      ctx.logger.info("hosted-review.awaiting-observation", { pr: ctx.prNumber, poll, head });
      if (intervalMs > 0) {
        await naps(intervalMs);
      }
    }
    // Unreachable in practice (the loop returns on its last poll); keep it total.
    /* c8 ignore next 3 */
    return last && last.kind === "threads"
      ? { kind: "clean", headSha: ctx.headSha }
      : { kind: "defer", detail: "hosted review observation exhausted" };
  }

  /**
   * Classify the CURRENT merge state with the hosted worklist in hand. This is the call that
   * makes issue #3430 impossible: the blocker is typed before any retry, so an unresolved
   * conversation never consumes the CI polling budget.
   */
  async classify(
    ctx: HostedGateContext,
    merge: MergeStatusSnapshot,
    checks?: { state: "green" | "red" | "none" | "pending"; failures: string[] } | null,
  ): Promise<{ cause: MergeBlockCause; worklist: HostedWorklist | null; headSha: string | null }> {
    const read = await this.deps.github.readReviewThreads(ctx.prNumber);
    const head = ctx.headSha ?? merge.headSha ?? (read.kind === "threads" ? read.headSha : null);
    if (read.kind === "unavailable") {
      const cause = classifyMergeBlock({
        merge,
        worklist: null,
        threadsUnavailable: { reason: read.reason, detail: read.detail },
        ...(checks ? { checks } : {}),
      });
      return { cause, worklist: null, headSha: head };
    }
    const worklist = buildHostedWorklist(read.threads, head);
    const cause = classifyMergeBlock({ merge, worklist, ...(checks ? { checks } : {}) });
    ctx.logger.info("hosted-review.merge-block", { pr: ctx.prNumber, cause: describeMergeBlock(cause) });
    return { cause, worklist, headSha: head };
  }

  /**
   * Reply to and resolve one hosted finding, after its fix (or reasoned disposition) has been
   * pushed and verified on `headSha`. Idempotent by thread id: a repeat call after a restart
   * makes no second reply and no second resolve mutation.
   *
   * Refuses outright for a human-authored or unclassifiable-bot thread — the refusal is a
   * return value, not an exception, because "carry it into master context" is the correct
   * next step and an exception would lose the finding.
   */
  async disposeFinding(
    ctx: HostedGateContext,
    finding: HostedFinding,
    input: { disposition: "fixed" | "reasoned-invalid"; rationale: string; verification: string; headSha: string },
  ): Promise<{ kind: "disposed"; replied: boolean; resolved: boolean } | { kind: "refused"; reason: string }> {
    if (finding.authorType !== "hosted-reviewer") {
      return {
        kind: "refused",
        reason:
          finding.authorType === "human"
            ? "a human-authored conversation is never auto-resolved; resolution follows the repository's human-review policy"
            : `the thread author \`${finding.author}\` could not be classified as the hosted reviewer`,
      };
    }
    const state = foldHostedGateState(this.deps.store.readIssueStream(ctx.issueNumber));

    let replied = false;
    if (!alreadyRepliedTo(state, finding)) {
      const body = renderDisposition({ ...input, finding });
      const reply = await this.deps.github.replyToReviewThread({ threadId: finding.threadId, body });
      await this.deps.store.recordHostedReviewReplied({
        issueNumber: ctx.issueNumber,
        runId: ctx.runId,
        threadId: finding.threadId,
        commentHash: finding.latestCommentHash,
        headSha: input.headSha,
        replyId: reply.id,
      });
      replied = true;
    }

    let resolved = false;
    if (!state.resolved.has(finding.threadId)) {
      await this.deps.github.resolveReviewThread(finding.threadId);
      await this.deps.store.recordHostedReviewResolved({
        issueNumber: ctx.issueNumber,
        runId: ctx.runId,
        threadId: finding.threadId,
        commentHash: finding.latestCommentHash,
        headSha: input.headSha,
        disposition: input.disposition,
        rationale: input.rationale,
      });
      resolved = true;
    }
    ctx.logger.info("hosted-review.disposed", {
      thread: finding.threadId,
      disposition: input.disposition,
      replied,
      resolved,
    });
    return { kind: "disposed", replied, resolved };
  }

  private async recordObservation(
    ctx: HostedGateContext,
    head: string | null,
    worklist: HostedWorklist,
  ): Promise<void> {
    if (!head) {
      return;
    }
    await this.deps.store.recordHostedReviewObserved({
      issueNumber: ctx.issueNumber,
      runId: ctx.runId,
      headSha: head,
      unresolved: worklist.findings.length,
      humanThreads: worklist.humanThreads.length,
      unknownBots: worklist.unknownBotThreads.length,
    });
  }

  private verdict(ctx: HostedGateContext, worklist: HostedWorklist, head: string | null): HostedGateVerdict {
    if (hostedGateClean(worklist)) {
      return { kind: "clean", headSha: head };
    }
    const cause = classifyMergeBlock({ merge: { state: "BLOCKED" }, worklist });
    if (cause.kind === "hosted-review") {
      return { kind: "findings", worklist, cause, headSha: head };
    }
    ctx.logger.warn("hosted-review.fail-closed", { pr: ctx.prNumber, cause: describeMergeBlock(cause) });
    return { kind: "blocked", cause, headSha: head };
  }
}

/**
 * Render Ralph's reply to a hosted finding. The independent rationale and its verification
 * are mandatory and appear in the reply body itself: a bot finding is never accepted (nor
 * dismissed) merely because a bot raised it, and the reasoning has to be visible to whoever
 * reads the thread later, not buried in a log line.
 */
export function renderDisposition(input: {
  finding: HostedFinding;
  disposition: "fixed" | "reasoned-invalid";
  rationale: string;
  verification: string;
  headSha: string;
}): string {
  const heading =
    input.disposition === "fixed"
      ? "Addressed by ralph-autopilot"
      : "Assessed as not applicable by ralph-autopilot";
  return [
    `**${heading}** (head \`${input.headSha}\`)`,
    "",
    input.rationale.trim(),
    "",
    "**Verification**",
    input.verification.trim(),
    "",
    input.disposition === "reasoned-invalid"
      ? "_This finding was evaluated on its merits and not accepted; the reasoning and verification above are the basis, not the fact that it was raised automatically._"
      : "_The fix is pushed on the head named above and re-enters the ordinary CI/review gate._",
  ].join("\n");
}
