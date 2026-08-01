import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertRunnerSupports,
  CURRENT_RUNNER_CAPABILITIES,
  formatRunnerCapabilities,
  parseRunnerCapabilities,
  RUNNER_CAPABILITY_ENV,
  RUNNER_CAPABILITY_LABEL,
  RunnerCompatibilityError,
  type RunnerCapability,
  type RunnerCapabilityProbe,
} from "./capabilities";

const ROOT = join(__dirname, "..", "..");
const probeOf = (caps: string[]): RunnerCapabilityProbe => ({ capabilities: async () => caps });

/**
 * Each declared capability must be BACKED by the wiring the shipped runner entrypoint
 * (`src/bin/ralph-runner.ts`) constructs in its `runContainerRunner` deps literal — the session
 * host(s) that actually implement it. A Dockerfile-label ↔ constant string-compare is not enough:
 * `master-escalation` shipped declared-but-unwired because the entrypoint never built a master
 * session host, so the pre-dispatch gate passed and every master run reported a generic `failed`.
 * Typed `Record<RunnerCapability, …>`, so adding a capability to `RUNNER_CAPABILITIES` without an
 * entry here fails to compile — the wiring contract cannot silently lapse for a new capability.
 */
const CAPABILITY_WIRING: Record<RunnerCapability, readonly string[]> = {
  impl: ["session: createImplSessionHost"],
  "review-fix": ["reviewSession: createReviewSessionHost", "fixSession: createFixSessionHost"],
  "runner-direct-escalate": ["escalation: createRunnerEscalation"],
  "master-escalation": ["masterSession: createMasterSessionHost"],
};

describe("runner capability contract (ADR-0041)", () => {
  it("round-trips a declaration through the label format", () => {
    const raw = formatRunnerCapabilities(CURRENT_RUNNER_CAPABILITIES);
    expect(parseRunnerCapabilities(raw)).toEqual([...CURRENT_RUNNER_CAPABILITIES]);
    expect(parseRunnerCapabilities(" impl , master-escalation ")).toEqual(["impl", "master-escalation"]);
  });

  it("treats an ABSENT declaration as no capabilities, never as all of them", () => {
    expect(parseRunnerCapabilities(undefined)).toEqual([]);
    expect(parseRunnerCapabilities(null)).toEqual([]);
    expect(parseRunnerCapabilities("")).toEqual([]);
  });

  it("admits a dispatch an image declares support for", async () => {
    await expect(
      assertRunnerSupports(probeOf(["impl", "master-escalation"]), "acme/agent:1", ["master-escalation"]),
    ).resolves.toBeUndefined();
  });

  it("fails PRE-DISPATCH with a precise compatibility error on a stale runner", async () => {
    const error = await assertRunnerSupports(probeOf(["impl", "review-fix"]), "acme/agent:1", [
      "master-escalation",
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunnerCompatibilityError);
    const message = (error as Error).message;
    // It names the image, the missing capability, what the image DOES declare, and the fix —
    // never a generic "no result" that reads as an agent failure.
    expect(message).toContain("acme/agent:1");
    expect(message).toContain("master-escalation");
    expect(message).toContain("impl, review-fix");
    expect(message).toContain("container-image-refresh.md");
    expect(message).toContain(RUNNER_CAPABILITY_LABEL);
  });

  it("names EVERY missing capability, not just the first", async () => {
    const error = (await assertRunnerSupports(probeOf([]), "acme/agent:1", [
      "impl",
      "master-escalation",
    ]).catch((e: unknown) => e)) as RunnerCompatibilityError;
    expect(error.missing).toEqual(["impl", "master-escalation"]);
    expect(error.message).toContain("(nothing)");
  });

  it("is a no-op with no probe (in-process / test wirings have no image to interrogate)", async () => {
    await expect(assertRunnerSupports(undefined, "acme/agent:1", ["master-escalation"])).resolves.toBeUndefined();
  });

  it("the shipped agent-base image declares exactly the capabilities this build implements", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile.agent-base"), "utf8");
    const declared = formatRunnerCapabilities(CURRENT_RUNNER_CAPABILITIES);
    expect(dockerfile).toContain(`LABEL ${RUNNER_CAPABILITY_LABEL}="${declared}"`);
    expect(dockerfile).toContain(`ENV ${RUNNER_CAPABILITY_ENV}="${declared}"`);
  });

  it("every declared capability is actually wired by the shipped runner entrypoint", () => {
    // The label-vs-constant check above proves the IMAGE declares the capability; this proves the
    // ENTRYPOINT hosts it. Both must hold, or a capability the pre-dispatch gate green-lights is
    // dead-on-arrival at runtime — precisely how `master-escalation` shipped declared-but-unwired.
    const entrypoint = readFileSync(join(ROOT, "src", "bin", "ralph-runner.ts"), "utf8");
    for (const cap of CURRENT_RUNNER_CAPABILITIES) {
      for (const token of CAPABILITY_WIRING[cap]) {
        expect(
          entrypoint,
          `capability '${cap}' is declared but its wiring '${token}' is missing from src/bin/ralph-runner.ts`,
        ).toContain(token);
      }
    }
  });

  it("the onboarding smoke test gates on the capability label", () => {
    const smoke = readFileSync(join(ROOT, "ops", "smoke-test-agent-image.sh"), "utf8");
    expect(smoke).toContain(RUNNER_CAPABILITY_LABEL);
    expect(smoke).toContain("master-escalation");
  });
});
