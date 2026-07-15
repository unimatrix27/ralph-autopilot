/**
 * Guards the **shipped `.ralph/` image definitions** (issue #191): this repo's own contract and
 * the onboarding templates. The images themselves are infra — their acceptance test is the
 * onboarding smoke-test (`ops/smoke-test-agent-image.sh`), not the unit suite ("no real
 * images/containers in CI", ADR-0038). But the *contract* is pure and testable, so this asserts
 * the cheap, drift-catching invariants:
 *
 *   - every shipped `agent.yaml` validates against the strict {@link agentContractSchema} (a typo
 *     or a stale field fails the build here, not at onboarding);
 *   - every paired `agent.Dockerfile` builds `FROM ralph/agent-base` (AC3 / option-a ralph-base-up).
 *
 * Mirrors `config.test.ts`'s discipline over the daemon config, applied to the target contract.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgentContract } from "./agent-contract";

const ROOT = join(__dirname, "..", "..");

/** The image definitions #191 ships: this repo's own (`.ralph/`) + the two onboarding templates. */
const DEFINITIONS = [
  { label: "this repo (.ralph)", dir: ".ralph" },
  { label: "node template", dir: "templates/onboard/node" },
  { label: "dotnet-angular template", dir: "templates/onboard/dotnet-angular" },
] as const;

describe("shipped .ralph/ image definitions (#191)", () => {
  for (const { label, dir } of DEFINITIONS) {
    describe(label, () => {
      it("agent.yaml validates against the strict contract schema", () => {
        const contract = loadAgentContract(join(ROOT, dir, "agent.yaml"));
        expect(contract.build).not.toHaveLength(0);
        expect(contract.test).not.toHaveLength(0);
        expect(contract.restore).not.toHaveLength(0);
        expect(contract.depManifests.length).toBeGreaterThan(0);
        expect(contract.baseBranch).not.toHaveLength(0);
      });

      it("agent.Dockerfile builds FROM ralph/agent-base (ralph-base-up)", () => {
        const dockerfile = readFileSync(join(ROOT, dir, "agent.Dockerfile"), "utf8");
        // The first instruction (ignoring comments/blanks) must be `FROM ralph/agent-base...`.
        const firstInstruction = dockerfile
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith("#"));
        expect(firstInstruction).toMatch(/^FROM\s+ralph\/agent-base(:\S+)?$/);
      });
    });
  }
});
