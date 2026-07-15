import { describe, expect, it } from "vitest";
import { branchName, slugify, worktreeDirName } from "./slug";

describe("slugify", () => {
  it("lowercases, hyphenates, and strips punctuation", () => {
    expect(slugify("Core loop: eligibility gate → worktree")).toBe(
      "core-loop-eligibility-gate-worktree",
    );
  });

  it("collapses runs and trims leading/trailing hyphens", () => {
    expect(slugify("  --Hello,  World!!  --")).toBe("hello-world");
  });

  it("caps length without leaving a trailing hyphen", () => {
    const long = "word ".repeat(40);
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to 'issue' for an empty result", () => {
    expect(slugify("!!!")).toBe("issue");
    expect(slugify("")).toBe("issue");
  });
});

describe("branchName / worktreeDirName", () => {
  it("builds the ralph/<n>-<slug> branch", () => {
    expect(branchName(2, "Core loop")).toBe("ralph/2-core-loop");
  });

  it("builds a flat, slash-free worktree directory name", () => {
    expect(worktreeDirName(2, "Core loop")).toBe("2-core-loop");
  });
});
