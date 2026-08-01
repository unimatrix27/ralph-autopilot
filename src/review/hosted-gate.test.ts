/**
 * The hosted-review gate's driving half (issue #43): bounded observation, never spending the
 * CI budget on a conversation, idempotent reply/resolution across a restart, and the
 * fail-closed arms.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { createLogger } from "../log/logger";
import type { ReviewThread, ReviewThreadComment } from "../github/types";
import { HostedReviewGate, foldHostedGateState, renderDisposition } from "./hosted-gate";
import { buildHostedWorklist } from "./hosted-review";

const REPO = "acme/widgets";
const logger = createLogger({ level: "error" });
const HEAD = "abc1234";

const comment = (over: Partial<ReviewThreadComment> = {}): ReviewThreadComment => ({
  id: "PRRC_1",
  author: "chatgpt-codex-connector",
  authorIsBot: true,
  body: "P1: the retry loop can spin forever.",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "src/review/review-loop.ts",
  line: 1204,
  side: "RIGHT",
  reviewedSha: HEAD,
  resolvedBy: null,
  comments: [comment()],
  ...over,
});

describe("HostedReviewGate (issue #43)", () => {
  let github: FakeGitHub;
  let store: ScopedStore;
  let gate: HostedReviewGate;

  const ctx = { issueNumber: 5, runId: 1, prNumber: 50, headSha: HEAD, logger };

  beforeEach(() => {
    github = new FakeGitHub(REPO);
    store = openStore(MEMORY_DB).forRepo(REPO);
    store.upsertRun({ issueNumber: 5, mode: "tdd", branch: "ralph/5-x", prNumber: 50 });
    gate = new HostedReviewGate({ github, store, logger, sleep: async () => {}, polls: 3, intervalSeconds: 0 });
  });

  it("captures unresolved hosted threads immediately and never burns the CI budget (#3430)", async () => {
    github.setReviewThreads(50, [thread()], HEAD);
    github.setMergeStatus(50, { state: "BLOCKED", headSha: HEAD });

    const { cause } = await gate.classify(ctx, { state: "BLOCKED", headSha: HEAD }, {
      state: "green",
      failures: [],
    });

    expect(cause.kind).toBe("hosted-review");
    expect(cause.kind === "hosted-review" && cause.findings[0]!.finding).toContain("retry loop");
    // ONE thread read; no CI polling at all.
    expect(github.reviewThreadReads).toEqual([50]);
    expect(github.checkPolls).toEqual([]);
  });

  it("records one observation per head with the thread counts", async () => {
    github.setReviewThreads(50, [thread(), thread({ id: "PRRT_h", comments: [comment({ author: "bo", authorIsBot: false })] })], HEAD);
    const verdict = await gate.observe(ctx);
    expect(verdict.kind).toBe("findings");
    const observed = store.readIssueStream(5).filter((e) => e.type === "HostedReviewObserved");
    expect(observed).toHaveLength(1);
    expect((observed[0]!.data as { unresolved: number }).unresolved).toBe(1);
    expect((observed[0]!.data as { humanThreads: number }).humanThreads).toBe(1);
  });

  it("waits boundedly for the reviewer to observe the new head, then reads", async () => {
    // The reviewer is still looking at the old head for two polls, then anchors to the new one.
    github.setReviewThreadSequence(50, [
      { kind: "threads", threads: [thread({ reviewedSha: "oldhead" })], headSha: HEAD },
      { kind: "threads", threads: [thread({ reviewedSha: "oldhead" })], headSha: HEAD },
      { kind: "threads", threads: [thread({ reviewedSha: HEAD })], headSha: HEAD },
    ]);
    const verdict = await gate.observe(ctx);
    expect(github.reviewThreadReads).toHaveLength(3);
    expect(verdict.kind).toBe("findings");
  });

  it("reports clean when every thread is resolved or outdated", async () => {
    github.setReviewThreads(50, [thread({ isResolved: true }), thread({ id: "PRRT_2", isOutdated: true })], HEAD);
    expect((await gate.observe(ctx)).kind).toBe("clean");
  });

  it("defers (never escalates) when GitHub rate-limits the thread read", async () => {
    github.setReviewThreadsUnavailable(50, "rate-limited", "API rate limit exceeded");
    const verdict = await gate.observe(ctx);
    expect(verdict.kind).toBe("defer");
    // No durable observation is recorded for a deferral — the gate simply has not looked yet.
    expect(store.readIssueStream(5).filter((e) => e.type === "HostedReviewObserved")).toHaveLength(0);
  });

  it("fails closed with typed evidence when GraphQL permissions are missing", async () => {
    github.setReviewThreadsUnavailable(50, "permissions", "missing pull_requests: read");
    const verdict = await gate.observe(ctx);
    expect(verdict.kind).toBe("blocked");
    expect(verdict.kind === "blocked" && verdict.cause.kind).toBe("threads-unavailable");
  });

  it("fails closed on an unknown bot author rather than resolving its thread", async () => {
    github.setReviewThreads(50, [thread({ comments: [comment({ author: "mystery[bot]" })] })], HEAD);
    const verdict = await gate.observe(ctx);
    expect(verdict.kind).toBe("blocked");
    expect(verdict.kind === "blocked" && verdict.cause.kind).toBe("unknown-bot");
    expect(github.resolvedThreads).toEqual([]);
  });

  describe("disposition", () => {
    const disposition = {
      disposition: "fixed" as const,
      rationale: "The loop now exits on an unchanged signature.",
      verification: "Added a regression test; `npm test` is green on this head.",
      headSha: HEAD,
    };

    it("replies once and resolves once after a verified push", async () => {
      github.setReviewThreads(50, [thread()], HEAD);
      const [finding] = buildHostedWorklist([thread()], HEAD).findings;
      const result = await gate.disposeFinding(ctx, finding!, disposition);

      expect(result).toEqual({ kind: "disposed", replied: true, resolved: true });
      expect(github.threadReplies).toHaveLength(1);
      expect(github.threadReplies[0]!.body).toContain("The loop now exits");
      expect(github.threadReplies[0]!.body).toContain("Verification");
      expect(github.resolvedThreads).toEqual(["PRRT_1"]);
    });

    it("is idempotent across a restart — no duplicate reply or resolution", async () => {
      github.setReviewThreads(50, [thread()], HEAD);
      const [finding] = buildHostedWorklist([thread()], HEAD).findings;
      await gate.disposeFinding(ctx, finding!, disposition);
      // Restart: the store is re-read, GitHub is re-read, the same finding comes back.
      const again = await gate.disposeFinding(ctx, finding!, disposition);
      expect(again).toEqual({ kind: "disposed", replied: false, resolved: false });
      expect(github.threadReplies).toHaveLength(1);
      expect(github.resolvedThreads).toEqual(["PRRT_1"]);
    });

    it("recovers exactly the missing half when a restart lands between reply and resolve", async () => {
      github.setReviewThreads(50, [thread()], HEAD);
      const [finding] = buildHostedWorklist([thread()], HEAD).findings;
      // The reply landed and was recorded; the resolve mutation never ran.
      await store.recordHostedReviewReplied({
        issueNumber: 5,
        runId: 1,
        threadId: finding!.threadId,
        commentHash: finding!.latestCommentHash,
        headSha: HEAD,
        replyId: "PRRC_reply_0",
      });
      const result = await gate.disposeFinding(ctx, finding!, disposition);
      expect(result).toEqual({ kind: "disposed", replied: false, resolved: true });
      expect(github.threadReplies).toHaveLength(0);
      expect(github.resolvedThreads).toEqual(["PRRT_1"]);
    });

    it("replies again when the SAME thread carries a materially new finding", async () => {
      const [first] = buildHostedWorklist([thread()], HEAD).findings;
      await gate.disposeFinding(ctx, first!, disposition);
      const updated = thread({ comments: [comment(), comment({ id: "PRRC_2", body: "P0: still wrong, differently" })] });
      const [second] = buildHostedWorklist([updated], HEAD).findings;
      // Same thread id, different latest-comment hash ⇒ a new reply is owed.
      expect(second!.threadId).toBe(first!.threadId);
      expect(second!.latestCommentHash).not.toBe(first!.latestCommentHash);
      const state = foldHostedGateState(store.readIssueStream(5));
      expect(state.repliedTo.get(second!.threadId)).not.toBe(second!.latestCommentHash);
    });

    it("NEVER auto-resolves a human-authored thread", async () => {
      const human = thread({ id: "PRRT_h", comments: [comment({ author: "alice", authorIsBot: false })] });
      const [finding] = buildHostedWorklist([human], HEAD).humanThreads;
      const result = await gate.disposeFinding(ctx, finding!, disposition);
      expect(result.kind).toBe("refused");
      expect(result.kind === "refused" && result.reason).toContain("human-review policy");
      expect(github.resolvedThreads).toEqual([]);
      expect(github.threadReplies).toEqual([]);
    });

    it("refuses an unclassifiable bot's thread", async () => {
      const bot = thread({ id: "PRRT_b", comments: [comment({ author: "mystery[bot]" })] });
      const [finding] = buildHostedWorklist([bot], HEAD).unknownBotThreads;
      const result = await gate.disposeFinding(ctx, finding!, disposition);
      expect(result.kind).toBe("refused");
      expect(github.resolvedThreads).toEqual([]);
    });

    it("persists an independent rationale for a reasoned-invalid bot finding", async () => {
      const [finding] = buildHostedWorklist([thread()], HEAD).findings;
      await gate.disposeFinding(ctx, finding!, {
        disposition: "reasoned-invalid",
        rationale: "The loop is bounded by MAX_REBASE_ROUNDS, which the reviewer did not read.",
        verification: "Traced every exit; added an assertion that the round counter is monotone.",
        headSha: HEAD,
      });
      const resolved = store.readIssueStream(5).find((e) => e.type === "HostedReviewThreadResolved")!;
      const data = resolved.data as { disposition: string; rationale: string };
      expect(data.disposition).toBe("reasoned-invalid");
      expect(data.rationale).toContain("MAX_REBASE_ROUNDS");
      expect(github.threadReplies[0]!.body).toContain("not accepted");
    });

    it("does not swallow a partial mutation failure", async () => {
      const [finding] = buildHostedWorklist([thread()], HEAD).findings;
      github.failNextThreadMutation("reply failed");
      await expect(gate.disposeFinding(ctx, finding!, disposition)).rejects.toThrow("reply failed");
      // Nothing was recorded, so a retry re-attempts the reply exactly once.
      expect(foldHostedGateState(store.readIssueStream(5)).repliedTo.size).toBe(0);
    });
  });

  it("re-reads after a new head and does not re-admit resolved/outdated/old-head threads", async () => {
    // Round 1: one finding on HEAD.
    github.setReviewThreads(50, [thread()], HEAD);
    expect((await gate.observe(ctx)).kind).toBe("findings");
    // Round 2 on a NEW head: the old thread is now resolved+outdated, a new one appears.
    const NEW = "def5678";
    github.setReviewThreads(
      50,
      [
        thread({ isResolved: true, isOutdated: true }),
        thread({ id: "PRRT_2", reviewedSha: NEW, comments: [comment({ id: "PRRC_9", body: "P0: new problem" })] }),
        thread({ id: "PRRT_old", reviewedSha: "oldhead" }),
      ],
      NEW,
    );
    const verdict = await gate.observe({ ...ctx, headSha: NEW });
    expect(verdict.kind).toBe("findings");
    expect(verdict.kind === "findings" && verdict.worklist.findings.map((f) => f.threadId)).toEqual(["PRRT_2"]);
  });

  it("pages GraphQL results transparently — every thread reaches the worklist", async () => {
    github.setReviewThreadPageSize(2);
    const threads = Array.from({ length: 5 }, (_, i) =>
      thread({ id: `PRRT_${i}`, comments: [comment({ id: `PRRC_${i}`, body: `P1: finding ${i}` })] }),
    );
    github.setReviewThreads(50, threads, HEAD);
    const verdict = await gate.observe(ctx);
    expect(verdict.kind === "findings" && verdict.worklist.findings).toHaveLength(5);
  });

  it("renders a disposition reply that states the head, the rationale and the verification", () => {
    const [finding] = buildHostedWorklist([thread()], HEAD).findings;
    const body = renderDisposition({
      finding: finding!,
      disposition: "fixed",
      rationale: "Bounded the loop.",
      verification: "npm test green.",
      headSha: HEAD,
    });
    expect(body).toContain(HEAD);
    expect(body).toContain("Bounded the loop.");
    expect(body).toContain("npm test green.");
  });
});
