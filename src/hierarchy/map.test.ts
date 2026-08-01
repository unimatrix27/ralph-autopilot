import { describe, expect, it } from "vitest";
import { refKey } from "../github/ref";
import type { IssueRef } from "../github/types";
import { FakeGitHub } from "../testing/fake-github";
import { buildHierarchyMap, HIERARCHY_DEPTH_CEILING } from "./map";

const REPO = "acme/app";
const ref = (number: number, repo = REPO): IssueRef => ({ repo, number });

/**
 * A native parent chain `top → … → bottom` (each element the parent of the next),
 * seeded through GitHub's native parent/sub-issue graph only — no prose, no labels.
 */
function seedChain(gh: FakeGitHub, numbers: number[], titles: Record<number, string> = {}): void {
  for (const n of numbers) {
    gh.seedNode({ ref: ref(n), title: titles[n] ?? `Issue ${n}` });
  }
  for (let i = 1; i < numbers.length; i++) {
    gh.seedParent(ref(numbers[i]!), ref(numbers[i - 1]!));
  }
}

describe("buildHierarchyMap — climbing GitHub's native parent graph", () => {
  it("resolves the absolute root of a five-level-deep native chain", async () => {
    const gh = new FakeGitHub(REPO);
    // Titles deliberately mislabel the levels: the *only* hierarchy authority is
    // GitHub's native parent edge, never an "epic" / "master-epic" / "wayfinder" word.
    seedChain(gh, [1, 2, 3, 4, 5, 6], {
      1: "chore: tidy the changelog",
      3: "Master epic: the whole programme",
      4: "Wayfinder: quarter plan",
      6: "epic: leaf work",
    });

    const map = await buildHierarchyMap(gh, ref(6));

    expect(map.root).toEqual({ kind: "root", node: expect.objectContaining({ ref: ref(1) }) });
    expect(map.path.map((n) => n.ref.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(map.origin).toEqual(ref(6));
  });

  it("carries sibling branches in the compact map without any bodies", async () => {
    const gh = new FakeGitHub(REPO);
    seedChain(gh, [1, 2, 3]);
    // 3's siblings under 2, seeded out of order to prove the map is sorted.
    gh.seedNode({ ref: ref(9), body: "sibling body that must not be fetched" });
    gh.seedNode({ ref: ref(7), body: "another sibling body" });
    gh.seedParent(ref(9), ref(2));
    gh.seedParent(ref(7), ref(2));

    const map = await buildHierarchyMap(gh, ref(3));

    const branch = map.branches.find((b) => refKey(b.parent) === refKey(ref(2)));
    expect(branch?.children.map((c) => c.ref.number)).toEqual([3, 7, 9]);
    // Compact: a branch child carries ref/id/title/state and nothing else.
    expect(Object.keys(branch!.children[0]!).sort()).toEqual(["id", "ref", "state", "title"]);
    expect(JSON.stringify(map)).not.toContain("must not be fetched");
  });

  it("is deterministic regardless of the order GitHub returns children", async () => {
    const build = async (order: number[]) => {
      const gh = new FakeGitHub(REPO);
      seedChain(gh, [1, 2]);
      for (const n of order) {
        gh.seedNode({ ref: ref(n) });
        gh.seedParent(ref(n), ref(2));
      }
      return buildHierarchyMap(gh, ref(2));
    };

    expect(JSON.stringify(await build([5, 3, 4]))).toBe(JSON.stringify(await build([4, 5, 3])));
  });

  it("reports a cycle explicitly — never a false root", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1) });
    gh.seedNode({ ref: ref(2) });
    gh.seedParent(ref(1), ref(2));
    gh.seedParent(ref(2), ref(1));

    const map = await buildHierarchyMap(gh, ref(1));

    expect(map.root.kind).toBe("cycle");
    if (map.root.kind !== "cycle") throw new Error("expected a cycle");
    expect(map.root.at).toEqual(ref(1));
    expect(map.root.chain.map(refKey)).toEqual(["acme/app#1", "acme/app#2"]);
  });

  it("fails loud on an over-ceiling chain instead of silently truncating", async () => {
    const gh = new FakeGitHub(REPO);
    seedChain(gh, [1, 2, 3, 4, 5, 6]);

    const map = await buildHierarchyMap(gh, ref(6), { ceiling: 3 });

    expect(map.root).toEqual({ kind: "over-ceiling", ceiling: 3, unreadAncestor: ref(3) });
    expect(map.path.map((n) => n.ref.number)).toEqual([4, 5, 6]);
  });

  it("defaults to a technical safety ceiling, not a product-semantics depth limit", async () => {
    expect(HIERARCHY_DEPTH_CEILING).toBeGreaterThan(5);
    const gh = new FakeGitHub(REPO);
    const deep = Array.from({ length: HIERARCHY_DEPTH_CEILING + 1 }, (_, i) => i + 1);
    seedChain(gh, deep);

    const map = await buildHierarchyMap(gh, ref(deep.at(-1)!));

    expect(map.root.kind).toBe("over-ceiling");
  });

  it("reports a deleted parent explicitly — the child never becomes the root", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(2) });
    gh.seedParent(ref(2), ref(99)); // 99 was deleted: unreadable

    const map = await buildHierarchyMap(gh, ref(2));

    expect(map.root).toEqual({
      kind: "inaccessible",
      ref: ref(99),
      reason: "deleted",
      via: ref(2),
    });
    expect(map.path.map((n) => n.ref.number)).toEqual([2]);
  });

  it("reports an unauthorized parent explicitly, distinct from a deleted one", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(2) });
    gh.seedNode({ ref: ref(500, "private/vault") });
    gh.seedParent(ref(2), ref(500, "private/vault"));
    gh.seedInaccessible(ref(500, "private/vault"), "unauthorized");

    const map = await buildHierarchyMap(gh, ref(2));

    expect(map.root).toEqual({
      kind: "inaccessible",
      ref: ref(500, "private/vault"),
      reason: "unauthorized",
      via: ref(2),
    });
  });

  it("represents a cross-repository parent when GitHub returns one", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(4, "acme/programme"), title: "programme root" });
    gh.seedNode({ ref: ref(2) });
    gh.seedParent(ref(2), ref(4, "acme/programme"));

    const map = await buildHierarchyMap(gh, ref(2));

    expect(map.root.kind).toBe("root");
    expect(map.path.map((n) => refKey(n.ref))).toEqual(["acme/programme#4", "acme/app#2"]);
  });

  it("reports an inaccessible origin without inventing a path", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedInaccessible(ref(3), "unauthorized");

    const map = await buildHierarchyMap(gh, ref(3));

    expect(map.root).toEqual({ kind: "inaccessible", ref: ref(3), reason: "unauthorized" });
    expect(map.path).toEqual([]);
  });

  it("caps the children listed per node and says how many it elided", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1) });
    for (let n = 10; n < 15; n++) {
      gh.seedNode({ ref: ref(n) });
      gh.seedParent(ref(n), ref(1));
    }

    const map = await buildHierarchyMap(gh, ref(1), { maxChildrenPerNode: 2 });

    const branch = map.branches[0]!;
    expect(branch.children.map((c) => c.ref.number)).toEqual([10, 11]);
    expect(branch.omitted).toBe(3);
  });
});

