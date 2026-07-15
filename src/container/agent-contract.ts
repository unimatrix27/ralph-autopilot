/**
 * The **target onboarding contract** — `.ralph/agent.yaml` (ADR-0038, issue #190). A target
 * opts into the container model (epic #182) by carrying this file in its own repo, **distinct
 * from the daemon's per-deployment `.ralph/config.yaml`**: it is versioned *with the target's
 * code* so it evolves alongside the codebase, not in the daemon's config.
 *
 * It declares how to build, test, and restore the target plus the dependency manifests that key
 * the L2 deps layer cache and the branch a PR targets. Validated with the **same strict-zod
 * discipline as `src/config/schema.ts`** (ADR-0010): unknown keys rejected (typo protection),
 * missing required fields fail loud — mirroring `config.test.ts`. Pure schema + a thin loader at
 * the edge, matching the rest of the codebase.
 */
import { z } from "zod";
import { loadYamlFile, parseYamlValue, type YamlFileMessages } from "../config/yaml-loader";

export const DEFAULT_AGENT_CONTRACT_PATH = ".ralph/agent.yaml";

const nonEmpty = z.string().min(1, "must not be empty");

/**
 * The strict schema for `.ralph/agent.yaml`. Every field is required and non-empty — a target
 * onboarding into the container model declares all of it explicitly; there are no daemon-side
 * defaults to fall back on (this contract lives in the *target* repo, not the daemon's config).
 * `.strict()` rejects unknown keys so a typo fails loud, exactly as `configSchema` does.
 */
export const agentContractSchema = z
  .object({
    /** The target's build command, run in-container after restore (L2). */
    build: nonEmpty,
    /** The target's test command — what the onboarding smoke-test and agents run. */
    test: nonEmpty,
    /** The dependency-restore command baked into the L2 deps layer (e.g. `dotnet restore`, `npm ci`). */
    restore: nonEmpty,
    /**
     * The dependency manifests whose contents key the **L2 deps layer cache** (ADR-0038): a
     * change to any declared manifest invalidates the cache and rebuilds the deps layer. At least
     * one is required — there is no cache key without a manifest to hash.
     */
    depManifests: z.array(nonEmpty).min(1, "at least one dependency manifest is required"),
    /** The branch a PR for this target targets (e.g. `master`, `main`). */
    baseBranch: nonEmpty,
  })
  .strict();

/** The validated target onboarding contract. */
export type AgentContract = z.infer<typeof agentContractSchema>;

/** Thrown when the agent contract cannot be read, parsed, or validated. */
export class AgentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentContractError";
  }
}

/** The {@link loadYamlFile} customization for the agent contract: its error type + prose nouns. */
const AGENT_CONTRACT_MESSAGES: YamlFileMessages = {
  makeError: (message) => new AgentContractError(message),
  noun: "agent contract",
  subject: "Agent contract",
  notFoundHint: (path) => `Copy .ralph/agent.example.yaml to ${path} in the target repo and edit it.`,
};

/** Validate an already-parsed object against {@link agentContractSchema}. */
export function parseAgentContract(raw: unknown, source = "(agent contract)"): AgentContract {
  return parseYamlValue(agentContractSchema, raw, source, AGENT_CONTRACT_MESSAGES);
}

/**
 * Read, parse, and validate a target's `.ralph/agent.yaml`. Fails loud with a useful,
 * source-located message on a missing file, malformed YAML, or schema mismatch — mirroring
 * {@link loadConfig} via the shared {@link loadYamlFile}.
 */
export function loadAgentContract(path: string = DEFAULT_AGENT_CONTRACT_PATH): AgentContract {
  return loadYamlFile(path, agentContractSchema, AGENT_CONTRACT_MESSAGES);
}
