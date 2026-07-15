/**
 * **Toolchain detection for `ralph onboard`** (ADR-0038, epic #182, issue #192). Given a snapshot
 * of which marker files a target repo carries, decide which onboarding template
 * (`templates/onboard/<id>`) fits — the first step of the skill that scaffolds the `.ralph/`
 * container contract.
 *
 * A **pure core** over an injected {@link RepoFacts} port (no direct fs), so the decision is
 * exhaustively unit-testable; the real filesystem edge ({@link fsRepoFacts}) lives at the bottom
 * and is exercised by the bin / the onboarding smoke-test, not the unit suite. Detection is
 * deterministic and **priority-ordered**: a repo that matches more than one template resolves to
 * the highest-priority match, never an ambiguous tie.
 */
import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";

/** The onboarding templates ralph ships (`templates/onboard/<id>`). */
export type TemplateId = "node" | "dotnet-angular";

/**
 * The filesystem questions detection asks of a target repo, injected so the decision is pure.
 * Both are repo-relative; the real edge ({@link fsRepoFacts}) answers them against a clone.
 */
export interface RepoFacts {
  /** Does a file exist at this exact repo-relative path? */
  hasPath(relPath: string): boolean;
  /** Does any file match this repo-relative glob (e.g. `**\/*.csproj`)? */
  hasMatch(glob: string): boolean;
}

/** One piece of evidence considered for a template — a human-readable signal and whether it held. */
export interface DetectionSignal {
  description: string;
  matched: boolean;
}

/** A template's full evaluation: its signals and whether *all required* ones held. */
export interface TemplateMatch {
  template: TemplateId;
  label: string;
  signals: DetectionSignal[];
  matched: boolean;
}

/** The detection outcome: the chosen template (if any) plus every template's evidence. */
export interface ToolchainDetection {
  /** The highest-priority matching template, or `null` when none matched. */
  chosen: TemplateId | null;
  /** Every template's evaluation, in priority order — the evidence behind {@link chosen}. */
  matches: TemplateMatch[];
  /** A human-readable explanation of why {@link chosen} was (or was not) picked. */
  reason: string;
}

/** A probe: a template plus the signals that, when *all* present, make it a match. */
interface TemplateProbe {
  template: TemplateId;
  label: string;
  /** All must hold for the template to match. */
  required: Array<{ description: string; test(facts: RepoFacts): boolean }>;
}

/**
 * The probes, in **priority order** (first match wins). `dotnet-angular` is checked before `node`
 * because a .NET + Angular monorepo carries *both* a .NET project and a Node client — the .NET
 * signal is the more specific one, so it takes precedence over the generic Node fallback.
 */
const PROBES: TemplateProbe[] = [
  {
    template: "dotnet-angular",
    label: ".NET + Angular",
    required: [
      {
        description: "a .NET project or SDK pin (global.json / *.sln / *.csproj)",
        test: (f) => f.hasPath("global.json") || f.hasMatch("**/*.sln") || f.hasMatch("**/*.csproj"),
      },
    ],
  },
  {
    template: "node",
    label: "Node / TypeScript",
    required: [
      {
        description: "a root package.json",
        test: (f) => f.hasPath("package.json"),
      },
    ],
  },
];

/**
 * Detect the onboarding template for a target repo from its {@link RepoFacts}. Evaluates every
 * probe (so the caller always gets the full evidence) and chooses the first, highest-priority
 * template whose required signals all hold. Returns `chosen: null` with an actionable reason when
 * nothing matched.
 */
export function detectToolchain(facts: RepoFacts): ToolchainDetection {
  const matches: TemplateMatch[] = PROBES.map((probe) => {
    const signals = probe.required.map((sig) => ({
      description: sig.description,
      matched: sig.test(facts),
    }));
    return {
      template: probe.template,
      label: probe.label,
      signals,
      matched: signals.every((s) => s.matched),
    };
  });

  const winner = matches.find((m) => m.matched) ?? null;
  if (winner) {
    return {
      chosen: winner.template,
      matches,
      reason: `Detected ${winner.label} (${winner.template}): ${winner.signals
        .map((s) => s.description)
        .join("; ")}.`,
    };
  }

  return {
    chosen: null,
    matches,
    reason:
      "Could not detect a supported toolchain. No shipped template matched: " +
      `${PROBES.map((p) => `${p.template} needs ${p.required.map((r) => r.description).join(" and ")}`).join("; ")}. ` +
      "Pass --template <node|dotnet-angular> to scaffold one explicitly, or author .ralph/ by hand from templates/onboard.",
  };
}

// ---- real filesystem edge (infra — exercised by the bin / smoke-test, not the unit suite) ----

/**
 * Real {@link RepoFacts} over a target repo directory. `hasPath` is a direct existence check;
 * `hasMatch` globs but **prunes the heavy build/dep trees** so a scan of a large monorepo stays
 * fast and never matches a vendored marker (e.g. a `*.csproj` inside `node_modules`). Thin fs
 * glue, mirroring `fsManifestSources` in `image-build.ts`.
 */
export function fsRepoFacts(rootDir: string): RepoFacts {
  return {
    hasPath: (relPath) => existsSync(join(rootDir, relPath)),
    hasMatch: (glob) =>
      globSync(glob, {
        cwd: rootDir,
        // Prune the heavy build/dep trees so a scan stays fast and never matches a vendored marker
        // (e.g. a *.csproj inside node_modules). `exclude` takes a per-path predicate in node:fs.
        exclude: (path) => /(^|\/)(node_modules|bin|obj|dist|\.git)(\/|$)/.test(path),
      }).length > 0,
  };
}
