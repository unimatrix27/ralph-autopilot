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
 * The files allowed to project `agent-stuck` unconditionally. `master/engine.ts` is the
 * master's own terminal (`MasterStuck`); `store/` owns the append primitives every caller must
 * go through; `testing/` seeds fixtures.
 *
 * The executor is deliberately **not** on this list any more. It used to be, on the claim that
 * its branches were "unreachable in production" — and that claim was false: the failure guard's
 * master enqueue swallowed its own errors and fell straight through, so a rate-limited
 * `getIssue` inside the master door terminalized a recoverable run with no adjudication at all
 * (issue #43). A prose claim of unreachability is exactly the kind of thing this suite exists
 * to distrust, so what survives is machine-checked instead: see
 * {@link NO_MASTER_FALLBACK_MARKER}.
 */
const STUCK_PROJECTION_ALLOWED = [
  "master/engine.ts",
  "store/store.ts",
  "store/events/decider.ts",
  "store/events/event-types.ts",
  "testing/seed-run.ts",
];

/** Call sites that project the terminal, as source-visible tokens. */
const STUCK_PROJECTIONS = ["recordRunStuck(", "recordRunStuckWithAnomaly(", "recordMasterStuck("];

/**
 * The one escape hatch left, and it is a *site* marker rather than a file allow-list: the
 * pre-cutover terminal the no-master unit fixtures still exercise. Production always wires
 * `masterEscalation` (`daemon/daemon.ts`), so these lines cannot run there — but that is now
 * pinned two ways rather than asserted: every marked site is counted below (a new one fails
 * this suite even if it is marked), and the behavioural half proves that a *wired* master
 * never reaches them, including when its own enqueue fails
 * (`executor/executor.test.ts` → "the executor failure guard reaches no terminal of its own").
 */
const NO_MASTER_FALLBACK_MARKER = "terminal-authority: no-master-fallback";

/**
 * The exact marked sites that may exist, by file. An equality check, not a budget: adding a
 * fallback anywhere — marked or not, in these files or new ones — fails until someone edits
 * this map and says why in the commit.
 */
const NO_MASTER_FALLBACK_SITES: Record<string, number> = {
  // `discardOrphan` (a swept orphan with no live PR) and `recordExecutorFailure` (a session
  // that threw), each reached only when `masterEscalation` is absent.
  "executor/executor.ts": 2,
  // `recordAgentStuck` / `recordFinishedWithoutPr`, called only from those same branches.
  "executor/stuck.ts": 2,
};

/** Whether the projection on `lines[at]` is directly under the no-master fallback marker. */
function isMarkedFallback(lines: string[], at: number): boolean {
  return (lines[at] ?? "").includes(NO_MASTER_FALLBACK_MARKER)
    || (lines[at - 1] ?? "").includes(NO_MASTER_FALLBACK_MARKER);
}

/** Every projection call site in a file, split into marked fallbacks and unmarked offenders. */
function projectionSites(text: string): { marked: number; unmarked: number } {
  const lines = text.split("\n");
  let marked = 0;
  let unmarked = 0;
  lines.forEach((line, at) => {
    if (!STUCK_PROJECTIONS.some((token) => line.includes(token))) {
      return;
    }
    if (isMarkedFallback(lines, at)) {
      marked += 1;
    } else {
      unmarked += 1;
    }
  });
  return { marked, unmarked };
}

describe("terminal authority (ADR-0042)", () => {
  const files = sourceFiles();

  it("scans a non-trivial source tree (guards against a silently-empty scan)", () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it("no worker, review loop, executor guard or reconciler path projects `agent-stuck` directly", () => {
    const offenders = files
      .filter((f) => !STUCK_PROJECTION_ALLOWED.includes(f.rel))
      .filter((f) => projectionSites(f.text).unmarked > 0)
      .map((f) => f.rel);
    expect(offenders, `these files project agent-stuck without a master adjudication: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("the no-master fallback exists at exactly the declared sites and nowhere else", () => {
    const found: Record<string, number> = {};
    for (const file of files.filter((f) => !STUCK_PROJECTION_ALLOWED.includes(f.rel))) {
      const { marked } = projectionSites(file.text);
      if (marked > 0) {
        found[file.rel] = marked;
      }
    }
    expect(found).toEqual(NO_MASTER_FALLBACK_SITES);
  });

  it("the marker is never used anywhere but on a real projection site", () => {
    // A marker that drifts off its call site (or is pasted somewhere decorative) would make
    // the counts above meaningless, so the total marker count must equal the marked-site count.
    const markers = files.reduce(
      (n, f) => n + f.text.split("\n").filter((l) => l.includes(NO_MASTER_FALLBACK_MARKER)).length,
      0,
    );
    const marked = Object.values(NO_MASTER_FALLBACK_SITES).reduce((a, b) => a + b, 0);
    expect(markers).toBe(marked);
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
   * and `MasterEngine.askHuman` is its only *originating* caller. Everything else that wants a
   * human must go through a master outcome.
   *
   * `daemon/rehydrate.ts` is the one other caller, and it originates nothing: it re-derives the
   * provenance of a question GitHub **already carries** so a cold-store restart routes the
   * answer back to the master that asked, rather than to the worker that could not decide. The
   * companion assertion below is what keeps that distinction real — rehydrate may re-index a
   * question, never post one.
   */
  it("only the master engine creates a `ralph-question` from a master adjudication", () => {
    const offenders = files
      .filter((f) => !["master/engine.ts", "store/store.ts", "daemon/rehydrate.ts"].includes(f.rel))
      .filter((f) => f.text.includes("recordMasterHumanQuestion("))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the rebuild re-indexes questions but never asks one", () => {
    const rehydrate = files.find((f) => f.rel === "daemon/rehydrate.ts")!;
    for (const token of ["formatRalphQuestion(", "postComment(", ...STUCK_PROJECTIONS]) {
      expect(rehydrate.text.includes(token), `rehydrate.ts still calls ${token}`).toBe(false);
    }
  });

  it("the heal-card surface is gone from production source", () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith("testing/"))
      .filter((f) => f.text.includes("buildHealCardQuestion") || f.text.includes("formatHealCard"))
      .map((f) => f.rel);
    expect(offenders, `heal-card builders resurfaced in: ${offenders.join(", ")}`).toEqual([]);
  });
});
