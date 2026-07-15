import { describe, expect, it } from "vitest";
import { buildLaunchMarker, parseLaunchMarker } from "./marker";

describe("ralph-launch marker", () => {
  it("round-trips issue and branch through build/parse", () => {
    const marker = buildLaunchMarker({ issueNumber: 2, branch: "ralph/2-core-loop" });
    expect(marker).toContain("ralph-launch");
    const parsed = parseLaunchMarker(`Closes #2\n\n${marker}\n`);
    expect(parsed).toEqual({ issueNumber: 2, branch: "ralph/2-core-loop" });
  });

  it("is an HTML comment so it renders invisibly in a PR body", () => {
    const marker = buildLaunchMarker({ issueNumber: 7, branch: "ralph/7-x" });
    expect(marker.startsWith("<!--")).toBe(true);
    expect(marker.endsWith("-->")).toBe(true);
  });

  it("returns null when no marker is present", () => {
    expect(parseLaunchMarker("just a normal PR body")).toBeNull();
  });

  it("accepts the real ralph/<n>-<slug> branch shape", () => {
    const parsed = parseLaunchMarker(
      "<!-- ralph-launch: issue=#15 branch=ralph/15-structural-cleanup-dedup-comment-codec-type-phase -->",
    );
    expect(parsed).toEqual({
      issueNumber: 15,
      branch: "ralph/15-structural-cleanup-dedup-comment-codec-type-phase",
    });
  });

  it("rejects a marker whose branch token is not a ralph/<n>-<slug> branch", () => {
    // A malformed branch token (no ralph/ prefix, non-numeric issue id, a bare
    // ref, or no slug after the dash) must not be accepted as a launch.
    for (const branch of ["main", "ralph/abc-foo", "feature/x", "ralph/15", "not-a-branch"]) {
      const body = `<!-- ralph-launch: issue=#15 branch=${branch} -->`;
      expect(parseLaunchMarker(body)).toBeNull();
    }
  });
});
