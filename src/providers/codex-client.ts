/**
 * The single, isolated edge that touches `@openai/codex-sdk` (issue #131, ADR-0033).
 * Everything else — the backend's abort/wall-clock/rubric logic, the review/fix runners,
 * the config plumbing — is tested behind the {@link CodexClient} / SessionBackend fakes;
 * this thin adapter is the only code that loads the SDK, and it does so **lazily** (a
 * dynamic `import`) so a Claude-only box never loads the optional dependency.
 *
 * Non-interactive posture (the Codex analog of Claude's `bypassPermissions`; the box is
 * the blast radius per OPERATING.md): `approvalPolicy: "never"`, `sandboxMode:
 * "danger-full-access"` (a fix session finishes a rebase in-session, writing git's
 * index.lock / rebase state to the shared clone's `.git/worktrees/<name>/` OUTSIDE the
 * worktree — which `workspace-write` makes read-only, so every conflict-resolving fix
 * escalated with "cannot create index.lock"), `networkAccessEnabled: true` (the fix agent
 * pushes its branch; review fetches the diff), `skipGitRepoCheck: true` (the harness
 * manages the worktree).
 * Authentication is the ChatGPT-subscription `auth.json` under `CODEX_HOME` — routed via
 * the SDK's `env` (which REPLACES the child env, so it is seeded from `process.env` to
 * keep `PATH` etc.) — never an API key (ADR-0033 amends ADR-0008).
 */

import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { CodexClient, CodexRunRequest } from "./codex-backend";

/**
 * A genuine dynamic ESM `import()` that survives CommonJS transpilation. `@openai/codex-sdk`
 * is ESM-only (its `exports` map has no `require` condition), but TypeScript with
 * `module: CommonJS` would down-level a literal `await import(...)` to `require(...)`, which
 * Node then rejects with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Routing through `new Function`
 * hides the import from the compiler so the emitted code performs a real dynamic import —
 * still lazy, so a Claude-only box never loads the optional dependency. (The `typeof
 * import(...)` type annotation is erased at compile time and adds no runtime load.)
 */
const importCodexSdk = new Function("return import('@openai/codex-sdk')") as () => Promise<
  typeof import("@openai/codex-sdk")
>;

/**
 * Map this repo's effort enum (low|medium|high|xhigh|max) onto Codex's
 * `modelReasoningEffort` enum (minimal|low|medium|high|xhigh): `max → xhigh`, the rest
 * pass through (issue #131 SDK facts). Codex has no `max`, so `max` clamps to its
 * deepest tier, `xhigh`.
 */
export function mapReasoningEffort(effort: string): ModelReasoningEffort {
  return effort === "max" ? "xhigh" : (effort as ModelReasoningEffort);
}

/**
 * Map a ChatGPT-account model-rejection 400 to an actionable terminal (issue #138). Under
 * ADR-0033's OAuth-only stance the Codex login is a ChatGPT subscription, which serves only
 * plain `gpt-5.x` ids and 400s every `-codex`-suffixed / API-tier id with `"The '<model>'
 * model is not supported when using Codex with a ChatGPT account."`. Raw, that surfaces as a
 * generic `executor.integrate-failed` and sends the operator log-spelunking; this re-casts
 * exactly that case to an error naming the `providers.openai.model` knob and a model that
 * works. Any other error is returned untouched (`undefined`) so the caller rethrows it as-is.
 */
export function actionableCodexModelError(err: unknown, model: string): Error | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (!/not supported when using Codex with a ChatGPT account/i.test(message)) {
    return undefined;
  }
  return new Error(
    `Codex rejected model '${model}': a ChatGPT-subscription login serves only plain ` +
      `gpt-5.x ids — the '-codex'-suffixed ids (e.g. gpt-5.5-codex) are API-tier and ` +
      `unreachable under the OAuth-only stance (ADR-0033). Set providers.openai.model to a ` +
      `ChatGPT-subscription model, e.g. gpt-5.5. (Codex SDK: ${message})`,
  );
}

/** The production {@link CodexClient}: runs one turn on the real Codex SDK. */
export class SdkCodexClient implements CodexClient {
  async run(req: CodexRunRequest): Promise<string> {
    // Lazy import: a Claude-only box never loads the optional @openai/codex-sdk.
    const { Codex } = await importCodexSdk();
    const codex = new Codex({
      ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
      // `env` REPLACES the child process env, so seed from process.env to keep PATH etc.;
      // CODEX_HOME selects the ChatGPT-subscription auth.json (the CLAUDE_CONFIG_DIR
      // analog). OAuth subscription only — no apiKey is ever set (ADR-0033).
      env: { ...process.env, CODEX_HOME: req.codexHome } as Record<string, string>,
    });
    const thread = codex.startThread({
      workingDirectory: req.workingDirectory,
      skipGitRepoCheck: true,
      model: req.model,
      modelReasoningEffort: mapReasoningEffort(req.effort),
      // `danger-full-access`, NOT `workspace-write` (issue: rebase-conflict fix). A fix
      // session resolves rebase conflicts by finishing the rebase in-session (`git add`
      // + `git rebase --continue`), and git writes its index.lock / rebase state to the
      // SHARED clone's `.git/worktrees/<name>/` — which lives OUTSIDE the worktree
      // workspace. Under `workspace-write` that path is read-only, so every conflict-
      // resolving fix escalates with "cannot create index.lock". Full access is the true
      // Codex analog of Claude's `bypassPermissions` and is bounded by the dedicated,
      // credential-free box (OPERATING.md: the box is the blast radius).
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
    });
    try {
      const turn = await thread.run(req.prompt, req.signal ? { signal: req.signal } : {});
      return turn.finalResponse;
    } catch (err) {
      // Re-cast a ChatGPT-account model-rejection 400 to an actionable error (issue #138);
      // every other failure rethrows unchanged.
      throw actionableCodexModelError(err, req.model) ?? err;
    }
  }
}
