/**
 * Scriptable {@link ReviewAgentRunner} / {@link FixAgentRunner} doubles. A real
 * SDK review/fix session needs OAuth and would call out, so tests drive the
 * orchestration with these: each is handed a queue of scripted responses and
 * records the contexts it was called with so a test can assert what the loop fed
 * it (e.g. that PR comments were ingested, that phase 2 ran behaviour-preserving).
 */

import type {
  FixAgentRunner,
  FixContext,
  FixOutcome,
  ReviewAgentRunner,
  ReviewContext,
} from "../review/agents";
import type { Worklist } from "../review/worklist";

/** A review runner that returns scripted worklists in order, recording each call. */
export class ScriptedReviewAgent implements ReviewAgentRunner {
  readonly calls: ReviewContext[] = [];
  private readonly queue: Worklist[];

  /** Worklists returned one per call; the last is repeated once the queue drains. */
  constructor(worklists: Worklist[]) {
    if (worklists.length === 0) {
      throw new Error("ScriptedReviewAgent needs at least one worklist");
    }
    this.queue = [...worklists];
  }

  async review(ctx: ReviewContext): Promise<Worklist> {
    this.calls.push(ctx);
    return this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
  }
}

/** A fix runner that returns scripted outcomes in order, recording each call. */
export class ScriptedFixAgent implements FixAgentRunner {
  readonly calls: FixContext[] = [];
  private readonly queue: FixOutcome[];
  private readonly fallback: FixOutcome;

  /** Outcomes returned one per call; once drained, every further call returns `fixed`. */
  constructor(outcomes: FixOutcome[] = [], fallback: FixOutcome = { kind: "fixed" }) {
    this.queue = [...outcomes];
    this.fallback = fallback;
  }

  async fix(ctx: FixContext): Promise<FixOutcome> {
    this.calls.push(ctx);
    return this.queue.length > 0 ? this.queue.shift()! : this.fallback;
  }
}
