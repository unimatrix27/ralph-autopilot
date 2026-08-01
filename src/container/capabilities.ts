/**
 * The **runner capability contract** (ADR-0041, extending ADR-0038). A per-target agent image
 * ships a runner build; the daemon that dispatches into it may be newer. Most schema evolution
 * is safely additive — an old runner ignores a field it does not know (`assignment.profile`
 * is exactly that, issue #278) — but master escalation is the case where "ignore it" is
 * **wrong**:
 *
 *   `assignment.escalationMode: "master"` says *do not post a `ralph-question`; relay the
 *   question and let the daemon queue a master*. A stale runner ignoring it posts the question
 *   anyway. The issue then carries a human question the daemon never asked, `awaiting-answer`
 *   arrives from a path that is supposed to be master-only, and the operator is paged for a
 *   decision the master was supposed to make. Silently.
 *
 * So the master path is gated on a **declared capability** rather than on additive tolerance.
 * The image declares what its runner build can do; the daemon asserts pre-dispatch and refuses
 * with a precise, actionable error naming the missing capability and the fix — instead of a
 * generic no-result cascade that reads as "the agent failed".
 *
 * Pure: the declaration is a string list, the probe is a port, the check is a function.
 */

/** Capabilities a runner build can declare. Additive — never remove or repurpose a name. */
export const RUNNER_CAPABILITIES = [
  /** Hosts an impl/resume session and reports `pr-opened` / `escalated` / `stuck` (ADR-0038). */
  "impl",
  /** Hosts the review-loop's review and fix passes (#189). */
  "review-fix",
  /** Publishes an escalation runner-direct (pushes WIP + posts the question itself, #187). */
  "runner-direct-escalate",
  /**
   * Understands `assignment.escalationMode` and the `master` assignment kind (ADR-0041): it
   * relays an escalation instead of posting a human question, and can host a master session.
   */
  "master-escalation",
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

/**
 * The image label / env var the runner build stamps its capabilities into. The label is what a
 * daemon-side probe reads with `docker inspect`; the env var is what the runner itself reports.
 * One comma-separated list, so it round-trips through both without a parser.
 */
export const RUNNER_CAPABILITY_LABEL = "io.ralph.runner-capabilities";
export const RUNNER_CAPABILITY_ENV = "RALPH_RUNNER_CAPABILITIES";

/**
 * What the runner built from *this* source tree declares. Shipped into the image as a label by
 * the L0 build and asserted by the shipped-contracts test, so the declaration and the code that
 * implements it cannot drift.
 */
export const CURRENT_RUNNER_CAPABILITIES: readonly RunnerCapability[] = RUNNER_CAPABILITIES;

/** Serialise a capability list for the image label / env var. */
export function formatRunnerCapabilities(caps: readonly string[]): string {
  return caps.join(",");
}

/**
 * Parse a capability declaration. An absent/blank declaration is an **empty** list, not "all" —
 * a pre-capability image declares nothing, and treating silence as full support is precisely
 * the failure this module exists to prevent.
 */
export function parseRunnerCapabilities(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Raised pre-dispatch when the target's runner image cannot serve the requested dispatch. */
export class RunnerCompatibilityError extends Error {
  override readonly name = "RunnerCompatibilityError";
  constructor(
    readonly image: string,
    readonly missing: readonly string[],
    readonly declared: readonly string[],
  ) {
    super(
      `runner image \`${image}\` does not declare the capability required for this dispatch: ` +
        `${missing.join(", ")}. It declares [${declared.length > 0 ? declared.join(", ") : "(nothing)"}]. ` +
        "This is a stale-runner compatibility failure, not an agent failure: rebuild the target's " +
        "agent image from the current `ralph/agent-base` (see docs/runbooks/container-image-refresh.md) " +
        `so its \`${RUNNER_CAPABILITY_LABEL}\` label includes ${missing.join(", ")}.`,
    );
  }
}

/**
 * Reads an image's declared capabilities. The production implementation inspects the image's
 * `io.ralph.runner-capabilities` label; a routing-agnostic setup / test injects a fake. Absent
 * probe → the check is skipped entirely (there is no image to be stale).
 */
export interface RunnerCapabilityProbe {
  capabilities(image: string): Promise<string[]>;
}

/** Runs one `docker` invocation and resolves its stdout. Injected so the probe stays testable. */
export type DockerInspect = (args: string[]) => Promise<string>;

/**
 * The production probe: read an image's `io.ralph.runner-capabilities` label with
 * `docker image inspect`. A missing image / missing label resolves to **no** capabilities (an
 * unreadable declaration is not a permissive one), which surfaces as the same precise
 * compatibility error an outright stale image does.
 */
export function createDockerCapabilityProbe(inspect: DockerInspect): RunnerCapabilityProbe {
  return {
    async capabilities(image: string): Promise<string[]> {
      try {
        const out = await inspect([
          "image",
          "inspect",
          "--format",
          `{{ index .Config.Labels "${RUNNER_CAPABILITY_LABEL}" }}`,
          image,
        ]);
        // `docker inspect` prints `<no value>` for an absent label.
        const raw = out.trim();
        return raw === "<no value>" ? [] : parseRunnerCapabilities(raw);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Assert an image can serve a dispatch requiring `required`, or throw a precise
 * {@link RunnerCompatibilityError}. Throws **before** anything is dispatched, so a stale runner
 * surfaces as one legible error rather than a generic no-result → review-maxed cascade.
 *
 * A `null` probe is a deliberate no-op: in-process and test wirings have no image to interrogate,
 * and failing closed there would break every deployment that never needed the capability.
 */
export async function assertRunnerSupports(
  probe: RunnerCapabilityProbe | undefined,
  image: string,
  required: readonly RunnerCapability[],
): Promise<void> {
  if (!probe || required.length === 0) {
    return;
  }
  const declared = await probe.capabilities(image);
  const missing = required.filter((cap) => !declared.includes(cap));
  if (missing.length > 0) {
    throw new RunnerCompatibilityError(image, missing, declared);
  }
}
