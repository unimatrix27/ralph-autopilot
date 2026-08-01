import { describe, expect, it } from "vitest";
import type { IssueRef, PrComment } from "../github/types";
import { decisionFixture as decision, fixtureRef as ref } from "../testing/fake-decisions";
import { formatDecisionComment, type DecisionRecord } from "./decision";
import { collectDecisionComments, foldDecisionLedger, type StoredDecision } from "./fold";

/** root 1 → 2 → 3 (the issue being worked). */
const PATH = [ref(1), ref(2), ref(3)];

let nextId = 900;
function stored(node: IssueRef, record: DecisionRecord): StoredDecision {
  return { node, commentId: nextId++, record: { ...record, storageNode: node } };
}

function comment(record: DecisionRecord, id: number): PrComment {
  return { id, author: "ralph-autopilot", body: formatDecisionComment(record) };
}

describe("collectDecisionComments", () => {
  it("collects fenced decisions and ignores ordinary comments entirely", () => {
    const comments: PrComment[] = [
      { id: 1, author: "human", body: "Looks good to me — ship it." },
      comment(decision({ id: "dec-a", storageNode: ref(2) }), 2),
    ];

    const { stored: found, diagnostics } = collectDecisionComments(ref(2), comments);

    expect(found.map((s) => s.record.id)).toEqual(["dec-a"]);
    expect(found[0]!.commentId).toBe(2);
    expect(found[0]!.node).toEqual(ref(2));
    expect(diagnostics).toEqual([]);
  });

  it("returns a malformed fenced comment as a diagnostic, never as state", () => {
    const comments: PrComment[] = [
      { id: 3, author: "ralph-autopilot", body: "```ralph-decision\n{ broken\n```" },
    ];

    const { stored: found, diagnostics } = collectDecisionComments(ref(2), comments);

    expect(found).toEqual([]);
    expect(diagnostics).toEqual([
      { kind: "malformed", node: ref(2), commentId: 3, detail: expect.any(String) },
    ]);
  });

  it("flags a record whose declared storage node is not where it lives", () => {
    const comments = [comment(decision({ id: "dec-b", storageNode: ref(99) }), 4)];

    const { stored: found, diagnostics } = collectDecisionComments(ref(2), comments);

    expect(found).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ kind: "storage-node-mismatch", commentId: 4 });
  });
});

describe("foldDecisionLedger — the active ledger for one issue", () => {
  it("inherits a subtree decision stored on an ancestor along the root→issue path", () => {
    const fold = foldDecisionLedger({
      path: PATH,
      root: ref(1),
      target: ref(3),
      stored: [stored(ref(2), decision({ id: "dec-a", key: "k", scope: "subtree" }))],
    });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-a"]);
    expect(fold.conflicts).toEqual([]);
  });

  it("does not inherit an issue-scoped decision stored on an ancestor", () => {
    const fold = foldDecisionLedger({
      path: PATH,
      root: ref(1),
      target: ref(3),
      stored: [stored(ref(2), decision({ id: "dec-a", key: "k", scope: "issue" }))],
    });

    expect(fold.active).toEqual([]);
    expect(fold.inapplicable.map((s) => s.record.id)).toEqual(["dec-a"]);
  });

  it("applies an issue-scoped decision stored on the issue itself", () => {
    const fold = foldDecisionLedger({
      path: PATH,
      root: ref(1),
      target: ref(3),
      stored: [stored(ref(3), decision({ id: "dec-a", key: "k", scope: "issue" }))],
    });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-a"]);
  });

  it("applies an initiative decision only from the absolute root", () => {
    const fold = foldDecisionLedger({
      path: PATH,
      root: ref(1),
      target: ref(3),
      stored: [stored(ref(1), decision({ id: "dec-a", key: "k", scope: "initiative" }))],
    });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-a"]);
  });

  it("fails closed on an initiative decision parked below the absolute root", () => {
    const fold = foldDecisionLedger({
      path: PATH,
      root: ref(1),
      target: ref(3),
      stored: [stored(ref(2), decision({ id: "dec-a", key: "k", scope: "initiative" }))],
    });

    expect(fold.active).toEqual([]);
    expect(fold.diagnostics[0]).toMatchObject({ kind: "scope-node-mismatch" });
  });

  it("ignores a decision stored off the issue's ancestor path (a sibling subtree)", () => {
    const fold = foldDecisionLedger({
      path: PATH,
      root: ref(1),
      target: ref(3),
      stored: [stored(ref(77), decision({ id: "dec-a", key: "k", scope: "subtree" }))],
    });

    expect(fold.active).toEqual([]);
    expect(fold.inapplicable.map((s) => s.record.id)).toEqual(["dec-a"]);
  });

  it("folds exactly one active decision when a record supersedes another", () => {
    const older = stored(ref(2), decision({ id: "dec-a", key: "k", decision: "old call" }));
    const newer = stored(
      ref(2),
      decision({ id: "dec-b", key: "k", decision: "new call", supersedes: "dec-a" }),
    );

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [older, newer] });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-b"]);
    expect(fold.superseded.map((s) => s.record.id)).toEqual(["dec-a"]);
    // The superseded record is untouched — append-only, never edited.
    expect(fold.superseded[0]!.record.decision).toBe("old call");
    expect(fold.conflicts).toEqual([]);
  });

  it("supersedes across nodes on the path (a narrower node overriding an ancestor)", () => {
    const broad = stored(ref(1), decision({ id: "dec-a", key: "k", scope: "initiative" }));
    const narrow = stored(
      ref(3),
      decision({ id: "dec-b", key: "k", scope: "issue", supersedes: "dec-a" }),
    );

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [broad, narrow] });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-b"]);
    expect(fold.superseded.map((s) => s.record.id)).toEqual(["dec-a"]);
  });

  it("fails closed on two conflicting active records for one key, with the evidence", () => {
    const a = stored(ref(2), decision({ id: "dec-a", key: "k", decision: "left" }));
    const b = stored(ref(2), decision({ id: "dec-b", key: "k", decision: "right" }));

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [a, b] });

    expect(fold.active).toEqual([]);
    expect(fold.conflicts).toHaveLength(1);
    expect(fold.conflicts[0]!.key).toBe("k");
    expect(fold.conflicts[0]!.claims.map((c) => c.record.decision).sort()).toEqual([
      "left",
      "right",
    ]);
    // Enough evidence for a later master/human adjudication: where each record lives.
    expect(fold.conflicts[0]!.claims.every((c) => c.commentId > 0)).toBe(true);
    expect(fold.conflicts[0]!.claims.map((c) => c.node)).toEqual([ref(2), ref(2)]);
  });

  it("keeps unrelated keys active while one key is conflicted", () => {
    const a = stored(ref(2), decision({ id: "dec-a", key: "k" }));
    const b = stored(ref(2), decision({ id: "dec-b", key: "k" }));
    const c = stored(ref(2), decision({ id: "dec-c", key: "other" }));

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [a, b, c] });

    expect(fold.active.map((x) => x.record.key)).toEqual(["other"]);
    expect(fold.conflicts.map((x) => x.key)).toEqual(["k"]);
  });

  it("flags a supersedes pointer that resolves to nothing, keeping the new record active", () => {
    const orphan = stored(ref(2), decision({ id: "dec-b", key: "k", supersedes: "dec-gone" }));

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [orphan] });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-b"]);
    expect(fold.diagnostics[0]).toMatchObject({ kind: "dangling-supersedes" });
  });

  it("orders active decisions deterministically by key then id", () => {
    const shuffled = [
      stored(ref(2), decision({ id: "dec-z", key: "zeta" })),
      stored(ref(2), decision({ id: "dec-b", key: "alpha" })),
      stored(ref(2), decision({ id: "dec-a", key: "alpha", supersedes: "dec-b" })),
      stored(ref(2), decision({ id: "dec-m", key: "mu" })),
    ];

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: shuffled });

    expect(fold.active.map((a) => a.record.key)).toEqual(["alpha", "mu", "zeta"]);
  });
});

