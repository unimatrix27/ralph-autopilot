import { describe, expect, it } from "vitest";
import {
  DEST_AGENT_DOCKERFILE,
  DEST_AGENT_YAML,
  DEST_DOCKERIGNORE,
  planScaffold,
  setBaseBranch,
  type TemplateFiles,
} from "./scaffold";

const TEMPLATE: TemplateFiles = {
  agentYaml: "build: npm run build\ntest: npm test\nrestore: npm ci\nbaseBranch: main\n",
  agentDockerfile: "FROM ralph/agent-base:latest\n",
  dockerignore: ".git\nnode_modules\n",
};

describe("setBaseBranch", () => {
  it("rewrites only the baseBranch line, leaving the rest intact", () => {
    const out = setBaseBranch(TEMPLATE.agentYaml, "master");
    expect(out).toContain("baseBranch: master");
    expect(out).not.toContain("baseBranch: main");
    expect(out).toContain("build: npm run build");
    expect(out).toContain("test: npm test");
  });

  it("leaves a file without a baseBranch line unchanged", () => {
    const noBranch = "build: x\ntest: y\n";
    expect(setBaseBranch(noBranch, "master")).toBe(noBranch);
  });
});

describe("planScaffold", () => {
  it("plans the three files at their canonical destinations", () => {
    const plan = planScaffold("node", TEMPLATE);
    expect(plan.template).toBe("node");
    expect(plan.files.map((f) => f.path)).toEqual([
      DEST_AGENT_YAML,
      DEST_AGENT_DOCKERFILE,
      DEST_DOCKERIGNORE,
    ]);
  });

  it("applies the baseBranch override to agent.yaml only", () => {
    const plan = planScaffold("node", TEMPLATE, { baseBranch: "develop" });
    const yaml = plan.files.find((f) => f.path === DEST_AGENT_YAML)!;
    expect(yaml.contents).toContain("baseBranch: develop");
  });

  it("copies the Dockerfile and .dockerignore verbatim", () => {
    const plan = planScaffold("node", TEMPLATE, { baseBranch: "develop" });
    expect(plan.files.find((f) => f.path === DEST_AGENT_DOCKERFILE)!.contents).toBe(TEMPLATE.agentDockerfile);
    expect(plan.files.find((f) => f.path === DEST_DOCKERIGNORE)!.contents).toBe(TEMPLATE.dockerignore);
  });

  it("leaves agent.yaml untouched when no override is given", () => {
    const plan = planScaffold("node", TEMPLATE);
    expect(plan.files.find((f) => f.path === DEST_AGENT_YAML)!.contents).toBe(TEMPLATE.agentYaml);
  });
});