/**
 * Two ways the map could quietly lie about identity or completeness. Both are the
 * same class of defect as a false root: the caller is told something is settled
 * when it is not.
 */
describe("buildHierarchyMap identity and completeness", () => {
  it("adopts GitHub's canonical spelling of the origin ref", async () => {
    // Repo names are case-insensitive and survive renames, so GitHub answers a
    // `Acme/App` query with `acme/app`. An origin left in the caller's spelling
    // would match no path node, and every downstream `sameRef(…, origin)` — node
    // selection, storage-node resolution — would silently mis-answer.
    const reader = {
      readIssueHierarchy: async () => ({
        kind: "node" as const,
        node: { ref: ref(3), id: "I_3", title: "leaf", state: "OPEN" as const },
        parent: { kind: "none" as const },
        children: [],
      }),
    };

    const map = await buildHierarchyMap(reader, { repo: "Acme/App", number: 3 });

    expect(map.origin).toEqual(ref(3));
    expect(map.path.some((n) => refKey(n.ref) === refKey(map.origin))).toBe(true);
  });

  it("keeps the caller's ref when the origin itself could not be read", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await buildHierarchyMap(gh, ref(404));
    expect(map.origin).toEqual(ref(404));
  });

  it("counts children GitHub paged away, not just the ones over its own cap", async () => {
    // A sub-issue page tops out server-side, so `children` can already be a prefix.
    // `omitted: 0` on a truncated listing would read as "this listing is complete".
    const reader = {
      readIssueHierarchy: async () => ({
        kind: "node" as const,
        node: { ref: ref(1), id: "I_1", title: "root", state: "OPEN" as const },
        parent: { kind: "none" as const },
        children: [{ ref: ref(9), id: "I_9", title: "child", state: "OPEN" as const }],
        childCount: 120,
      }),
    };

    const map = await buildHierarchyMap(reader, ref(1), { maxChildrenPerNode: 50 });

    expect(map.branches[0]!.children).toHaveLength(1);
    expect(map.branches[0]!.omitted).toBe(119);
  });
});
