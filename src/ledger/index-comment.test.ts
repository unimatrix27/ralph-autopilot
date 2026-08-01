import { describe, expect, it } from "vitest";
import { buildHierarchyMap } from "../hierarchy/map";
import type { IssueRef } from "../github/types";
import { decisionFixture as decision, FIXTURE_REPO as REPO } from "../testing/fake-decisions";
import { FakeGitHub } from "../testing/fake-github";
import { formatDecisionComment, type DecisionRecord } from "./decision";
import { foldDecisionLedger, type StoredDecision } from "./fold";
import {
  formatDecisionIndex,
  isDecisionIndexComment,
  RALPH_DECISION_INDEX_FENCE,
  syncDecisionIndex,
} from "./index-comment";
import { readInitiativeLedger } from "./ledger";

const ref = (number: number, repo = REPO): IssueRef => ({ repo, number });

/** root 1 → 2 → 3. */
async function seedTree(gh: FakeGitHub) {
  gh.seedNode({ ref: ref(1), title: "root" });
  gh.seedNode({ ref: ref(2), title: "middle" });
  gh.seedNode({ ref: ref(3), title: "leaf" });
  gh.seedParent(ref(2), ref(1));
  gh.seedParent(ref(3), ref(2));
  return buildHierarchyMap(gh, ref(3));
}

function storedOn(node: IssueRef, over: Partial<DecisionRecord>): StoredDecision {
  const record = decision({ ...over, storageNode: node });
  return { node, commentId: 4200 + node.number, record };
}

const indexComments = (gh: FakeGitHub, node: IssueRef): string[] => {
  const bodies = gh.nodeCommentBodies(node);
  return bodies.filter((b) => isDecisionIndexComment(b));
};

describe("formatDecisionIndex — the derived, replaceable root view", () => {
  it("lists active decisions with source links and says it is not authoritative", () => {
    const fold = foldDecisionLedger({
      path: [ref(1)],
      root: ref(1),
      target: ref(1),
      scope: "initiative",
      stored: [
        storedOn(ref(3), { id: "dec-b", key: "codec", scope: "issue", decision: "one fenced codec" }),
        storedOn(ref(2), { id: "dec-a", key: "authority", scope: "subtree", decision: "native graph only" }),
      ],
    });

    const body = formatDecisionIndex({ root: ref(1), fold });

    expect(body).toContain("not authoritative");
    expect(body).toContain("https://github.com/acme/app/issues/2#issuecomment-4202");
    expect(body).toContain("https://github.com/acme/app/issues/3#issuecomment-4203");
    // Deterministic order: by key.
    expect(body.indexOf("authority")).toBeLessThan(body.indexOf("codec"));
    expect(isDecisionIndexComment(body)).toBe(true);
    expect(body).toContain("```" + RALPH_DECISION_INDEX_FENCE);
  });

  it("renders byte-identically whatever order the records arrive in", () => {
    const a = storedOn(ref(2), { id: "dec-a", key: "authority", scope: "subtree" });
    const b = storedOn(ref(3), { id: "dec-b", key: "codec", scope: "issue" });
    const build = (stored: StoredDecision[]) =>
      formatDecisionIndex({
        root: ref(1),
        fold: foldDecisionLedger({ path: [ref(1)], root: ref(1), target: ref(1), scope: "initiative", stored }),
      });

    expect(build([a, b])).toBe(build([b, a]));
  });

  it("surfaces a conflicted key instead of picking a winner", () => {
    const fold = foldDecisionLedger({
      path: [ref(1)],
      root: ref(1),
      target: ref(1),
      scope: "initiative",
      stored: [
        storedOn(ref(2), { id: "dec-a", key: "k", decision: "left" }),
        storedOn(ref(3), { id: "dec-b", key: "k", decision: "right" }),
      ],
    });

    const body = formatDecisionIndex({ root: ref(1), fold });

    expect(body).toContain("conflict");
    expect(body).toContain("left");
    expect(body).toContain("right");
  });

  it("states plainly when there is nothing active yet", () => {
    const fold = foldDecisionLedger({ path: [ref(1)], root: ref(1), target: ref(1), scope: "initiative", stored: [] });
    expect(formatDecisionIndex({ root: ref(1), fold })).toContain("No active decisions");
  });
});

