import { describe, expect, it } from "vitest";
import { parseBlockedBy } from "./blocked";

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
    expect(parseBlockedBy(body)).toEqual([1, 23]);
  });

  it("is case-insensitive on the heading and tolerates extra hashes", () => {
    const body = "### blocked BY\n- #5\n";
    expect(parseBlockedBy(body)).toEqual([5]);
  });

  it("handles bare and gh-style references on one line", () => {
    const body = "## Blocked by\n- depends on #4 and #6\n- #4\n";
    expect(parseBlockedBy(body)).toEqual([4, 6]);
  });

  it("returns empty when there is no Blocked by section", () => {
    expect(parseBlockedBy("## What to build\n- #1\n")).toEqual([]);
    expect(parseBlockedBy("")).toEqual([]);
  });

  it("stops at the next heading", () => {
    const body = "## Blocked by\n- #1\n## Notes\n- #2\n";
    expect(parseBlockedBy(body)).toEqual([1]);
  });
});
