/**
 * The **master harness invariants** (ADR-0041, DESIGN §13). The master is deliberately the
 * most capable agent in the system — it may read and edit the exclusive WIP worktree, run
 * commands and tests, commit and push the issue branch, and inspect GitHub/CI. Capability is
 * the point; a master that could only talk would be a slower human question.
 *
 * What it may **not** do is bypass the harness. Four invariants are non-negotiable, and they
 * are non-negotiable precisely *because* the master is the strongest model: an agent smart
 * enough to argue itself into merging its own repair is the one that most needs a mechanical
 * stop.
 *
 *   1. **No direct merge or issue close.** Repaired work re-enters the ordinary CI/review/
 *      merge pipeline (ADR-0014 keeps the merge harness-owned; the master is not the harness).
 *   2. **No CI bypass.** No admin merge, no required-check override, no `--skip-checks`.
 *   3. **No destructive or history-rewriting git, and only the issue's own branch.** A push
 *      to any other ref is out of scope by construction — the master owns one issue.
 *   4. **No host or supervisor control.** systemd, docker, the daemon process, the
 *      quarantine file: the master runs *inside* the system it is repairing and must never
 *      reach outside it.
 *
 * Enforcement is a pure function ({@link inspectMasterCommand}) layered *over* the existing
 * {@link import("../executor/git-guardrails").inspectBashCommand} — it never re-implements
 * the shared git rules, it adds the master-specific ones. Advisory in the same sense as the
 * git guardrails (DESIGN §8): a hook, not a security boundary. The real boundary is that the
 * merge/close capabilities are simply **not wired** into a master session — the daemon holds
 * `mergePullRequest` / `closeIssue` and never hands them over.
 */

