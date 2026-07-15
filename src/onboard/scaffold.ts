/**
 * **Scaffold planning for `ralph onboard`** (ADR-0038, epic #182, issue #192). Turns a chosen
 * {@link TemplateId} + the template's file contents into the concrete set of files to write into a
 * target repo — the `.ralph/` container contract plus the build-context `.dockerignore`.
 *
 * A **pure planner** ({@link planScaffold}): same template + overrides → same {@link ScaffoldPlan},
 * with the one detection-derived substitution (`baseBranch`) applied as a deterministic line
 * rewrite. The real template-reading edge ({@link readTemplateFiles}) sits at the bottom. Writing
 * the plan is the orchestrator's job (`onboard.ts`); this module only *decides what to write*.
 *
 * Destination layout mirrors this repo's own contract: `agent.yaml` + `agent.Dockerfile` under
 * `.ralph/`, and the `.dockerignore` at the **repo root** (where `docker build`'s context lives),
 * matching `.ralph/agent.yaml`'s "the repo-root `.dockerignore`" note.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TemplateId } from "./detect";

/** Where each scaffolded file lands in the target repo (repo-relative). */
export const DEST_AGENT_YAML = ".ralph/agent.yaml";
export const DEST_AGENT_DOCKERFILE = ".ralph/agent.Dockerfile";
export const DEST_DOCKERIGNORE = ".dockerignore";

/** The three template files, read verbatim from `templates/onboard/<id>`. */
export interface TemplateFiles {
  agentYaml: string;
  agentDockerfile: string;
  dockerignore: string;
}

/** A single file to write: a repo-relative destination path and its full contents. */
export interface ScaffoldFile {
  path: string;
  contents: string;
}

/** The plan: which template was used and the exact files to write. */
export interface ScaffoldPlan {
  template: TemplateId;
  files: ScaffoldFile[];
}

/** Detection-derived substitutions applied to the template before writing. */
export interface ScaffoldOverrides {
  /** The target's actual default branch — replaces the template's `baseBranch:` line when set. */
  baseBranch?: string;
}

/**
 * Rewrite the `baseBranch:` value in an `agent.yaml`, preserving everything else (comments,
 * ordering, the rest of the file). Pure string transform. If the file has no `baseBranch:` line
 * (a malformed template), it is returned unchanged — the strict contract loader is the real
 * validator and will fail loud downstream.
 */
export function setBaseBranch(agentYaml: string, baseBranch: string): string {
  return agentYaml.replace(/^baseBranch:.*$/m, `baseBranch: ${baseBranch}`);
}

/**
 * Plan the scaffold for a target: place the template's `agent.yaml` + `agent.Dockerfile` under
 * `.ralph/` and its `.dockerignore` at the repo root, applying the `baseBranch` override (if any)
 * to `agent.yaml`. The `.dockerignore` and `agent.Dockerfile` are copied verbatim — the toolchain
 * and ignore set are the operator's to tune, not detection's to guess.
 */
export function planScaffold(
  template: TemplateId,
  files: TemplateFiles,
  overrides: ScaffoldOverrides = {},
): ScaffoldPlan {
  const agentYaml = overrides.baseBranch ? setBaseBranch(files.agentYaml, overrides.baseBranch) : files.agentYaml;
  return {
    template,
    files: [
      { path: DEST_AGENT_YAML, contents: agentYaml },
      { path: DEST_AGENT_DOCKERFILE, contents: files.agentDockerfile },
      { path: DEST_DOCKERIGNORE, contents: files.dockerignore },
    ],
  };
}

// ---- real template-reading edge (infra — exercised by the bin, not the unit suite) ----

/**
 * Read a template's three files from `templates/onboard/<id>`. Thin fs glue; the bin resolves
 * `templatesDir` against the ralph install root.
 */
export function readTemplateFiles(templatesDir: string, template: TemplateId): TemplateFiles {
  const dir = join(templatesDir, template);
  return {
    agentYaml: readFileSync(join(dir, "agent.yaml"), "utf8"),
    agentDockerfile: readFileSync(join(dir, "agent.Dockerfile"), "utf8"),
    dockerignore: readFileSync(join(dir, ".dockerignore"), "utf8"),
  };
}
