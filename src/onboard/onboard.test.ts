import { describe, expect, it } from "vitest";
import { onboard, type OnboardDeps, type SmokeResult } from "./onboard";
import type { RepoFacts, TemplateId } from "./detect";
import type { ScaffoldFile, TemplateFiles } from "./scaffold";

const NODE_FACTS: RepoFacts = { hasPath: (p) => p === "package.json", hasMatch: () => false };
const UNKNOWN_FACTS: RepoFacts = { hasPath: () => false, hasMatch: () => false };

const TEMPLATE: TemplateFiles = {
  agentYaml: "build: npm run build\ntest: npm test\nrestore: npm ci\nbaseBranch: main\n",
  agentDockerfile: "FROM ralph/agent-base:latest\n",
  dockerignore: ".git\n",
};

/** A recording {@link OnboardDeps} fake with overridable behaviour per test. */
function fakeDeps(overrides: Partial<OnboardDeps> & { facts?: RepoFacts; smoke?: SmokeResult } = {}) {
  const written: ScaffoldFile[] = [];
  const deps: OnboardDeps = {
    gatherFacts: () => overrides.facts ?? NODE_FACTS,
    readTemplate: (_t: TemplateId) => TEMPLATE,
    detectBaseBranch: () => undefined,
    destExists: () => false,
    writeFile: (f) => void written.push(f),
    runSmokeTest: async () => overrides.smoke ?? { ok: true, output: "" },
    ...overrides,
  };
  return { deps, written };
}

describe("onboard", () => {
  it("detects → scaffolds → passes the smoke gate", async () => {
    const { deps, written } = fakeDeps();
    const result = await onboard(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template).toBe("node");
      expect(result.smokeRan).toBe(true);
      expect(result.scaffolded).toEqual([".ralph/agent.yaml", ".ralph/agent.Dockerfile", ".dockerignore"]);
    }
    expect(written.map((f) => f.path)).toHaveLength(3);
  });

  it("blocks at detect with an actionable message when no toolchain matches", async () => {
    const { deps, written } = fakeDeps({ facts: UNKNOWN_FACTS });
    const result = await onboard(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("detect");
      expect(result.message).toContain("--template");
    }
    expect(written).toHaveLength(0);
  });

  it("honours a forced template without detecting", async () => {
    const { deps } = fakeDeps({ facts: UNKNOWN_FACTS });
    const result = await onboard(deps, { template: "dotnet-angular" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template).toBe("dotnet-angular");
      expect(result.detection).toBeNull();
    }
  });

  it("refuses to clobber an existing contract unless forced", async () => {
    const { deps, written } = fakeDeps({ destExists: (p) => p === ".ralph/agent.yaml" });
    const result = await onboard(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("scaffold");
      expect(result.message).toContain("--force");
    }
    expect(written).toHaveLength(0);
  });

  it("overwrites an existing contract with force", async () => {
    const { deps, written } = fakeDeps({ destExists: () => true });
    const result = await onboard(deps, { force: true });
    expect(result.ok).toBe(true);
    expect(written).toHaveLength(3);
  });

  it("blocks at smoke but leaves the committable contract on disk", async () => {
    const { deps, written } = fakeDeps({ smoke: { ok: false, output: "dotnet: not found" } });
    const result = await onboard(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("smoke");
      expect(result.message).toContain("dotnet: not found");
      expect(result.message).toContain("blocked");
    }
    // The .ralph/ was written before the gate ran, so it is committable/editable.
    expect(written.map((f) => f.path)).toEqual([
      ".ralph/agent.yaml",
      ".ralph/agent.Dockerfile",
      ".dockerignore",
    ]);
  });

  it("scaffolds without running the gate when skipSmoke is set", async () => {
    let smokeCalled = false;
    const { deps, written } = fakeDeps({
      runSmokeTest: async () => {
        smokeCalled = true;
        return { ok: true, output: "" };
      },
    });
    const result = await onboard(deps, { skipSmoke: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.smokeRan).toBe(false);
    expect(smokeCalled).toBe(false);
    expect(written).toHaveLength(3);
  });

  it("substitutes the detected base branch into agent.yaml", async () => {
    const { deps, written } = fakeDeps({ detectBaseBranch: () => "master" });
    await onboard(deps);
    const yaml = written.find((f) => f.path === ".ralph/agent.yaml")!;
    expect(yaml.contents).toContain("baseBranch: master");
  });
});