import type { HookCallback, HookCallbackMatcher, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { inspectBashCommand } from "../executor/git-guardrails";

/** The SDK hook matcher: master guardrails, like the git ones, inspect `Bash`. */
export const MASTER_GUARDRAILS_MATCHER = "Bash";

/** Which invariant a blocked command would have broken — the vocabulary tests pin. */
export type MasterInvariant = "no-merge-or-close" | "no-ci-bypass" | "no-destructive-git" | "no-host-control";

export interface MasterGuardrailVerdict {
  blocked: boolean;
  /** The invariant broken, present exactly when `blocked`. */
  invariant?: MasterInvariant;
  /** Why it was blocked, surfaced to the master so it can pick a sanctioned move instead. */
  reason?: string;
}

const ALLOW: MasterGuardrailVerdict = { blocked: false };

/** Context the guardrails need: which branch this master owns. */
export interface MasterGuardrailContext {
  /** The issue's WIP branch — the ONLY ref this master may push. */
  branch: string;
}

function block(invariant: MasterInvariant, reason: string): MasterGuardrailVerdict {
  return { blocked: true, invariant, reason };
}

/** Split a compound shell command into its individual commands (mirrors git-guardrails). */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenize(segment: string): string[] {
  return segment
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Host / supervisor control surfaces the master must never touch. */
const HOST_BINARIES = new Set([
  "systemctl",
  "journalctl",
  "service",
  "docker",
  "docker-compose",
  "podman",
  "kubectl",
  "shutdown",
  "reboot",
  "halt",
  "crontab",
]);

/** Process-control binaries, blocked only when aimed at the daemon/supervisor. */
const PROCESS_BINARIES = new Set(["kill", "killall", "pkill"]);
const SUPERVISOR_TARGETS = /ralph-daemon|ralph-supervisor|ralph-autopilot|\.ralph\/quarantine/;

/** `gh` subcommand paths that merge, close, or bypass a gate. */
function inspectGhSegment(tokens: string[]): MasterGuardrailVerdict {
  const rest = tokens.slice(tokens.indexOf("gh") + 1);
  const [noun, verb] = rest;
  if (noun === "pr" && verb === "merge") {
    return block(
      "no-merge-or-close",
      "the master never merges: repaired work re-enters the harness-owned CI/review/merge pipeline (ADR-0014). " +
        "Choose `resolved-and-continue` and let the pipeline gate it.",
    );
  }
  if ((noun === "issue" || noun === "pr") && verb === "close") {
    return block(
      "no-merge-or-close",
      `the master never closes an ${noun}: a run concludes through merge or an explicit terminal outcome, ` +
        "never by the master closing the work item.",
    );
  }
  if (noun === "run" && (verb === "cancel" || verb === "delete")) {
    return block("no-ci-bypass", "cancelling/deleting a CI run bypasses the gate it exists to be — disallowed.");
  }
  if (noun === "api" && rest.some((t) => /\/merge$/.test(t))) {
    return block("no-merge-or-close", "merging through `gh api` is the same bypass as `gh pr merge` — disallowed.");
  }
  if (
    rest.some((t) =>
      ["--admin", "--auto", "--skip-checks", "--disable-auto"].includes(t),
    )
  ) {
    return block("no-ci-bypass", "`--admin` / auto-merge flags bypass required checks — disallowed.");
  }
  if (noun === "api" && rest.some((t) => /branches\/.+\/protection/.test(t))) {
    return block("no-ci-bypass", "editing branch protection removes the gate itself — disallowed.");
  }
  return ALLOW;
}

/** A `git push` may target only the master's own issue branch. */
function inspectGitPushTarget(tokens: string[], ctx: MasterGuardrailContext): MasterGuardrailVerdict {
  const gitIndex = tokens.indexOf("git");
  const rest = tokens.slice(gitIndex + 1).filter((t) => t !== "push" && !t.startsWith("-"));
  // `git push` / `git push origin` with no refspec pushes the current branch — the worktree
  // is checked out on the issue branch, so that is in scope.
  const refspecs = rest.filter((t) => t !== "origin" && t !== "upstream" && !t.includes("://"));
  for (const spec of refspecs) {
    // `local:remote` — the REMOTE half is what actually lands.
    const remote = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    const ref = remote.replace(/^refs\/heads\//, "").replace(/^\+/, "");
    if (ref !== ctx.branch) {
      return block(
        "no-destructive-git",
        `the master owns exactly one branch (\`${ctx.branch}\`); pushing \`${ref}\` is out of scope — disallowed.`,
      );
    }
  }
  return ALLOW;
}

/**
 * Inspect one (possibly compound) Bash command against the master invariants. Returns the
 * first blocking verdict, else an allow. Pure and total.
 *
 * The shared git guardrails run first, so every force-push / history-rewrite / hard-reset
 * rule the workers already obey applies here verbatim (re-implementing them would let the two
 * drift, and the master is the last agent that should have a *weaker* rule set).
 */
export function inspectMasterCommand(command: string, ctx: MasterGuardrailContext): MasterGuardrailVerdict {
  const shared = inspectBashCommand(command);
  if (shared.blocked) {
    return { blocked: true, invariant: "no-destructive-git", ...(shared.reason ? { reason: shared.reason } : {}) };
  }

  for (const segment of segments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) {
      continue;
    }
    const head = tokens[0]!;

    if (HOST_BINARIES.has(head)) {
      return block(
        "no-host-control",
        `\`${head}\` controls the host/supervisor the master runs inside — disallowed (the master repairs the ` +
          "work, never the machine).",
      );
    }
    if (PROCESS_BINARIES.has(head) && tokens.some((t) => SUPERVISOR_TARGETS.test(t))) {
      return block("no-host-control", "signalling the daemon/supervisor process is disallowed.");
    }
    if (tokens.some((t) => SUPERVISOR_TARGETS.test(t)) && ["rm", "mv", "tee", ">"].includes(head)) {
      return block("no-host-control", "writing/removing daemon or supervisor state is disallowed.");
    }
    if (tokens.includes("gh")) {
      const verdict = inspectGhSegment(tokens);
      if (verdict.blocked) {
        return verdict;
      }
    }
    if (tokens.includes("git") && tokens.includes("push")) {
      const verdict = inspectGitPushTarget(tokens, ctx);
      if (verdict.blocked) {
        return verdict;
      }
    }
  }
  return ALLOW;
}

/**
 * The daemon-held capabilities a master session is **never** handed (ADR-0041). Listed
 * explicitly so the "not wired" claim is executable rather than a comment: the session
 * builder asserts its tool surface excludes these, and the test asserts the list.
 */
export const MASTER_WITHHELD_CAPABILITIES: readonly string[] = [
  "mergePullRequest",
  "closeIssue",
  "closePullRequest",
];

/**
 * Build the master-guardrails `PreToolUse` hook. Wired into every master session alongside
 * the shared git guardrails; denies a command that would break an invariant, surfacing the
 * reason so the master picks a sanctioned resolution instead.
 */
export function createMasterGuardrailsHook(ctx: MasterGuardrailContext): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    const event = input as PreToolUseHookInput;
    if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Bash") {
      return {};
    }
    const command = (event.tool_input as { command?: unknown })?.command;
    if (typeof command !== "string") {
      return {};
    }
    const verdict = inspectMasterCommand(command, ctx);
    if (!verdict.blocked) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `master-guardrails blocked this command (${verdict.invariant}): ${verdict.reason}`,
      },
    };
  };
  return { matcher: MASTER_GUARDRAILS_MATCHER, hooks: [hook] };
}
