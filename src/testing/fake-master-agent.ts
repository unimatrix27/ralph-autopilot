/**
 * Fakes for the master escalation ports (ADR-0041), in the grain of `fake-agent` /
 * `fake-review-agents`: the engine's decision logic is exercised end-to-end with no SDK, no
 * container, and no GitHub.
 *
 * {@link FakeMasterAgent} is scripted rather than canned on purpose — the acceptance criteria
 * turn on the master reaching a conclusion *different* from the worker's recommendation, so a
 * fake that always echoed the recommendation could not tell a real adjudication from a rubber
 * stamp. Each fake also records the {@link MasterSessionInput} it was handed, so tests can
 * assert what the master could actually see.
 */

import type { MasterAgentRunner, MasterPipelinePort, MasterSessionInput, MasterSessionOutcome } from "../master/engine";
import type { MasterSessionResult } from "../master/outcome";

/** A scripted master: each call shifts the next outcome off the queue. */
export class FakeMasterAgent implements MasterAgentRunner {
  /** Every session input the engine handed over, in order — the packet under test. */
  readonly sessions: MasterSessionInput[] = [];
  /** The scripted outcomes, consumed one per session. */
  private readonly script: MasterSessionOutcome[];

  constructor(script: Array<MasterSessionOutcome | MasterSessionResult> = []) {
    this.script = script.map((s) => ("kind" in s ? s : { kind: "outcome" as const, result: s }));
  }

  /** Queue another outcome (a second intervention in the same test). */
  push(outcome: MasterSessionOutcome | MasterSessionResult): void {
    this.script.push("kind" in outcome ? outcome : { kind: "outcome", result: outcome });
  }

  /** The prompt the most recent session was given. */
  get lastPrompt(): string {
    return this.sessions[this.sessions.length - 1]?.prompt ?? "";
  }

  async run(input: MasterSessionInput): Promise<MasterSessionOutcome> {
    this.sessions.push(input);
    const next = this.script.shift();
    if (!next) {
      throw new Error("FakeMasterAgent: no scripted outcome left for this session");
    }
    return next;
  }
}

/** Records the pipeline hand-backs a resolved master performs. */
export class FakeMasterPipeline implements MasterPipelinePort {
  readonly continued: Array<{
    issueNumber: number;
    resolution: string;
    brief: string;
    conclusion: string;
  }> = [];
  readonly retried: Array<{ issueNumber: number; action: string; brief: string }> = [];

  async continueRun(input: {
    run: { issueNumber: number };
    issue: unknown;
    resolution: string;
    brief: string;
    conclusion: string;
  }): Promise<void> {
    this.continued.push({
      issueNumber: input.run.issueNumber,
      resolution: input.resolution,
      brief: input.brief,
      conclusion: input.conclusion,
    });
  }

  async retry(input: {
    run: { issueNumber: number };
    issue: unknown;
    action: string;
    brief: string;
  }): Promise<void> {
    this.retried.push({ issueNumber: input.run.issueNumber, action: input.action, brief: input.brief });
  }
}
