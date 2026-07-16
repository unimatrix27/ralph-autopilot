import { describe, expect, it } from "vitest";
import { parseBlockedBy } from "./blocked";

const REPO = "owner/repo";

describe("parseBlockedBy", () => {
  it("returns the issue numbers under a ## Blocked by heading", () => {
    const body = [
      "## What to build",
      "Some prose mentioning #99 that is not a dependency.",
      "",
      "## Blocked by",
      "",
      "- #1",
      "- #23",
      "",
      "## Acceptance criteria",
      "- [ ] something referencing #77",
    ].join("\n");
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [1, 23], crossRepo: [], unparsed: [] });
  });

  it("is case-insensitive on the heading and tolerates extra hashes", () => {
    const body = "### blocked BY\n- #5\n";
    expect(parseBlockedBy(body, REPO).refs).toEqual([5]);
  });

  it("handles bare and gh-style references on one line", () => {
    const body = "## Blocked by\n- depends on #4 and #6\n- #4\n";
    expect(parseBlockedBy(body, REPO).refs).toEqual([4, 6]);
  });

  it("returns empty when there is no Blocked by section", () => {
    expect(parseBlockedBy("## What to build\n- #1\n", REPO)).toEqual({ refs: [], crossRepo: [], unparsed: [] });
    expect(parseBlockedBy("", REPO)).toEqual({ refs: [], crossRepo: [], unparsed: [] });
  });

  it("stops at the next heading", () => {
    const body = "## Blocked by\n- #1\n## Notes\n- #2\n";
    expect(parseBlockedBy(body, REPO).refs).toEqual([1]);
  });

  // Issue #8: the incident shape — GitHub renders (and humans/planning agents write)
  // dependencies as markdown links to the issue URL, with no `#n` token anywhere.
  it("parses a same-repo issue URL inside a markdown link (the incident shape)", () => {
    const body = ["## Blocked by", "", "- [Title of the prerequisite](https://github.com/owner/repo/issues/2765)"].join(
      "\n",
    );
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [2765], crossRepo: [], unparsed: [] });
  });

  it("parses a bare same-repo issue URL", () => {
    const body = "## Blocked by\n- https://github.com/owner/repo/issues/12\n";
    expect(parseBlockedBy(body, REPO).refs).toEqual([12]);
  });

  it("parses owner/repo#n shorthand for the same repo", () => {
    const body = "## Blocked by\n- owner/repo#7\n";
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [7], crossRepo: [], unparsed: [] });
  });

  it("parses a mixed list of all three same-repo formats, in order", () => {
    const body = [
      "## Blocked by",
      "- #1",
      "- [prereq](https://github.com/owner/repo/issues/2)",
      "- owner/repo#3",
    ].join("\n");
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [1, 2, 3], crossRepo: [], unparsed: [] });
  });

  it("de-duplicates the same issue across formats", () => {
    const body = ["## Blocked by", "- #4", "- [same issue](https://github.com/owner/repo/issues/4)", "- owner/repo#4"].join(
      "\n",
    );
    expect(parseBlockedBy(body, REPO).refs).toEqual([4]);
  });

  it("matches the owning repo case-insensitively", () => {
    const body = "## Blocked by\n- [x](https://github.com/Owner/Repo/issues/9)\n- OWNER/REPO#10\n";
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [9, 10], crossRepo: [], unparsed: [] });
  });

  it("tolerates a URL fragment/suffix after the issue number", () => {
    const body = "## Blocked by\n- [t](https://github.com/owner/repo/issues/10#issuecomment-123)\n";
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [10], crossRepo: [], unparsed: [] });
  });

  // Issue #8: a cross-repo link must NOT be parsed as a local issue number — the gate
  // would gate on an unrelated local issue. It is surfaced, never silently dropped.
  it("reports a cross-repo issue URL as crossRepo, never as a local ref", () => {
    const body = "## Blocked by\n- [dep](https://github.com/other/thing/issues/5)\n";
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [], crossRepo: ["other/thing#5"], unparsed: [] });
  });

  it("reports cross-repo owner/repo#n shorthand as crossRepo", () => {
    const body = "## Blocked by\n- other/thing#5\n";
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [], crossRepo: ["other/thing#5"], unparsed: [] });
  });

  it("de-duplicates cross-repo refs across formats", () => {
    const body = ["## Blocked by", "- other/thing#5", "- [dup](https://github.com/other/thing/issues/5)"].join("\n");
    expect(parseBlockedBy(body, REPO).crossRepo).toEqual(["other/thing#5"]);
  });

  it("separates same-repo refs from cross-repo refs in a mixed list", () => {
    const body = [
      "## Blocked by",
      "- #1",
      "- [local](https://github.com/owner/repo/issues/2)",
      "- [foreign](https://github.com/other/thing/issues/3)",
    ].join("\n");
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [1, 2], crossRepo: ["other/thing#3"], unparsed: [] });
  });

  // Issue #8: a non-empty list item that yields no reference at all is captured so the
  // caller can warn — a Blocked by section that parses to nothing is never a silent no-op.
  it("captures non-empty list items that yield no reference", () => {
    const body = ["## Blocked by", "- [spec](https://example.com/spec)", "- the auth refactor", "- "].join("\n");
    expect(parseBlockedBy(body, REPO)).toEqual({
      refs: [],
      crossRepo: [],
      unparsed: ["[spec](https://example.com/spec)", "the auth refactor"],
    });
  });

  it("does not capture list items that carried a parseable ref", () => {
    const body = ["## Blocked by", "- #1", "- unparseable prose"].join("\n");
    expect(parseBlockedBy(body, REPO)).toEqual({ refs: [1], crossRepo: [], unparsed: ["unparseable prose"] });
  });

  it("does not treat a PR URL as an issue ref (it becomes an unparsed item)", () => {
    const body = "## Blocked by\n- [pr](https://github.com/owner/repo/pull/44)\n";
    expect(parseBlockedBy(body, REPO)).toEqual({
      refs: [],
      crossRepo: [],
      unparsed: ["[pr](https://github.com/owner/repo/pull/44)"],
    });
  });
});
