/**
 * The runtime **routing overlay** (ADR-0037 P4.1, issue #166) — the single seam that makes
 * routing mutable without a daemon restart. It holds the current routing in memory (seeded from
 * the loaded {@link RalphConfig}) and is the live source the per-target {@link RoutingSource}
 * thunk reads, so a web routing edit is reflected on the **next** dispatch (≈ next tick); an
 * in-flight container finishes on the route it was dispatched with (one fixed route per container
 * life, ADR-0038).
 *
 * A write does two things, in order:
 *   1. **Validate** the resulting config through the SAME load-time gate ({@link resolveTargets},
 *      which folds the {@link capabilityOk} capability gate, the provider-configured check, and
 *      the account-present check) — so a runtime edit can never persist a config that would fail
 *      to reload (no restart-wedge), and a capability-invalid pairing (e.g. `impl → openai`) is
 *      rejected at the edge.
 *   2. **Write through** to `config.yaml` (gitignored → survives the self-update `git reset
 *      --hard`), then commit the in-memory overlay. The file is the one source of truth; the
 *      overlay is the live, already-persisted edit, so boot needs no file-vs-store reconciliation.
 *
 * Per-target `agent` overrides are preserved: the overlay edits the **global** routing, and
 * {@link routingFor} returns each target's `resolveTargets`-merged routing via the pure
 * {@link resolveEffectiveRouting} (the `resolve(globalRouting, repoPatch?)` shape, patch empty in
 * v1 — per-repo deviation is #170).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type { Logger } from "../log/logger";
import type {
  Account,
  AgentSettings,
  ProvidersSettings,
  RalphConfig,
  ReviewFixRouting,
  TargetConfig,
} from "./schema";
import { ConfigError, resolveAccountPool, resolveTargets } from "./load";
import { capabilityOk, providerPreferenceList, type AgentType } from "../providers/select";
import { resolveEffectiveRouting, type RoutingConfig, type RoutingSource } from "../providers/resolve";

/**
 * One routing edit (ADR-0037 P4.1). A discriminated union on `target` so account / provider edits
 * are additive arms later (#170 / a follow-up). The v1 arm sets a **type's routing**: `routing` is
 * the new value — a single entry / preference list, or (for `review`/`fix`) the per-phase object
 * form (ADR-0037 #169) — or `null` to **clear** the override (the type falls back to the global
 * default). Structurally matches the contract's `RoutingEditRequestBody` (sans `repo`, ignored in
 * v1), so the web adapter passes it through.
 */
export type RoutingEdit = { target: "type"; type: AgentType; routing: ReviewFixRouting | null };

/** The outcome of {@link RoutingStore.applyEdit}: applied, or rejected with a clear edge error. */
export type RoutingEditOutcome = { ok: true; cleared: boolean } | { ok: false; error: string };

/** The global routing snapshot the web read serialises (ADR-0037 P4.1): agent + providers + pool. */
export interface RoutingSnapshot {
  agent: AgentSettings;
  providers: ProvidersSettings;
  accounts: Account[];
}

export interface RoutingStoreDeps {
  /** The loaded, validated config — the overlay's seed and write-through base. */
  config: RalphConfig;
  /** The already-resolved targets (from {@link resolveTargets}); seeds the per-repo routing lookup. */
  targets: readonly TargetConfig[];
  /**
   * Path to `config.yaml` for write-through. Absent → **overlay-only** mode (the runtime effect
   * still works; nothing is persisted) — used by a headless/test embed.
   */
  configPath?: string;
  logger?: Logger;
  /** Injectable fs read (defaults to `readFileSync`), so write-through is unit-testable. */
  readFile?: (path: string) => string;
  /** Injectable fs write (defaults to `writeFileSync`), so write-through is unit-testable. */
  writeFile?: (path: string, data: string) => void;
}

/** Strip the load-time `Invalid configuration:` prefix so the web edge error reads cleanly. */
function cleanConfigErrorMessage(message: string): string {
  return message.replace(/^Invalid configuration:\s*/, "");
}

export class RoutingStore {
  private config: RalphConfig;
  private targetByRepo: Map<string, TargetConfig>;
  private readonly configPath: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly readFile: (path: string) => string;
  private readonly writeFile: (path: string, data: string) => void;

