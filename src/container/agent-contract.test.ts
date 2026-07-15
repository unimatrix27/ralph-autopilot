import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentContractError,
  loadAgentContract,
  parseAgentContract,
} from "./agent-contract";

function tmpAgentYaml(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-agent-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(path, contents);
  return path;
}

const minimal = `
build: dotnet build
test: dotnet test
restore: dotnet restore
depManifests:
  - "**/*.csproj"
baseBranch: master
`;

describe("agent contract loader (ADR-0038 / issue #190)", () => {
  it("parses + strictly validates a minimal .ralph/agent.yaml", () => {
    const contract = loadAgentContract(tmpAgentYaml(minimal));
    expect(contract.build).toBe("dotnet build");
    expect(contract.test).toBe("dotnet test");
    expect(contract.restore).toBe("dotnet restore");
    expect(contract.depManifests).toEqual(["**/*.csproj"]);
    expect(contract.baseBranch).toBe("master");
  });

  it("fails loud with a useful message when the file is missing", () => {
    expect(() => loadAgentContract(join(tmpdir(), "definitely-absent-agent.yaml"))).toThrow(
      AgentContractError,
    );
    try {
      loadAgentContract(join(tmpdir(), "definitely-absent-agent.yaml"));
    } catch (err) {
      expect((err as Error).message).toContain("not found");
      expect((err as Error).message).toContain("agent.example.yaml");
    }
  });

  it("fails loud on malformed YAML", () => {
    expect(() => loadAgentContract(tmpAgentYaml("build: [unterminated\n"))).toThrow(
      /Malformed YAML/,
    );
  });

  it("fails loud and locates a schema violation", () => {
    try {
      parseAgentContract(
        { build: "x", test: "y", restore: "z", depManifests: [], baseBranch: "main" },
        "agent.yaml",
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentContractError);
      expect((err as Error).message).toContain("depManifests");
    }
  });

  it("rejects unknown keys (typo protection), mirroring config.test.ts", () => {
    expect(() =>
      parseAgentContract({
        build: "x",
        test: "y",
        restore: "z",
        depManifests: ["package.json"],
        baseBranch: "main",
        baseBrunch: "typo",
      }),
    ).toThrow(AgentContractError);
  });

  it("requires build, test, restore, depManifests, and baseBranch (missing fails loud)", () => {
    expect(() => parseAgentContract({ build: "x" })).toThrow(AgentContractError);
    expect(() =>
      parseAgentContract({ build: "x", test: "y", restore: "z", depManifests: ["package.json"] }),
    ).toThrow(/baseBranch/);
  });

  it("rejects an empty depManifests list (at least one manifest required for the L2 cache key)", () => {
    expect(() =>
      parseAgentContract({
        build: "x",
        test: "y",
        restore: "z",
        depManifests: [],
        baseBranch: "main",
      }),
    ).toThrow(AgentContractError);
  });

  it("rejects an empty command string", () => {
    expect(() =>
      parseAgentContract({
        build: "",
        test: "y",
        restore: "z",
        depManifests: ["package.json"],
        baseBranch: "main",
      }),
    ).toThrow(AgentContractError);
  });

  it("accepts the documented example contract", () => {
    const examplePath = resolve(__dirname, "../../.ralph/agent.example.yaml");
    const text = readFileSync(examplePath, "utf8");
    expect(() => loadAgentContract(tmpAgentYaml(text))).not.toThrow();
  });
});
