/**
 * Tests for the runId → AbortController registry (issue #118). The registry is the
 * single home for the per-run session-kill handle: the executor registers each live
 * session's controller (keyed by run id), and the orchestrator's kill-run aborts one
 * by run id — so the web control plane can tear down a specific in-flight run without
 * reaching executor internals, and killing one run never touches another.
 */
import { describe, expect, it } from "vitest";
import { RunAbortRegistry } from "./run-abort-registry";

describe("RunAbortRegistry", () => {
  it("aborts a registered run's controller and reports it was live", () => {
    const registry = new RunAbortRegistry();
    const controller = new AbortController();
    registry.register(7, controller);

    expect(registry.has(7)).toBe(true);
    expect(controller.signal.aborted).toBe(false);

    expect(registry.abort(7)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports a run as not live once its session settled (unregistered)", () => {
    const registry = new RunAbortRegistry();
    const controller = new AbortController();
    const release = registry.register(7, controller);
    release();

    expect(registry.has(7)).toBe(false);
    // Aborting a settled run raced its own exit — fine, no live session to kill.
    expect(registry.abort(7)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts only the targeted run; other runs' controllers stay intact (isolation)", () => {
    const registry = new RunAbortRegistry();
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    registry.register(1, a);
    registry.register(2, b);
    registry.register(3, c);

    expect(registry.abort(2)).toBe(true);

    expect(b.signal.aborted).toBe(true);
    // The siblings are untouched — kill-run never affects other in-flight runs.
    expect(a.signal.aborted).toBe(false);
    expect(c.signal.aborted).toBe(false);
    expect(registry.has(1)).toBe(true);
    expect(registry.has(3)).toBe(true);
  });

  it("returns false for an unknown run id (never registered)", () => {
    const registry = new RunAbortRegistry();
    expect(registry.abort(999)).toBe(false);
    expect(registry.has(999)).toBe(false);
  });

  it("re-registration replaces a stale entry for the same run id", () => {
    const registry = new RunAbortRegistry();
    const first = new AbortController();
    const releaseFirst = registry.register(5, first);
    const second = new AbortController();
    const releaseSecond = registry.register(5, second);

    releaseFirst();
    expect(registry.has(5)).toBe(true);

    // Aborting hits the latest controller, not a stale one.
    expect(registry.abort(5)).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);

    releaseSecond();
    expect(registry.has(5)).toBe(false);
  });
});