describe("syncDecisionIndex — one idempotent index comment on the absolute root", () => {
  it("creates the index, then leaves it untouched when nothing changed", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seedTree(gh);
    gh.seedNodeComment(ref(2), {
      author: "ralph-autopilot",
      body: formatDecisionComment(decision({ id: "dec-a", key: "authority", storageNode: ref(2) })),
    });

    const first = await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));
    const second = await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));

    expect(first).toMatchObject({ kind: "created", node: ref(1) });
    expect(second).toMatchObject({ kind: "unchanged", node: ref(1) });
    expect(indexComments(gh, ref(1))).toHaveLength(1);
    expect(gh.updatedComments).toEqual([]);
  });

  it("rebuilding twice produces byte-identical content", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seedTree(gh);
    gh.seedNodeComment(ref(3), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-a", key: "codec", scope: "issue", storageNode: ref(3) }),
      ),
    });

    await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));
    const afterFirst = indexComments(gh, ref(1))[0];
    await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));

    expect(indexComments(gh, ref(1))[0]).toBe(afterFirst);
    expect(indexComments(gh, ref(1))).toHaveLength(1);
  });

  it("edits the one index in place when the ledger moves on — never a second index", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seedTree(gh);
    gh.seedNodeComment(ref(2), {
      author: "ralph-autopilot",
      body: formatDecisionComment(decision({ id: "dec-a", key: "authority", storageNode: ref(2) })),
    });
    await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));

    gh.seedNodeComment(ref(2), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-b", key: "authority", storageNode: ref(2), supersedes: "dec-a" }),
      ),
    });
    const result = await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));

    expect(result).toMatchObject({ kind: "updated" });
    expect(indexComments(gh, ref(1))).toHaveLength(1);
    expect(indexComments(gh, ref(1))[0]).toContain("dec-b");
    expect(gh.updatedComments).toHaveLength(1);
  });

  it("reconstructs the index from canonical comments alone after the local database is gone", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seedTree(gh);
    gh.seedNodeComment(ref(2), {
      author: "ralph-autopilot",
      body: formatDecisionComment(decision({ id: "dec-a", key: "authority", storageNode: ref(2) })),
    });
    await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));
    const before = indexComments(gh, ref(1))[0]!;

    // A cold daemon: no SQLite, no in-memory ledger — only GitHub's comments.
    const coldMap = await buildHierarchyMap(gh, ref(3));
    const cold = formatDecisionIndex({ root: ref(1), fold: await readInitiativeLedger(gh, ref(1)) });

    expect(cold).toBe(before);
    expect(coldMap.root.kind).toBe("root");
  });

  it("does not read its own index comment back as a malformed decision record", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seedTree(gh);
    gh.seedNodeComment(ref(2), {
      author: "ralph-autopilot",
      body: formatDecisionComment(decision({ id: "dec-a", key: "authority", storageNode: ref(2) })),
    });
    await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(1)));

    // The index lives on the root — the same thread the next fold walks.
    const after = await readInitiativeLedger(gh, ref(1));

    expect(after.diagnostics).toEqual([]);
    expect(after.active.map((a) => a.record.id)).toEqual(["dec-a"]);
  });

  it("refuses to plant an index on a node it cannot prove is the absolute root", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(3) });
    gh.seedParent(ref(3), ref(99));
    const map = await buildHierarchyMap(gh, ref(3));

    const result = await syncDecisionIndex(gh, map, await readInitiativeLedger(gh, ref(3)));

    expect(result).toMatchObject({ kind: "skipped", reason: "unresolved-root" });
    expect(indexComments(gh, ref(3))).toEqual([]);
  });
});
