/**
 * The load-bearing invariant of the triage cutover (ADR-0042): **only a completed master
 * adjudication may project `agent-stuck`, and only the master may ask a human.**
 *
 * These are enforced by *source scan* rather than by behaviour alone, deliberately. A
 * behavioural test proves that the paths we thought of do the right thing; a source scan proves
 * that a path nobody thought of cannot be added quietly. The whole value of "the master
 * adjudicates first" is that it is not advisory — if any worker, review loop, executor guard or
 * reconciler branch could still reach a human or a terminal, the guarantee would be a
 * convention, and conventions decay.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

/** Every non-test `.ts` file under `src/`, as `{ path, text }`. */
function sourceFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      out.push({ rel: relative(srcRoot, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(srcRoot);
  return out;
}

/**
 * The files allowed to project `agent-stuck`. `master/engine.ts` is the master's own terminal
 * (`MasterStuck`); `store/` owns the append primitives every caller must go through; `testing/`
 * seeds fixtures. `executor/stuck.ts` retains `recordAgentStuck` for the no-master fallback the
 * legacy fixtures exercise — but nothing in the live daemon reaches it, which the behavioural
 * half of this suite (`hitl.test.ts`, `review-loop.test.ts`) covers.
 */
const STUCK_PROJECTION_ALLOWED = [
  "master/engine.ts",
  "executor/stuck.ts",
  // The no-master fallback the legacy unit fixtures exercise; the live daemon always wires
  // `masterEscalation`, so these branches are unreachable in production (covered behaviourally
  // by `daemon/hitl.test.ts` and `review/review-loop.test.ts`).
  "executor/executor.ts",
  "store/store.ts",
  "store/events/decider.ts",
  "store/events/event-types.ts",
  "testing/seed-run.ts",
];

/** Call sites that project the terminal, as source-visible tokens. */
const STUCK_PROJECTIONS = ["recordRunStuck(", "recordRunStuckWithAnomaly(", "recordMasterStuck("];

describe("terminal authority (ADR-0042)", () => {
  const files = sourceFiles();

  it("scans a non-trivial source tree (guards against a silently-empty scan)", () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it("no worker, review loop, executor guard or reconciler path projects `agent-stuck` directly", () => {
    const offenders = files
      .filter((f) => !STUCK_PROJECTION_ALLOWED.includes(f.rel))
      .filter((f) => STUCK_PROJECTIONS.some((token) => f.text.includes(token)))
      .map((f) => f.rel);
    expect(offenders, `these files project agent-stuck without a master adjudication: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("the review loop reaches no terminal of its own — it escalates", () => {
    const reviewLoop = files.find((f) => f.rel === "review/review-loop.ts")!;
    for (const token of [...STUCK_PROJECTIONS, "recordReviewMaxedQuestion(", "addQuestion("]) {
      expect(reviewLoop.text.includes(token), `review-loop.ts still calls ${token}`).toBe(false);
    }
  });

  it("the reconciler reaches no terminal of its own", () => {
    const reconciler = files.find((f) => f.rel === "daemon/reconciler.ts")!;
    for (const token of STUCK_PROJECTIONS) {
      expect(reconciler.text.includes(token), `reconciler.ts still calls ${token}`).toBe(false);
    }
  });

  /**
   * `recordMasterHumanQuestion` is the only writer of an open question with master provenance,
   * and `MasterEngine.askHuman` is its only caller. Everything else that wants a human must go
   * through a master outcome.
   */
  it("only the master engine creates a `ralph-question` from a master adjudication", () => {
    const offenders = files
      .filter((f) => !["master/engine.ts", "store/store.ts"].includes(f.rel))
      .filter((f) => f.text.includes("recordMasterHumanQuestion("))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the heal-card surface is gone from production source", () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith("testing/"))
      .filter((f) => f.text.includes("buildHealCardQuestion") || f.text.includes("formatHealCard"))
      .map((f) => f.rel);
    expect(offenders, `heal-card builders resurfaced in: ${offenders.join(", ")}`).toEqual([]);
  });
});
