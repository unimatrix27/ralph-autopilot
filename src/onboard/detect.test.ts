import { describe, expect, it } from "vitest";
import { detectToolchain, type RepoFacts } from "./detect";

/** A {@link RepoFacts} fake backed by an explicit set of present paths + glob patterns. */
function facts(opts: { paths?: string[]; globs?: string[] } = {}): RepoFacts {
  const paths = new Set(opts.paths ?? []);
  const globs = new Set(opts.globs ?? []);
  return {
    hasPath: (p) => paths.has(p),
    hasMatch: (g) => globs.has(g),
  };
}

describe("detectToolchain", () => {
  it("detects a Node repo from a root package.json", () => {
    const d = detectToolchain(facts({ paths: ["package.json"] }));
    expect(d.chosen).toBe("node");
    expect(d.reason).toContain("Node");
  });

  it("detects a .NET repo from global.json", () => {
    const d = detectToolchain(facts({ paths: ["global.json"] }));
    expect(d.chosen).toBe("dotnet-angular");
  });

  it("detects a .NET repo from a *.csproj anywhere", () => {
    const d = detectToolchain(facts({ globs: ["**/*.csproj"] }));
    expect(d.chosen).toBe("dotnet-angular");
  });

  it("detects a .NET repo from a *.sln", () => {
    const d = detectToolchain(facts({ globs: ["**/*.sln"] }));
    expect(d.chosen).toBe("dotnet-angular");
  });

  it("prefers dotnet-angular over node when a repo carries both (priority order)", () => {
    const d = detectToolchain(facts({ paths: ["package.json", "global.json"] }));
    expect(d.chosen).toBe("dotnet-angular");
  });

  it("returns no match with an actionable reason for an unrecognized repo", () => {
    const d = detectToolchain(facts({ paths: ["Cargo.toml"] }));
    expect(d.chosen).toBeNull();
    expect(d.reason).toContain("--template");
    expect(d.reason).toContain("templates/onboard");
  });

  it("always reports evidence for every template, in priority order", () => {
    const d = detectToolchain(facts({ paths: ["package.json"] }));
    expect(d.matches.map((m) => m.template)).toEqual(["dotnet-angular", "node"]);
    for (const m of d.matches) {
      expect(m.signals.length).toBeGreaterThan(0);
    }
    expect(d.matches.find((m) => m.template === "node")?.matched).toBe(true);
    expect(d.matches.find((m) => m.template === "dotnet-angular")?.matched).toBe(false);
  });
});
