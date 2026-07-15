/**
 * The auto-mode moding pass, driven through the reconciler (CONTEXT: moding pass).
 * Asserts the end-to-end behaviour with the fakes: a qualifying unmoded issue is
 * labelled with the classifier's mode and becomes gate-eligible next tick; the pass
 * is idempotent, bounded by `maxPerTick`, opt-in (a no-op when disabled), and never
 * crashes or surfaces an anomaly when the classifier cannot decide.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { Executor } from "../executor/executor";
import { PrOpeningAgentRunner } from "../testing/fake-agent";
import { FakeGitHub } from "../testing/fake-github";
import { FakeModeClassifier, ControlledModeClassifier } from "../testing/fake-mode-classifier";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import type { AutoModeSettings } from "../config/schema";
import type { ModeClassifier } from "../core/moding";
import { LABEL_MODE_INFRA, LABEL_MODE_TDD } from "../core/labels";
import { Reconciler, type ReconcileBudget } from "./reconciler";

const silent = createLogger({ write: () => {} });

function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return {
    available: () => Math.max(0, cap - getActive()),
    hasCapacity: () => getActive() < cap,
  };
}

function wire(opts: {
  github: FakeGitHub;
  store: Store;
  classifier?: ModeClassifier;
  autoMode?: Partial<AutoModeSettings>;
}) {
  const worktrees = new FakeWorktreeManager();
  const executor = new Executor({
    store: opts.store,
    github: opts.github,
    worktrees,
    agentRunner: new PrOpeningAgentRunner(opts.github),
    logger: silent,
  });
  const cap = 5;
  let reconciler: Reconciler;
  reconciler = new Reconciler({
    store: opts.store,
    github: opts.github,
    executor,
    worktrees,
    logger: silent,
    budget: budgetFor(() => reconciler.activeCount(), cap),
    cap,
    priorityLabels: [],
    targetRepo: "owner/repo",
    reconcileIntervalSeconds: 30,
    autoMode: opts.autoMode
      ? { enabled: true, maxPerTick: 3, ...opts.autoMode }
      : { enabled: false, maxPerTick: 3 },
    modeClassifier: opts.classifier,
  });
  return { reconciler };
}

/** Seed an unmoded but otherwise-ready issue (the moding gap). */
function seedUnmoded(github: FakeGitHub, number: number, title = `Issue ${number}`): void {
  github.seed({ number, title, labels: ["ready-for-agent", "afk"] });
}

describe("auto-mode moding pass", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("labels a qualifying unmoded issue with the classifier's mode and logs it", async () => {
    seedUnmoded(github, 1);
    const classifier = new FakeModeClassifier().decide(1, { mode: "infra", reason: "docs only" });
    const { reconciler } = wire({ github, store, classifier, autoMode: {} });

    await reconciler.tick();
    await reconciler.awaitModing();

    expect((await github.getIssue(1))!.labels).toContain(LABEL_MODE_INFRA);
    expect(github.addedLabels).toContainEqual({ issue: 1, label: LABEL_MODE_INFRA });
    expect(store.recentLog().some((l) => l.event === "auto-moded")).toBe(true);
  });

  it("makes the moded issue gate-eligible: the next tick picks it up and opens a PR", async () => {
    seedUnmoded(github, 7, "Core loop");
    const classifier = new FakeModeClassifier().decide(7, { mode: "tdd", reason: "ships code" });
    const { reconciler } = wire({ github, store, classifier, autoMode: {} });

    await reconciler.tick(); // mode the issue
    await reconciler.awaitModing();
    expect((await github.getIssue(7))!.labels).toContain(LABEL_MODE_TDD);

    await reconciler.tick(); // now eligible → picked up
    await reconciler.awaitInFlight();

    const pr = await github.findPullRequestForBranch("ralph/7-core-loop");
    expect(pr).not.toBeNull();
    expect(store.getRunByIssue(7)?.prNumber).toBe(pr!.number);
  });

  it("is idempotent: an already-moded issue is never re-classified", async () => {
    github.seed({ number: 2, labels: ["ready-for-agent", "afk", "mode:tdd"] });
    const classifier = new FakeModeClassifier();
    const { reconciler } = wire({ github, store, classifier, autoMode: {} });

    await reconciler.tick();
    await reconciler.awaitModing();

    expect(classifier.classified).toEqual([]);
    expect(github.addedLabels.filter((l) => l.label.startsWith("mode:"))).toEqual([]);
  });

  it("classifies at most maxPerTick issues per tick; the rest wait", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      seedUnmoded(github, n);
    }
    const classifier = new FakeModeClassifier();
    const { reconciler } = wire({ github, store, classifier, autoMode: { maxPerTick: 2 } });

    await reconciler.tick();
    await reconciler.awaitModing();

    expect(classifier.classified).toHaveLength(2);
  });

  it("opt-in: when disabled it makes no classification and no label write (exact no-op)", async () => {
    seedUnmoded(github, 1);
    const classifier = new FakeModeClassifier();
    const { reconciler } = wire({ github, store, classifier /* autoMode omitted → disabled */ });

    await reconciler.tick();
    await reconciler.awaitModing();

    expect(classifier.classified).toEqual([]);
    expect(github.addedLabels).toEqual([]);
  });

  it("leaves an issue unmoded when the classifier cannot decide — no label, no anomaly", async () => {
    seedUnmoded(github, 1);
    const classifier = new FakeModeClassifier().decide(1, null); // undecided
    const { reconciler } = wire({ github, store, classifier, autoMode: {} });

    await reconciler.tick();
    await reconciler.awaitModing();

    const issue = (await github.getIssue(1))!;
    expect(issue.labels.some((l) => l.startsWith("mode:"))).toBe(false);
    expect(issue.labels).not.toContain("daemon-anomaly");
  });

  it("bounds CONCURRENT classifications to maxPerTick across ticks (a slow session holds its slot)", async () => {
    for (const n of [1, 2, 3]) {
      seedUnmoded(github, n);
    }
    const classifier = new ControlledModeClassifier();
    const { reconciler } = wire({ github, store, classifier, autoMode: { maxPerTick: 2 } });

    await reconciler.tick();
    await reconciler.awaitModingLaunched();
    expect(classifier.concurrent).toBe(2); // two slots filled, one issue still waiting

    // A second tick must not exceed the cap while the first two are in flight.
    await reconciler.tick();
    await reconciler.awaitModingLaunched();
    expect(classifier.peak).toBe(2);

    // Settle one → a slot frees → the third issue can be classified next tick. Flush
    // the completed classification's label-application + slot-release before ticking.
    classifier.complete(1, { mode: "tdd", reason: "ok" });
    await new Promise((r) => setTimeout(r, 0));
    await reconciler.tick();
    await reconciler.awaitModingLaunched();
    expect(classifier.started).toContain(3);
  });
});
