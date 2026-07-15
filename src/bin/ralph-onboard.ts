#!/usr/bin/env node
/**
 * `ralph-onboard` — the **CLI behind the `ralph onboard` Claude skill** (ADR-0038, epic #182,
 * issue #192). Run inside (or pointed at) a target repo, it does the four onboarding steps end to
 * end: **detect** the toolchain → **scaffold** the `.ralph/` container contract from
 * `templates/onboard/<id>` → **build + smoke-test** the per-target image as the acceptance gate.
 *
 * The deterministic decision logic lives in the pure cores (`src/onboard/{detect,scaffold,onboard}`);
 * this bin only supplies the real edges — an fs scan for {@link RepoFacts}, git for the default
 * branch, file writes, and a shell to `ops/smoke-test-agent-image.sh`. A failing smoke-test exits
 * non-zero with an actionable message; the scaffolded `.ralph/` stays on disk to fix and commit.
 *
 * Usage:
 *   ralph-onboard [--target DIR] [--template node|dotnet-angular] [--force] [--skip-smoke]
 *
 * `--target` defaults to the current directory. Prerequisites for the gate: Docker + a built L0
 * base (`./docker/agent-base/build.sh`); pass `--skip-smoke` to scaffold only.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { promisify } from "node:util";
import { fsRepoFacts, type TemplateId } from "../onboard/detect";
import { readTemplateFiles, type ScaffoldFile } from "../onboard/scaffold";
import { onboard, type OnboardDeps, type OnboardOptions, type SmokeResult } from "../onboard/onboard";

const execFileAsync = promisify(execFile);

const TEMPLATE_IDS: readonly TemplateId[] = ["node", "dotnet-angular"];

interface CliArgs extends OnboardOptions {
  targetDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  let targetDir = process.cwd();
  let template: TemplateId | undefined;
  let force = false;
  let skipSmoke = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" || arg === "-t") {
      targetDir = argv[++i] ?? targetDir;
    } else if (arg === "--template") {
      const value = argv[++i] ?? "";
      if (!TEMPLATE_IDS.includes(value as TemplateId)) {
        throw new Error(`unknown --template '${value}'; expected one of ${TEMPLATE_IDS.join(", ")}`);
      }
      template = value as TemplateId;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--skip-smoke") {
      skipSmoke = true;
    } else if (arg === "--help" || arg === "-h") {
      stdout.write(
        "ralph-onboard — scaffold + smoke-test a target's .ralph/ container contract (#192).\n\n" +
          "Usage: ralph-onboard [--target DIR] [--template node|dotnet-angular] [--force] [--skip-smoke]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unexpected argument '${arg}' (see --help)`);
    }
  }
  return { targetDir: resolve(targetDir), template, force, skipSmoke };
}

/**
 * Resolve the ralph install root (where `templates/` and `ops/` live) from this compiled bin at
 * `dist/bin/ralph-onboard.js` → repo root, falling back to the cwd. Mirrors `control-plane.ts`'s
 * package-root resolution.
 */
function ralphRoot(): string {
  const candidates = [join(__dirname, "..", ".."), process.cwd()];
  for (const root of candidates) {
    if (existsSync(join(root, "templates", "onboard")) && existsSync(join(root, "ops", "smoke-test-agent-image.sh"))) {
      return root;
    }
  }
  return candidates[0]!;
}

/** Best-effort: the target repo's current branch (the PR base the contract should target). */
async function detectBaseBranch(targetDir: string): Promise<string | undefined> {
  try {
    const { stdout: out } = await execFileAsync("git", ["-C", targetDir, "symbolic-ref", "--short", "HEAD"]);
    const branch = out.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** Run the smoke-test acceptance gate, capturing combined output and the pass/fail exit. */
async function runSmokeTest(root: string, targetDir: string): Promise<SmokeResult> {
  const script = join(root, "ops", "smoke-test-agent-image.sh");
  try {
    const { stdout: out, stderr: err } = await execFileAsync("bash", [script, targetDir], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, output: out + err };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (err.stdout ?? "") + (err.stderr ?? "") || (err.message ?? "smoke-test failed") };
  }
}

/**
 * Build the real {@link OnboardDeps}. `baseBranch` is resolved by git (async) before this is
 * called and closed over, so the sync `detectBaseBranch` port just hands it back.
 */
function realDeps(args: CliArgs, baseBranch: string | undefined): OnboardDeps {
  const root = ralphRoot();
  const templatesDir = join(root, "templates", "onboard");
  return {
    gatherFacts: () => fsRepoFacts(args.targetDir),
    readTemplate: (template) => readTemplateFiles(templatesDir, template),
    detectBaseBranch: () => baseBranch,
    destExists: (relPath) => existsSync(join(args.targetDir, relPath)),
    writeFile: (file: ScaffoldFile) => {
      const dest = join(args.targetDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.contents);
    },
    runSmokeTest: () => runSmokeTest(root, args.targetDir),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.targetDir)) {
    throw new Error(`target directory does not exist: ${args.targetDir}`);
  }
  const deps = realDeps(args, await detectBaseBranch(args.targetDir));

  stdout.write(`ralph-onboard — onboarding ${args.targetDir}\n`);
  const result = await onboard(deps, args);

  if (result.ok) {
    stdout.write(`\n✓ ${result.message}\n`);
    return;
  }
  stderr.write(`\n✗ Onboarding blocked at the ${result.stage} step.\n${result.message}\n`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  stderr.write(`ralph-onboard: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
