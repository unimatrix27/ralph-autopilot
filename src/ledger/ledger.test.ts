import { describe, expect, it } from "vitest";
import { buildHierarchyMap } from "../hierarchy/map";
import { refKey } from "../github/ref";
import type { IssueRef } from "../github/types";
import { decisionFixture as decision, FIXTURE_REPO as REPO } from "../testing/fake-decisions";
import { FakeGitHub } from "../testing/fake-github";
import { formatDecisionComment, parseDecisionComment } from "./decision";
import { appendDecision, readDecisionLedger, readInitiativeLedger, resolveStorageNode } from "./ledger";

const ref = (number: number, repo = REPO): IssueRef => ({ repo, number });

/** root 1 → 2 → origin 3, with a sibling subtree 7 under 1. */
async function seededMap(gh: FakeGitHub) {
  gh.seedNode({ ref: ref(1), title: "root" });
  gh.seedNode({ ref: ref(2), title: "middle" });
  gh.seedNode({ ref: ref(3), title: "origin" });
  gh.seedNode({ ref: ref(7), title: "sibling subtree" });
  gh.seedParent(ref(2), ref(1));
  gh.seedParent(ref(3), ref(2));
  gh.seedParent(ref(7), ref(1));
  return buildHierarchyMap(gh, ref(3));
}

describe("resolveStorageNode — the narrowest node matching a decision's scope", () => {
  it("stores an issue-scoped decision on the issue itself", async () => {
    const map = await seededMap(new FakeGitHub(REPO));
    expect(resolveStorageNode(map, "issue")).toEqual({ kind: "node", node: ref(3) });
  });

  it("stores a subtree-scoped decision on the named subtree root", async () => {
    const map = await seededMap(new FakeGitHub(REPO));
    expect(resolveStorageNode(map, "subtree", ref(2))).toEqual({ kind: "node", node: ref(2) });
  });

  it("rejects a subtree scope with no subtree root named", async () => {
    const map = await seededMap(new FakeGitHub(REPO));
    expect(resolveStorageNode(map, "subtree")).toMatchObject({
      kind: "rejected",
      reason: "subtree-root-missing",
    });
  });

  it("rejects a subtree root that is not on the issue's ancestor path", async () => {
    const map = await seededMap(new FakeGitHub(REPO));
    expect(resolveStorageNode(map, "subtree", ref(7))).toMatchObject({
      kind: "rejected",
      reason: "subtree-root-off-path",
    });
  });

  it("stores an initiative-scoped decision on the absolute root", async () => {
    const map = await seededMap(new FakeGitHub(REPO));
    expect(resolveStorageNode(map, "initiative")).toEqual({ kind: "node", node: ref(1) });
  });

  it("refuses an initiative scope when the absolute root is unresolved — never a false root", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(3) });
    gh.seedParent(ref(3), ref(99));
    const map = await buildHierarchyMap(gh, ref(3));

    expect(resolveStorageNode(map, "initiative")).toMatchObject({
      kind: "rejected",
      reason: "unresolved-root",
    });
  });
});

describe("appendDecision — append-only canonical records", () => {
  it("posts the record on the resolved storage node and stamps it there", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);

    const result = await appendDecision(gh, {
      map,
      subtreeRoot: ref(2),
      record: decision({ scope: "subtree", storageNode: ref(999) }),
    });

    expect(result).toMatchObject({ kind: "appended", node: ref(2) });
    if (result.kind !== "appended") throw new Error("expected an append");
    expect(result.record.storageNode).toEqual(ref(2));
    const posted = (await gh.readIssueContent(ref(2)));
    if (posted.kind !== "content") throw new Error("expected content");
    expect(parseDecisionComment(posted.comments.at(-1)!.body)?.storageNode).toEqual(ref(2));
  });

  it("rejects rather than parking a record on the wrong node", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);

    const result = await appendDecision(gh, {
      map,
      record: decision({ scope: "subtree" }),
    });

    expect(result).toMatchObject({ kind: "rejected", reason: "subtree-root-missing" });
    const root = await gh.readIssueContent(ref(1));
    if (root.kind !== "content") throw new Error("expected content");
    expect(root.comments).toEqual([]);
  });

  it("never edits the superseded record when a newer one lands", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);
    const first = decision({ id: "dec-a", key: "k", scope: "issue", decision: "old call" });
    await appendDecision(gh, { map, record: first });
    await appendDecision(gh, {
      map,
      record: decision({ id: "dec-b", key: "k", scope: "issue", decision: "new call", supersedes: "dec-a" }),
    });

    const content = await gh.readIssueContent(ref(3));
    if (content.kind !== "content") throw new Error("expected content");
    expect(content.comments).toHaveLength(2);
    expect(parseDecisionComment(content.comments[0]!.body)?.decision).toBe("old call");
    expect(gh.updatedComments).toEqual([]);
  });
});

