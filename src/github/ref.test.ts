import { describe, expect, it } from "vitest";
import {
  commentUrl,
  compareRefs,
  formatRef,
  issueUrl,
  parseIssueRef,
  refKey,
  sameRef,
  sortNodes,
} from "./ref";
import type { HierarchyNode, IssueRef } from "./types";

const ref = (repo: string, number: number): IssueRef => ({ repo, number });

const node = (repo: string, number: number): HierarchyNode => ({
  ref: ref(repo, number),
  id: `I_${repo}_${number}`,
  title: `Issue ${number}`,
  state: "OPEN",
});

describe("issue refs", () => {
  it("keys a node by `owner/repo#n` so cross-repo numbers cannot collide", () => {
    expect(refKey(ref("acme/app", 7))).toBe("acme/app#7");
    expect(refKey(ref("acme/infra", 7))).not.toBe(refKey(ref("acme/app", 7)));
  });

  it("round-trips through the `owner/repo#n` text form", () => {
    expect(parseIssueRef(formatRef(ref("acme/app", 41)))).toEqual(ref("acme/app", 41));
  });

  it("rejects text that is not a fully-qualified cross-repo ref", () => {
    expect(parseIssueRef("#41")).toBeNull();
    expect(parseIssueRef("acme/app")).toBeNull();
    expect(parseIssueRef("acme/app#zero")).toBeNull();
    expect(parseIssueRef("acme/app#0")).toBeNull();
  });

  it("compares refs by repo then number — the deterministic sort key", () => {
    expect(compareRefs(ref("acme/app", 2), ref("acme/app", 10))).toBeLessThan(0);
    expect(compareRefs(ref("acme/infra", 2), ref("acme/app", 10))).toBeGreaterThan(0);
    expect(compareRefs(ref("acme/app", 2), ref("acme/app", 2))).toBe(0);
    expect(sameRef(ref("acme/app", 2), ref("acme/app", 2))).toBe(true);
    expect(sameRef(ref("acme/app", 2), ref("acme/infra", 2))).toBe(false);
  });

  it("sorts nodes deterministically regardless of the order GitHub returned them", () => {
    const scrambled = [node("acme/app", 10), node("acme/infra", 1), node("acme/app", 2)];
    expect(sortNodes(scrambled).map((n) => refKey(n.ref))).toEqual([
      "acme/app#2",
      "acme/app#10",
      "acme/infra#1",
    ]);
    // Pure: the input array is untouched.
    expect(refKey(scrambled[0]!.ref)).toBe("acme/app#10");
  });

  it("builds issue and comment permalinks for decision-record source links", () => {
    expect(issueUrl(ref("acme/app", 41))).toBe("https://github.com/acme/app/issues/41");
    expect(commentUrl(ref("acme/app", 41), 5001)).toBe(
      "https://github.com/acme/app/issues/41#issuecomment-5001",
    );
  });
});
