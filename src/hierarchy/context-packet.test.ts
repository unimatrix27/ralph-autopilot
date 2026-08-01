import { describe, expect, it } from "vitest";
import { refKey } from "../github/ref";
import type { IssueRef } from "../github/types";
import { FakeGitHub } from "../testing/fake-github";
import {
  assembleContextPacket,
  DEFAULT_CONTEXT_CHAR_BUDGET,
  extractDesignReferences,
} from "./context-packet";

const REPO = "acme/app";
const ref = (number: number, repo = REPO): IssueRef => ({ repo, number });

/** root 1 → 2 → origin 3; 3 has child 4; 3 has siblings 7 and 9 under 2. */
function seedFamily(gh: FakeGitHub, siblingOrder: number[] = [9, 7]): void {
  gh.seedNode({ ref: ref(1), title: "root", body: "root body" });
  gh.seedNode({ ref: ref(2), title: "middle", body: "middle body" });
  gh.seedNode({ ref: ref(3), title: "origin", body: "origin body" });
  gh.seedNode({ ref: ref(4), title: "child", body: "child body" });
  gh.seedParent(ref(2), ref(1));
  gh.seedParent(ref(3), ref(2));
  gh.seedParent(ref(4), ref(3));
  for (const n of siblingOrder) {
    gh.seedNode({ ref: ref(n), title: `sibling ${n}`, body: `SIBLING-${n}-BODY` });
    gh.seedParent(ref(n), ref(2));
  }
}

describe("assembleContextPacket — the budgeted two-pass zoom-out", () => {
  it("fetches only the nodes pass two selects; siblings stay map-only", async () => {
    const gh = new FakeGitHub(REPO);
    seedFamily(gh);

    const packet = await assembleContextPacket(gh, ref(3));

    expect(packet.nodes.map((n) => refKey(n.ref))).toEqual([
      "acme/app#3",
      "acme/app#2",
      "acme/app#1",
      "acme/app#4",
    ]);
    expect(packet.nodes.map((n) => n.role)).toEqual(["origin", "ancestor", "ancestor", "child"]);
    // The siblings are in the compact map…
    const branch = packet.map.branches.find((b) => refKey(b.parent) === refKey(ref(2)));
    expect(branch?.children.map((c) => c.ref.number)).toEqual([3, 7, 9]);
    // …but pass two never fetched their bodies.
    expect(gh.contentReads.map(refKey)).not.toContain("acme/app#7");
    expect(gh.contentReads.map(refKey)).not.toContain("acme/app#9");
    expect(JSON.stringify(packet)).not.toContain("SIBLING-7-BODY");
  });

  it("fetches a sibling only when pass two is asked to select it", async () => {
    const gh = new FakeGitHub(REPO);
    seedFamily(gh);

    const packet = await assembleContextPacket(gh, ref(3), { select: [ref(7)] });

    const sibling = packet.nodes.find((n) => refKey(n.ref) === "acme/app#7");
    expect(sibling?.role).toBe("selected");
    expect(sibling?.body).toBe("SIBLING-7-BODY");
  });

  it("is deterministic across the order GitHub returns children", async () => {
    const build = async (order: number[]) => {
      const gh = new FakeGitHub(REPO);
      seedFamily(gh, order);
      return assembleContextPacket(gh, ref(3));
    };

    expect(JSON.stringify(await build([9, 7]))).toBe(JSON.stringify(await build([7, 9])));
  });

  it("stays inside the character budget and records explicit truncation metadata", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1), body: "b".repeat(100) });
    gh.seedNode({ ref: ref(2), body: "a".repeat(100) });
    gh.seedNode({ ref: ref(3), body: "c".repeat(100) });
    gh.seedParent(ref(2), ref(1));
    gh.seedParent(ref(3), ref(2));

    const packet = await assembleContextPacket(gh, ref(2), { charBudget: 150 });

    expect(packet.budget).toEqual({ charBudget: 150, charsUsed: 150 });
    expect(packet.nodes.map((n) => n.body.length)).toEqual([100, 50]);
    expect(packet.truncation.truncated).toBe(true);
    expect(packet.truncation.trimmed).toEqual([ref(1)]);
    expect(packet.truncation.dropped).toEqual([ref(3)]);
    expect(packet.nodes.find((n) => n.ref.number === 1)?.truncated).toBe(true);
  });

  it("reports no truncation when everything fits", async () => {
    const gh = new FakeGitHub(REPO);
    seedFamily(gh);

    const packet = await assembleContextPacket(gh, ref(3));

    expect(packet.truncation).toEqual({ truncated: false, trimmed: [], dropped: [] });
    expect(packet.budget.charBudget).toBe(DEFAULT_CONTEXT_CHAR_BUDGET);
    expect(packet.budget.charsUsed).toBeLessThanOrEqual(DEFAULT_CONTEXT_CHAR_BUDGET);
  });

  it("keeps the most recent comments per node and marks the node trimmed when it drops any", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(2), body: "origin" });
    for (const text of ["one", "two", "three"]) {
      gh.seedNodeComment(ref(2), { author: "human", body: text });
    }

    const packet = await assembleContextPacket(gh, ref(2), { maxCommentsPerNode: 2 });

    expect(packet.nodes[0]!.comments.map((c) => c.body)).toEqual(["two", "three"]);
    expect(packet.nodes[0]!.truncated).toBe(true);
  });

  it("surfaces an unreadable selected node as a diagnostic rather than dropping it silently", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(1), body: "root" });
    gh.seedNode({ ref: ref(2), body: "origin" });
    gh.seedParent(ref(2), ref(1));
    gh.seedInaccessible(ref(1), "unauthorized", { hierarchy: false });

    const packet = await assembleContextPacket(gh, ref(2));

    expect(packet.diagnostics).toEqual([
      { kind: "content-inaccessible", ref: ref(1), reason: "unauthorized" },
    ]);
    expect(packet.nodes.map((n) => n.ref.number)).toEqual([2]);
  });

  it("carries the unresolved-root outcome through so a caller cannot mistake it for a root", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(2) });
    gh.seedParent(ref(2), ref(99));

    const packet = await assembleContextPacket(gh, ref(2));

    expect(packet.map.root.kind).toBe("inaccessible");
  });
});

