/**
 * Test {@link ModeClassifier} doubles for the auto-mode moding pass. A real
 * classifier is an Agent SDK session (OAuth, calls out), so these stand in: one maps
 * issue numbers to scripted verdicts, with a default and the ability to model the
 * "could not decide" (`null`) and controlled-timing cases.
 */

import type { ModeClassifier, ModeContext, ModeDecision } from "../core/moding";

/**
 * A classifier returning scripted verdicts per issue number, recording every call.
 * Unmapped issues fall back to `defaultDecision` (a `tdd` verdict unless overridden);
 * map an issue to `null` to model the classifier being unable to decide.
 */
export class FakeModeClassifier implements ModeClassifier {
  /** Issue numbers classified, in call order. */
  readonly classified: number[] = [];
  private readonly scripted = new Map<number, ModeDecision | null>();

  constructor(private readonly defaultDecision: ModeDecision = { mode: "tdd", reason: "default" }) {}

  /** Script the verdict (or `null` = undecided) returned for an issue. */
  decide(issueNumber: number, decision: ModeDecision | null): this {
    this.scripted.set(issueNumber, decision);
    return this;
  }

  async classify(ctx: ModeContext): Promise<ModeDecision | null> {
    this.classified.push(ctx.issue.number);
    return this.scripted.has(ctx.issue.number)
      ? this.scripted.get(ctx.issue.number)!
      : this.defaultDecision;
  }
}

/**
 * A classifier whose every call blocks until the test settles it — for asserting the
 * `maxPerTick` concurrency bound and that a session spanning ticks holds its slot.
 */
export class ControlledModeClassifier implements ModeClassifier {
  readonly started: number[] = [];
  concurrent = 0;
  peak = 0;
  private readonly settlers = new Map<number, (decision: ModeDecision | null) => void>();

  classify(ctx: ModeContext): Promise<ModeDecision | null> {
    const issueNumber = ctx.issue.number;
    this.started.push(issueNumber);
    this.concurrent += 1;
    this.peak = Math.max(this.peak, this.concurrent);
    return new Promise<ModeDecision | null>((resolve) => {
      this.settlers.set(issueNumber, resolve);
    }).finally(() => {
      this.concurrent -= 1;
      this.settlers.delete(issueNumber);
    });
  }

  /** Settle the in-flight classification for `issueNumber` with a verdict (or `null`). */
  complete(issueNumber: number, decision: ModeDecision | null = { mode: "tdd", reason: "ok" }): void {
    const settle = this.settlers.get(issueNumber);
    if (!settle) {
      throw new Error(`no in-flight classification for #${issueNumber}`);
    }
    settle(decision);
  }
}
