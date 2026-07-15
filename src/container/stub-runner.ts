/**
 * The walking-skeleton in-container runner (ADR-0038, issue #184, epic #182). It stands in
 * for the real thin runner (slice 3, which hosts the SDK session, drives git/PR/escalate
 * directly, and captures the transcript). This stub does **no real work** — its only job is
 * to prove the in-container half of the `docker run` + pipe plumbing: read the dispatched
 * {@link Assignment}, emit a lifecycle telemetry frame and then a terminal result frame over
 * the {@link Transport}, and return (the process exits, closing its stdout).
 *
 * Because the stub hosts no SDK session, it has no real PR to report; its honest terminal is
 * `stuck` — "a runner ran, but produced no work product yet" — which is exactly the terminal
 * the daemon turns into recorded run state in the end-to-end skeleton. The terminal is
 * overridable so tests can exercise the other dispositions the codec carries.
 */
import type { Assignment } from "./assignment";
import type { ResultOutcome } from "./protocol";
import type { Transport } from "./transport";

/** Tunables for the stub's terminal disposition (defaults to the honest no-work `stuck`). */
export interface StubRunnerOptions {
  /** The terminal {@link ResultOutcome} to report (default `stuck` — the stub did no work). */
  outcome?: ResultOutcome;
}

/**
 * Run the stub: announce `started`, then report a terminal {@link ResultOutcome} whose detail
 * ties back to the dispatched {@link Assignment} (the round-trip proof that the assignment
 * reached the runner). The real runner replaces this body.
 */
export async function runStubRunner(
  transport: Transport,
  assignment: Assignment,
  options: StubRunnerOptions = {},
): Promise<void> {
  await transport.send({ kind: "telemetry", body: { type: "lifecycle", name: "started" } });
  const outcome = options.outcome ?? "stuck";
  await transport.send({
    kind: "result",
    outcome,
    detail: `stub runner: no SDK session yet (issue #${assignment.issueNumber})`,
  });
}
