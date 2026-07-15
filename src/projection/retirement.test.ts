import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This test lives in src/projection/, so two levels up is the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/**
 * Issue #120 retires the Ink TUI now that the web control plane covers the
 * operator's read + live + run-reading needs. The contract (ADR-0029): keep the
 * pure projection `projection/snapshot.ts` the web read API reuses, and remove only the
 * Ink rendering + the `ralph-monitor` entry point + its now-unused dependencies.
 */
describe("Ink TUI retirement (issue #120)", () => {
  it("retains projection/snapshot.ts — the pure projection the web read API consumes", async () => {
    expect(existsSync(join(here, "snapshot.ts"))).toBe(true);
    const snapshot = await import("./snapshot");
    expect(typeof snapshot.buildSnapshot).toBe("function");
  });

  it.each([
    ["the Ink dashboard renderer", join("src", "tui", "dashboard.ts")],
    ["the Ink dashboard tests", join("src", "tui", "dashboard.test.ts")],
    ["the alternate-screen control", join("src", "tui", "screen.ts")],
    ["the alternate-screen tests", join("src", "tui", "screen.test.ts")],
    ["the Ink formatting helpers", join("src", "tui", "format.ts")],
    ["the Ink formatting tests", join("src", "tui", "format.test.ts")],
    ["the ralph-monitor entry point", join("src", "bin", "ralph-monitor.ts")],
  ])("removes %s", (_label, rel) => {
    expect(existsSync(join(repoRoot, rel)), rel).toBe(false);
  });

  it("drops the Ink dependency cluster and the ralph-monitor bin/script from package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    // Ink and the React runtime it rendered against were the TUI's only daemon-side
    // consumers; both are now unused (the web SPA carries its own React).
    expect(pkg.dependencies).not.toHaveProperty("ink");
    expect(pkg.dependencies).not.toHaveProperty("react");
    expect(pkg.devDependencies).not.toHaveProperty("ink-testing-library");
    expect(pkg.devDependencies).not.toHaveProperty("@types/react");
    // The bin + npm-script entry points are gone.
    expect(pkg.bin).not.toHaveProperty("ralph-monitor");
    expect(pkg.scripts).not.toHaveProperty("ralph-monitor");
  });

  it("keeps the daemon's other bin entry points and scripts (retirement is scoped)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    expect(pkg.bin?.["ralph-daemon"]).toBeTruthy();
    expect(pkg.bin?.["ralph-answer"]).toBeTruthy();
    expect(pkg.scripts?.["ralph-daemon"]).toBeTruthy();
  });
});