  constructor(deps: RoutingStoreDeps) {
    this.config = deps.config;
    this.targetByRepo = new Map(deps.targets.map((target) => [target.targetRepo, target]));
    this.configPath = deps.configPath;
    this.logger = deps.logger;
    this.readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data, "utf8"));
  }

  /**
   * The effective {@link RoutingConfig} for `repo` — the per-target `resolveTargets`-merged routing
   * resolved through the pure {@link resolveEffectiveRouting} (patch empty in v1). An unknown repo
   * falls back to the global routing. This is read fresh per dispatch, so the latest overlay edit
   * is always reflected.
   */
  routingFor(repo: string): RoutingConfig {
    const target = this.targetByRepo.get(repo);
    const global = target
      ? { agent: target.agent, providers: target.providers }
      : { agent: this.config.agent, providers: this.config.providers };
    return resolveEffectiveRouting(global);
  }

  /** A {@link RoutingSource} thunk bound to `repo` — the drop-in the daemon hands route resolution. */
  routingSourceFor(repo: string): RoutingSource {
    return () => this.routingFor(repo);
  }

  /** The global routing snapshot the web read serialises (agent + providers + resolved account pool). */
  snapshot(): RoutingSnapshot {
    return {
      agent: this.config.agent,
      providers: this.config.providers,
      accounts: resolveAccountPool(this.config),
    };
  }

  /**
   * Apply one routing edit (ADR-0037 P4.1): validate (capability gate + full load-time validation),
   * write through to `config.yaml`, then commit the in-memory overlay. Returns the outcome; never
   * throws on an invalid edit — the caller maps it to an HTTP status. The overlay is mutated only
   * after a successful validate + persist, so the file and the overlay never diverge.
   */
  applyEdit(edit: RoutingEdit): RoutingEditOutcome {
    const cleared = edit.routing === null;
    const newTypes: Record<string, ReviewFixRouting> = { ...this.config.agent.types };
    if (edit.routing === null) {
      delete newTypes[edit.type];
    } else {
      newTypes[edit.type] = edit.routing;
    }
    const candidate: RalphConfig = {
      ...this.config,
      agent: { ...this.config.agent, types: newTypes as AgentSettings["types"] },
    };

    // Capability gate at the edge (AC3): a precise, env-free message before the deeper validation,
    // so an `impl → openai` edit is rejected with a clear reason naming the offending pairing.
    if (edit.routing !== null) {
      for (const { provider } of providerPreferenceList(candidate.agent, edit.type)) {
        if (!capabilityOk(edit.type, provider, candidate.providers)) {
          return {
            ok: false,
            error: `agent type '${edit.type}' cannot route to provider '${provider}': it is not tools-capable, but this type requires the in-session escalate/stuck tools (ADR-0037 capability gate)`,
          };
        }
      }
    }

    // Defence in depth: run the candidate through the SAME load-time validation the daemon boots
    // on. This both re-checks the capability gate and rejects a config that would fail to reload
    // (a selected provider with no block/account), so a runtime edit can never wedge the next start.
    let targets: TargetConfig[];
    try {
      targets = resolveTargets(candidate);
    } catch (err) {
      if (err instanceof ConfigError) {
        return { ok: false, error: cleanConfigErrorMessage(err.message) };
      }
      throw err;
    }

    // Write through FIRST (the file is the source of truth); commit the overlay only once persisted,
    // so file + overlay never diverge. A persist failure rejects the edit with the overlay untouched.
    try {
      this.writeThrough(candidate);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger?.error("routing.write-through-failed", { configPath: this.configPath, error: reason });
      return { ok: false, error: `failed to persist routing edit to config.yaml: ${reason}` };
    }

    this.config = candidate;
    this.targetByRepo = new Map(targets.map((target) => [target.targetRepo, target]));
    this.logger?.info("routing.edit-applied", { type: edit.type, cleared });
    return { ok: true, cleared };
  }

  /**
   * Persist the global per-type routing to `config.yaml` (overlay-only when no path is wired).
   * Edits the parsed document in place (`agent.types`) so the operator's comments and the rest of
   * the file survive — the gitignored file the self-update reset never touches.
   */
  private writeThrough(candidate: RalphConfig): void {
    if (!this.configPath) {
      return;
    }
    const doc = parseDocument(this.readFile(this.configPath));
    doc.setIn(["agent", "types"], candidate.agent.types);
    this.writeFile(this.configPath, doc.toString());
  }
}