/**
 * Regressions on the fold's fail-closed edges — each one a way the ledger could
 * quietly bind (or quietly refuse) a decision nobody intended.
 */
describe("foldDecisionLedger fail-closed edges", () => {
  it("refuses an initiative record when no absolute root was proven", () => {
    // A climb that ended in a cycle / unreadable parent leaves `path[0]` as merely
    // the highest node reached. The write side already refuses to store here, so the
    // read side must refuse to honour a record that is already there.
    const fold = foldDecisionLedger({
      path: PATH,
      target: ref(3),
      stored: [stored(ref(1), decision({ id: "dec-i", key: "k", scope: "initiative" }))],
    });

    expect(fold.active).toEqual([]);
    expect(fold.diagnostics[0]).toMatchObject({ kind: "scope-node-mismatch" });
  });

  it("treats a byte-identical re-post as one decision, not a self-conflict", () => {
    // `appendDecision` does no read-before-write, so a post that times out after
    // GitHub committed it and is then retried leaves two identical comments.
    const record = decision({ id: "dec-a", key: "k", scope: "subtree" });
    const first = stored(ref(2), record);
    const retry = stored(ref(2), record);

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [first, retry] });

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-a"]);
    expect(fold.conflicts).toEqual([]);
    expect(fold.diagnostics[0]).toMatchObject({ kind: "duplicate-record-id", identical: true });
  });

  it("still conflicts when one id carries two DIFFERENT records", () => {
    const a = stored(ref(2), decision({ id: "dec-a", key: "k", decision: "left" }));
    const b = stored(ref(2), decision({ id: "dec-a", key: "k", decision: "right" }));

    const fold = foldDecisionLedger({ path: PATH, root: ref(1), target: ref(3), stored: [a, b] });

    expect(fold.active).toEqual([]);
    expect(fold.conflicts.map((c) => c.key)).toEqual(["k"]);
    expect(fold.diagnostics[0]).toMatchObject({ kind: "duplicate-record-id", identical: false });
  });
});

/**
 * The whole-tree fold the root index renders. It spans nodes with no ancestor
 * relationship, so "same key" alone cannot mean "disagreement".
 */
describe("foldDecisionLedger in initiative scope", () => {
  it("does not manufacture a conflict from two issues deciding their own business", () => {
    const ten = stored(ref(10), decision({ id: "dec-a", key: "test-strategy", scope: "issue" }));
    const eleven = stored(ref(11), decision({ id: "dec-b", key: "test-strategy", scope: "issue" }));

    const fold = foldDecisionLedger({
      path: [ref(1)],
      root: ref(1),
      target: ref(1),
      scope: "initiative",
      stored: [ten, eleven],
    });

    expect(fold.conflicts).toEqual([]);
    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-a", "dec-b"]);
  });

  it("still fails closed on two records governing the SAME node under one key", () => {
    const a = stored(ref(10), decision({ id: "dec-a", key: "k", scope: "issue" }));
    const b = stored(ref(10), decision({ id: "dec-b", key: "k", scope: "issue" }));

    const fold = foldDecisionLedger({
      path: [ref(1)],
      root: ref(1),
      target: ref(1),
      scope: "initiative",
      stored: [a, b],
    });

    expect(fold.active).toEqual([]);
    expect(fold.conflicts.map((c) => c.key)).toEqual(["k"]);
  });
});
