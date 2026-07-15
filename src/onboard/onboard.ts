/**
 * **The `ralph onboard` orchestrator** (ADR-0038, epic #182, issue #192): detect → scaffold →
 * build + smoke-test, the four onboarding steps wired into one flow over injected ports so the
 * control flow is fully unit-testable without touching a real filesystem, git, or Docker.
 *
 * The **smoke-test is the acceptance gate** (ADR-0038): the orchestrator writes a committable
 * `.ralph/` *before* it runs, so the contract is on disk to edit and commit even when the gate
 * fails, but a failing smoke-test yields `ok: false` — onboarding is **blocked** with an
 * actionable message, never reported as success. This is the "a misconfigured repo fails at
 * onboarding, not mid-run" guarantee.
 *
 * Each step's side effects (fs scan, template read, git, file writes, the smoke-test shell) live
 * behind {@link OnboardDeps}; the bin (`bin/ralph-onboard.ts`) supplies the real edges, the tests
 * supply fakes. The decision logic here stays pure over those ports.
 */
import { detectToolchain, type RepoFacts, type TemplateId, type ToolchainDetection } from "./detect";
import { planScaffold, type ScaffoldFile, type TemplateFiles } from "./scaffold";

/** The outcome of running the smoke-test acceptance gate. */
export interface SmokeResult {
  /** `true` iff the gate passed (image built, then clone → restore → test all succeeded). */
  ok: boolean;
  /** Combined stdout+stderr of the gate, surfaced verbatim in a failure message. */
  output: string;
}

/** The side-effecting ports the orchestrator drives; faked in tests, real in the bin. */
export interface OnboardDeps {
  /** Snapshot the target repo's marker files for detection. */
  gatherFacts(): RepoFacts;
  /** Read a template's files from `templates/onboard/<id>`. */
  readTemplate(template: TemplateId): TemplateFiles;
  /** The target's actual default branch, if resolvable — fed to the scaffold as a `baseBranch` override. */
  detectBaseBranch(): string | undefined;
  /** Does a file already exist at this repo-relative destination? Guards against clobbering. */
  destExists(relPath: string): boolean;
  /** Write one planned file into the target repo. */
  writeFile(file: ScaffoldFile): void;
  /** Run the smoke-test acceptance gate (`ops/smoke-test-agent-image.sh`) against the target. */
  runSmokeTest(): Promise<SmokeResult>;
}

/** Caller-supplied knobs for one onboarding run. */
export interface OnboardOptions {
  /** Force a template instead of detecting one (e.g. detection was ambiguous or wrong). */
  template?: TemplateId;
  /** Overwrite an existing `.ralph/` contract instead of refusing. */
  force?: boolean;
  /** Scaffold only — skip the build + smoke-test gate (e.g. on a box without Docker). */
  skipSmoke?: boolean;
}

/** The terminal result of an onboarding run. */
export type OnboardOutcome =
  | {
      ok: true;
      template: TemplateId;
      /** The repo-relative paths written, in plan order. */
      scaffolded: string[];
      /** `true` if the smoke-test gate ran and passed; `false` if it was skipped. */
      smokeRan: boolean;
      /** The detection evidence, or `null` when a template was forced via {@link OnboardOptions.template}. */
      detection: ToolchainDetection | null;
      message: string;
    }
  | {
      /** Which step blocked onboarding. */
      stage: "detect" | "scaffold" | "smoke";
      ok: false;
      message: string;
      /** The detection evidence when the detect step ran. */
      detection?: ToolchainDetection;
    };

/**
 * Run one onboarding pass. Order: pick a template (forced or detected) → refuse to clobber an
 * existing contract unless `force` → write the scaffold → (unless `skipSmoke`) run the smoke-test
 * gate. A blocked detect or smoke step returns `ok: false` with the actionable message; the
 * written `.ralph/` always remains on disk for the smoke stage so it is committable and editable.
 */
export async function onboard(deps: OnboardDeps, options: OnboardOptions = {}): Promise<OnboardOutcome> {
  // 1. Pick a template — an explicit override wins; otherwise detect from the repo's markers.
  let template: TemplateId;
  let detection: ToolchainDetection | null = null;
  if (options.template) {
    template = options.template;
  } else {
    detection = detectToolchain(deps.gatherFacts());
    if (!detection.chosen) {
      return { ok: false, stage: "detect", message: detection.reason, detection };
    }
    template = detection.chosen;
  }

  // 2. Plan the scaffold, substituting the repo's real default branch when we can resolve it.
  const baseBranch = deps.detectBaseBranch();
  const plan = planScaffold(template, deps.readTemplate(template), baseBranch ? { baseBranch } : {});

  // 3. Refuse to clobber an existing contract unless forced — onboarding twice should be opt-in.
  if (!options.force) {
    const existing = plan.files.filter((f) => deps.destExists(f.path)).map((f) => f.path);
    if (existing.length > 0) {
      return {
        ok: false,
        stage: "scaffold",
        message:
          `Refusing to overwrite an existing contract: ${existing.join(", ")} already present. ` +
          "Re-run with --force to overwrite, or remove the files first.",
        ...(detection ? { detection } : {}),
      };
    }
  }

  // 4. Write the committable `.ralph/` (+ root .dockerignore) — on disk before the gate runs.
  for (const file of plan.files) {
    deps.writeFile(file);
  }
  const scaffolded = plan.files.map((f) => f.path);

  // 5. The acceptance gate. Skipped only on explicit request; otherwise a failure BLOCKS onboarding.
  if (options.skipSmoke) {
    return {
      ok: true,
      template,
      scaffolded,
      smokeRan: false,
      detection,
      message:
        `Scaffolded ${template} contract (${scaffolded.join(", ")}). ` +
        "Smoke-test skipped — run ops/smoke-test-agent-image.sh before committing to prove the image builds.",
    };
  }

  const smoke = await deps.runSmokeTest();
  if (!smoke.ok) {
    return {
      ok: false,
      stage: "smoke",
      message:
        `Smoke-test FAILED — onboarding blocked. The ${template} contract was written ` +
        `(${scaffolded.join(", ")}) so you can fix it, but it is NOT proven buildable yet.\n` +
        "Edit .ralph/agent.yaml (build/test/restore/depManifests) and .ralph/agent.Dockerfile " +
        "(toolchain/deps), then re-run onboarding. Smoke-test output:\n" +
        smoke.output,
      ...(detection ? { detection } : {}),
    };
  }

  return {
    ok: true,
    template,
    scaffolded,
    smokeRan: true,
    detection,
    message:
      `Onboarded ${template}: scaffolded ${scaffolded.join(", ")} and the image built + smoke-tested clean. ` +
      "Commit the .ralph/ contract and the root .dockerignore.",
  };
}