describe("extractDesignReferences", () => {
  it("pulls linked design references out of a body, deduped and sorted", () => {
    const body = [
      "Per docs/adr/0011-design-authority-rule.md this is binding.",
      "See also docs/DESIGN.md §4 and CONTEXT.md, plus ADR-0016 and ADR-0011.",
      "Repeat: docs/DESIGN.md.",
    ].join("\n");

    expect(extractDesignReferences(body)).toEqual([
      "ADR-0011",
      "ADR-0016",
      "CONTEXT.md",
      "docs/DESIGN.md",
      "docs/adr/0011-design-authority-rule.md",
    ]);
  });

  it("returns nothing for prose with no design references", () => {
    expect(extractDesignReferences("just some words about markdown")).toEqual([]);
  });
});

/**
 * Under budget pressure the packet must degrade towards the *latest* state of a
 * thread, and must say so at the packet level — a caller asking "did I lose
 * anything?" gets one answer, not a per-node hunt.
 */
describe("assembleContextPacket truncation honesty", () => {
  it("spends a tight budget on the newest comments, kept in chronological order", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(2), body: "" });
    for (const text of ["oldest---", "middle---", "newest---"]) {
      gh.seedNodeComment(ref(2), { author: "human", body: text });
    }

    const packet = await assembleContextPacket(gh, ref(2), { charBudget: 12 });

    expect(packet.nodes[0]!.comments.map((c) => c.body)).toEqual(["mid", "newest---"]);
    expect(packet.budget.charsUsed).toBeLessThanOrEqual(12);
  });

  it("reports packet-level truncation when the comment cap dropped content", async () => {
    const gh = new FakeGitHub(REPO);
    gh.seedNode({ ref: ref(2), body: "origin" });
    for (const text of ["one", "two", "three"]) {
      gh.seedNodeComment(ref(2), { author: "human", body: text });
    }

    const packet = await assembleContextPacket(gh, ref(2), { maxCommentsPerNode: 1 });

    expect(packet.nodes[0]!.truncated).toBe(true);
    expect(packet.truncation).toEqual({ truncated: true, trimmed: [ref(2)], dropped: [] });
  });
});