describe("readDecisionLedger — the active ledger a descendant loads", () => {
  it("folds root→issue and inherits only what the path carries", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);
    gh.seedNodeComment(ref(1), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-root", key: "budget", scope: "initiative", storageNode: ref(1) }),
      ),
    });
    gh.seedNodeComment(ref(2), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-mid", key: "codec", scope: "subtree", storageNode: ref(2) }),
      ),
    });
    // A decision on a sibling subtree the issue must NOT inherit.
    gh.seedNodeComment(ref(7), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-sib", key: "sibling", scope: "subtree", storageNode: ref(7) }),
      ),
    });

    const fold = await readDecisionLedger(gh, map);

    expect(fold.active.map((a) => a.record.id).sort()).toEqual(["dec-mid", "dec-root"]);
    expect(gh.contentReads.map(refKey)).toEqual(["acme/app#1", "acme/app#2", "acme/app#3"]);
  });

  it("surfaces an unreadable path node as a diagnostic instead of dropping it", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);
    gh.seedInaccessible(ref(1), "unauthorized", { hierarchy: false });

    const fold = await readDecisionLedger(gh, map);

    expect(fold.diagnostics).toEqual([
      { kind: "node-unreadable", node: ref(1), reason: "unauthorized" },
    ]);
  });

  it("rebuilds the whole active ledger from GitHub alone — no local database", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);
    await appendDecision(gh, {
      map,
      subtreeRoot: ref(2),
      record: decision({ id: "dec-a", key: "codec", scope: "subtree" }),
    });
    await appendDecision(gh, {
      map,
      record: decision({ id: "dec-b", key: "codec", scope: "issue", supersedes: "dec-a" }),
    });

    // A cold reader: nothing but the canonical comments GitHub holds.
    const cold = await readDecisionLedger(gh, await seededMap(gh));

    expect(cold.active.map((a) => a.record.id)).toEqual(["dec-b"]);
    expect(cold.superseded.map((a) => a.record.id)).toEqual(["dec-a"]);
  });
});

describe("readInitiativeLedger — the whole-subtree view the root index renders", () => {
  it("crawls native sub-issues from the root and folds every record it finds", async () => {
    const gh = new FakeGitHub(REPO);
    const map = await seededMap(gh);
    await appendDecision(gh, { map, record: decision({ id: "dec-leaf", key: "leaf", scope: "issue" }) });
    gh.seedNodeComment(ref(7), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-sib", key: "sibling", scope: "subtree", storageNode: ref(7) }),
      ),
    });

    const fold = await readInitiativeLedger(gh, ref(1));

    expect(fold.active.map((a) => a.record.id).sort()).toEqual(["dec-leaf", "dec-sib"]);
    expect(fold.inapplicable).toEqual([]);
  });

  it("is cycle-safe and caps the crawl loudly rather than looping", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1) });
    for (let n = 2; n <= 6; n++) {
      gh.seedNode({ ref: ref(n) });
      gh.seedParent(ref(n), ref(n - 1));
    }

    const fold = await readInitiativeLedger(gh, ref(1), { maxNodes: 3 });

    expect(fold.diagnostics).toEqual([{ kind: "crawl-capped", maxNodes: 3 }]);
  });
});

/**
 * The read side must refuse exactly what the write side refuses. A ledger that
 * folds open where `appendDecision` fails closed lets a record bind a tree whose
 * top nobody could establish.
 */
describe("readDecisionLedger fails closed on an unproven root", () => {
  it("ignores an initiative record on the highest node reached when the climb did not prove a root", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1) });
    gh.seedNode({ ref: ref(3) });
    gh.seedParent(ref(3), ref(1));
    gh.seedParent(ref(1), ref(999)); // 1's own parent is unreadable → no proven root
    gh.seedNodeComment(ref(1), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-i", key: "budget", scope: "initiative", storageNode: ref(1) }),
      ),
    });
    const map = await buildHierarchyMap(gh, ref(3));
    expect(map.root.kind).toBe("inaccessible");

    // The write side already refuses…
    expect(resolveStorageNode(map, "initiative")).toMatchObject({ reason: "unresolved-root" });
    // …so the read side must too.
    const fold = await readDecisionLedger(gh, map);

    expect(fold.active).toEqual([]);
    expect(fold.diagnostics.some((d) => d.kind === "scope-node-mismatch")).toBe(true);
  });

  it("honours the same record once the root is genuinely proven", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1) });
    gh.seedNode({ ref: ref(3) });
    gh.seedParent(ref(3), ref(1));
    gh.seedNodeComment(ref(1), {
      author: "ralph-autopilot",
      body: formatDecisionComment(
        decision({ id: "dec-i", key: "budget", scope: "initiative", storageNode: ref(1) }),
      ),
    });

    const fold = await readDecisionLedger(gh, await buildHierarchyMap(gh, ref(3)));

    expect(fold.active.map((a) => a.record.id)).toEqual(["dec-i"]);
  });
});

describe("readInitiativeLedger reports an incomplete child listing", () => {
  it("says so when GitHub paged away sub-issues, so the index is not read as complete", async () => {
    const port = {
      readIssueHierarchy: async (r: IssueRef) => ({
        kind: "node" as const,
        node: { ref: r, id: `I_${r.number}`, title: "n", state: "OPEN" as const },
        parent: { kind: "none" as const },
        children: [],
        childCount: 120,
      }),
      readIssueContent: async (r: IssueRef) => ({
        kind: "content" as const,
        node: { ref: r, id: `I_${r.number}`, title: "n", state: "OPEN" as const },
        body: "",
        comments: [],
      }),
    };

    const fold = await readInitiativeLedger(port, ref(1));

    expect(fold.diagnostics).toEqual([
      { kind: "crawl-incomplete", node: ref(1), listed: 0, total: 120 },
    ]);
  });
});
