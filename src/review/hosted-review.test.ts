/**
 * The GitHub-hosted Codex review gate matrix (issue #43). Every row of the issue's
 * "hosted-review TDD matrix" is a test here or in `hosted-gate.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ReviewThread, ReviewThreadComment } from "../github/types";
import {
  buildHostedWorklist,
  classifyMergeBlock,
  classifyThreadAuthor,
  curableByWaiting,
  describeMergeBlock,
  hashFindingBody,
  hostedFailureDetail,
  hostedGateClean,
  normalizeThread,
  readSeverity,
  renderHostedWorklist,
  admitThread,
} from "./hosted-review";

const comment = (over: Partial<ReviewThreadComment> = {}): ReviewThreadComment => ({
  id: "PRRC_1",
  author: "chatgpt-codex-connector",
  authorIsBot: true,
  body: "P1: the retry loop can spin forever when the head never changes.",
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
  reviewedSha: "abc1234",
  resolvedBy: null,
  comments: [comment()],
  ...over,
});

describe("hosted review — author classification", () => {
  it("recognises the hosted Codex reviewer under each of its logins", () => {
    for (const login of ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]", "codex[bot]"]) {
      expect(classifyThreadAuthor({ author: login, authorIsBot: true })).toBe("hosted-reviewer");
    }
  });

  it("classifies a human as human and Ralph as ralph", () => {
    expect(classifyThreadAuthor({ author: "alice", authorIsBot: false })).toBe("human");
    expect(classifyThreadAuthor({ author: "ralph-autopilot", authorIsBot: true })).toBe("ralph");
  });

  it("fails closed on an unknown bot identity — never folded into hosted-reviewer", () => {
    expect(classifyThreadAuthor({ author: "some-linter[bot]", authorIsBot: true })).toBe("unknown-bot");
  });
});

describe("hosted review — worklist admission", () => {
  it("admits an unresolved, non-outdated, current-head hosted thread", () => {
    expect(admitThread(thread(), "abc1234")).toEqual({ admit: true });
  });

  it.each([
    ["resolved", thread({ isResolved: true }), "resolved"],
    ["outdated", thread({ isOutdated: true }), "outdated"],
    ["ralph-authored", thread({ comments: [comment({ author: "ralph-autopilot" })] }), "ralph-authored"],
    ["old-head", thread({ reviewedSha: "deadbee" }), "stale-head"],
    ["empty", thread({ comments: [] }), "empty"],
  ])("keeps a %s thread out of the worklist", (_label, t, reason) => {
    expect(admitThread(t, "abc1234")).toEqual({ admit: false, reason });
  });

  it("does not drop a thread whose anchor GitHub did not report", () => {
    expect(admitThread(thread({ reviewedSha: null }), "abc1234")).toEqual({ admit: true });
  });

  it("splits hosted, human, and unknown-bot threads into their own buckets", () => {
    const worklist = buildHostedWorklist(
      [
        thread({ id: "PRRT_hosted" }),
        thread({ id: "PRRT_human", comments: [comment({ author: "alice", authorIsBot: false })] }),
        thread({ id: "PRRT_bot", comments: [comment({ author: "mystery[bot]", authorIsBot: true })] }),
        thread({ id: "PRRT_resolved", isResolved: true }),
      ],
      "abc1234",
    );
    expect(worklist.findings.map((f) => f.threadId)).toEqual(["PRRT_hosted"]);
    expect(worklist.humanThreads.map((f) => f.threadId)).toEqual(["PRRT_human"]);
    expect(worklist.unknownBotThreads.map((f) => f.threadId)).toEqual(["PRRT_bot"]);
    expect(hostedGateClean(worklist)).toBe(false);
  });

  it("normalizes a finding with exact thread/comment/path/line/head context", () => {
    const f = normalizeThread(thread());
    expect(f.threadId).toBe("PRRT_1");
    expect(f.latestCommentId).toBe("PRRC_1");
    expect(f.path).toBe("src/review/review-loop.ts");
    expect(f.line).toBe(1204);
    expect(f.side).toBe("RIGHT");
    expect(f.reviewedSha).toBe("abc1234");
    expect(f.severity).toBe("P1");
    expect(f.finding).toContain("retry loop can spin forever");
    expect(f.evidence).toContain("PRRT_1");
    expect(f.evidence).toContain("src/review/review-loop.ts:1204");
  });

  it("reads a stated severity and tolerates its absence", () => {
    expect(readSeverity("P0: this is a blocker")).toBe("P0");
    expect(readSeverity("nit: rename this")).toBe("P2");
    expect(readSeverity("the loop is unbounded")).toBeNull();
  });

  it("hashes a finding whitespace-insensitively so a reflow is not a new finding", () => {
    expect(hashFindingBody("the loop\n  is  unbounded")).toBe(hashFindingBody("The loop is unbounded"));
    expect(hashFindingBody("the loop is unbounded")).not.toBe(hashFindingBody("the loop is bounded"));
  });
});

describe("hosted review — typed BLOCKED classification (issue #3430)", () => {
  const green = { state: "green" as const, failures: [] };

  it("attributes BLOCKED to the hosted conversations, NOT to CI, when CI is green", () => {
    const worklist = buildHostedWorklist([thread()], "abc1234");
    const cause = classifyMergeBlock({ merge: { state: "BLOCKED" }, worklist, checks: green });
    expect(cause.kind).toBe("hosted-review");
    expect(cause.kind === "hosted-review" && cause.findings).toHaveLength(1);
    // …and the classification says plainly that waiting cannot help.
    expect(curableByWaiting(cause)).toBe(false);
  });

  it("attributes BLOCKED to required checks only when nothing else explains it", () => {
    const cause = classifyMergeBlock({
      merge: { state: "BLOCKED" },
      worklist: buildHostedWorklist([], "abc1234"),
      checks: { state: "pending", failures: ["CI Gate"] },
    });
    expect(cause).toEqual({ kind: "required-checks", failures: ["CI Gate"], pending: true });
    expect(curableByWaiting(cause)).toBe(true);
  });

  it("attributes BLOCKED to the human-review policy when GitHub reports one", () => {
    const cause = classifyMergeBlock({
      merge: { state: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" },
      worklist: buildHostedWorklist([], "abc1234"),
      checks: green,
    });
    expect(cause.kind).toBe("human-review");
  });

  it.each([
    ["BEHIND", "behind-or-conflict"],
    ["DIRTY", "behind-or-conflict"],
    ["DRAFT", "draft"],
  ] as const)("classifies %s structurally", (state, kind) => {
    expect(classifyMergeBlock({ merge: { state }, worklist: null }).kind).toBe(kind);
  });

  it("fails closed when the threads could not be read", () => {
    const cause = classifyMergeBlock({
      merge: { state: "BLOCKED" },
      worklist: null,
      threadsUnavailable: { reason: "permissions", detail: "missing pull_requests: read" },
    });
    expect(cause.kind).toBe("threads-unavailable");
    expect(describeMergeBlock(cause)).toContain("permissions");
  });

  it("fails closed on an unknown ruleset blocker rather than guessing", () => {
    const cause = classifyMergeBlock({
      merge: { state: "BLOCKED", reviewDecision: "APPROVED" },
      worklist: buildHostedWorklist([], "abc1234"),
      checks: green,
    });
    expect(cause.kind).toBe("unknown-ruleset");
  });

  it("fails closed on an unclassifiable bot conversation before touching it", () => {
    const worklist = buildHostedWorklist(
      [thread({ id: "PRRT_bot", comments: [comment({ author: "mystery[bot]" })] })],
      "abc1234",
    );
    expect(classifyMergeBlock({ merge: { state: "BLOCKED" }, worklist }).kind).toBe("unknown-bot");
  });

  it("still refuses to call a PR mergeable while a hosted conversation is open", () => {
    const worklist = buildHostedWorklist([thread()], "abc1234");
    // Branch protection is happy (CLEAN) but Ralph is not: an open finding is a finding.
    expect(classifyMergeBlock({ merge: { state: "CLEAN" }, worklist }).kind).toBe("hosted-review");
  });

  it("reports mergeable when nothing at all blocks", () => {
    expect(
      classifyMergeBlock({ merge: { state: "CLEAN" }, worklist: buildHostedWorklist([], "abc") }).kind,
    ).toBe("mergeable");
  });
});

describe("hosted review — failure signatures and rendering", () => {
  it("keys the signature on thread identity + finding content, not the head SHA", () => {
    const a = buildHostedWorklist([thread({ reviewedSha: "aaaaaaa" })], null).findings;
    const b = buildHostedWorklist([thread({ reviewedSha: "bbbbbbb" })], null).findings;
    expect(hostedFailureDetail({ findings: a })).toBe(hostedFailureDetail({ findings: b }));
  });

  it("changes the signature when the finding itself changes", () => {
    const a = buildHostedWorklist([thread()], null).findings;
    const b = buildHostedWorklist([thread({ comments: [comment({ body: "different finding" })] })], null).findings;
    expect(hostedFailureDetail({ findings: a })).not.toBe(hostedFailureDetail({ findings: b }));
  });

  it("is order-insensitive across threads", () => {
    const t1 = thread({ id: "PRRT_a" });
    const t2 = thread({ id: "PRRT_b", comments: [comment({ id: "PRRC_2", body: "another" })] });
    expect(hostedFailureDetail({ findings: buildHostedWorklist([t1, t2], null).findings })).toBe(
      hostedFailureDetail({ findings: buildHostedWorklist([t2, t1], null).findings }),
    );
  });

  it("renders the actual findings — never a generic 'merge blocked'", () => {
    const rendered = renderHostedWorklist(
      buildHostedWorklist(
        [thread(), thread({ id: "PRRT_h", comments: [comment({ author: "alice", authorIsBot: false })] })],
        "abc1234",
      ),
    );
    expect(rendered).toContain("retry loop can spin forever");
    expect(rendered).toContain("PRRT_1");
    expect(rendered).toContain("never auto-resolve");
    expect(rendered).not.toMatch(/^merge blocked$/im);
  });
});
