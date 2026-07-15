/**
 * The git-guardrails hook (DESIGN §8). A `PreToolUse` hook on every agent session
 * that inspects `Bash` commands and **blocks dangerous local git ops** before they
 * run — force-pushes, branch/ref deletions, history rewrites, hard resets, and
 * `clean -f`. `master` already carries server-side `non_fast_forward` + `deletion`
 * rules; this is the local complement so an agent cannot rewrite or destroy work
 * (its own branch, a sibling worktree's, or the shared object store) from inside a
 * session.
 *
 * The decision is a pure function ({@link inspectBashCommand}) so it is exhaustively
 * unit-testable; {@link createGitGuardrailsHook} wraps it in the SDK hook shape.
 */

import type { HookCallback, HookCallbackMatcher, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

/** The SDK hook matcher pattern: this hook only fires for the `Bash` tool. */
export const GIT_GUARDRAILS_MATCHER = "Bash";

export interface GitGuardrailVerdict {
  blocked: boolean;
  /** Why the command was blocked, surfaced to the agent so it can correct course. */
  reason?: string;
}

const ALLOW: GitGuardrailVerdict = { blocked: false };

/** Split a compound shell command into its individual commands. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Tokens of a single segment (whitespace-split; quotes stripped). */
function tokenize(segment: string): string[] {
  return segment
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** True if `flags` contains any of `names` (exact flag match). */
function hasFlag(rest: string[], names: string[]): boolean {
  return rest.some((t) => names.includes(t));
}

const PROTECTED_BRANCHES = ["master", "main"];

/** Decide whether one already-isolated git segment is a dangerous op. */
function inspectGitSegment(sub: string, rest: string[]): GitGuardrailVerdict {
  switch (sub) {
    case "push": {
      if (hasFlag(rest, ["--force", "-f"]) || rest.some((t) => t.startsWith("--force-with-lease"))) {
        return { blocked: true, reason: "git force-push rewrites pushed history — disallowed (use a fresh commit)." };
      }
      if (hasFlag(rest, ["--delete", "-d"]) || rest.some((t) => t.startsWith(":"))) {
        return { blocked: true, reason: "git push that deletes a remote branch is disallowed." };
      }
      if (hasFlag(rest, ["--mirror", "--all"])) {
        return { blocked: true, reason: "git push --mirror/--all can clobber every remote ref — disallowed." };
      }
      if (rest.some((t) => PROTECTED_BRANCHES.includes(t) || PROTECTED_BRANCHES.some((b) => t.endsWith(`:${b}`)))) {
        return { blocked: true, reason: "direct push to a protected branch (master/main) is disallowed." };
      }
      return ALLOW;
    }
    case "branch":
      if (hasFlag(rest, ["-D", "-d", "--delete", "--delete=force"])) {
        return { blocked: true, reason: "git branch deletion is disallowed." };
      }
      return ALLOW;
    case "reset":
      if (hasFlag(rest, ["--hard"])) {
        return { blocked: true, reason: "git reset --hard irrecoverably discards changes — disallowed." };
      }
      return ALLOW;
    case "clean":
      // Any -f (alone or bundled, e.g. -fd, -fdx) or --force makes clean destructive.
      if (rest.some((t) => t === "--force" || /^-[a-z]*f/.test(t))) {
        return { blocked: true, reason: "git clean -f irrecoverably deletes untracked files — disallowed." };
      }
      return ALLOW;
    case "checkout":
    case "switch":
      if (hasFlag(rest, ["-f", "--force"])) {
        return { blocked: true, reason: "force checkout/switch discards local changes — disallowed." };
      }
      return ALLOW;
    case "filter-branch":
    case "filter-repo":
      return { blocked: true, reason: "git history rewriting (filter-branch/filter-repo) is disallowed." };
    case "reflog":
      if (rest.includes("expire")) {
        return { blocked: true, reason: "git reflog expire removes recovery points — disallowed." };
      }
      return ALLOW;
    case "update-ref":
      if (hasFlag(rest, ["-d", "--delete"])) {
        return { blocked: true, reason: "git update-ref -d deletes a ref directly — disallowed." };
      }
      return ALLOW;
    default:
      return ALLOW;
  }
}

/**
 * Inspect a (possibly compound) Bash command for dangerous local git operations.
 * Returns the first blocking verdict found across all segments, or an allow.
 */
export function inspectBashCommand(command: string): GitGuardrailVerdict {
  for (const segment of segments(command)) {
    const tokens = tokenize(segment);
    const gitIndex = tokens.indexOf("git");
    if (gitIndex === -1) {
      continue;
    }
    // The subcommand is the first non-flag token after `git` (skip `-c key=val`).
    let i = gitIndex + 1;
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      i += 1;
      // `git -c key=val push …` carries a value token after the flag.
      if (tokens[i - 1] === "-c") {
        i += 1;
      }
    }
    const sub = tokens[i];
    if (!sub) {
      continue;
    }
    const verdict = inspectGitSegment(sub, tokens.slice(i + 1));
    if (verdict.blocked) {
      return verdict;
    }
  }
  return ALLOW;
}

/**
 * Build the git-guardrails `PreToolUse` hook (DESIGN §8). Wire it into every agent
 * session's options. It denies a dangerous git op (the SDK surfaces the reason to
 * the model so it can correct) and is a no-op for every other tool/command.
 */
export function createGitGuardrailsHook(): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    const event = input as PreToolUseHookInput;
    if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Bash") {
      return {};
    }
    const command = (event.tool_input as { command?: unknown })?.command;
    if (typeof command !== "string") {
      return {};
    }
    const verdict = inspectBashCommand(command);
    if (!verdict.blocked) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `git-guardrails blocked this command: ${verdict.reason}`,
      },
    };
  };
  return { matcher: GIT_GUARDRAILS_MATCHER, hooks: [hook] };
}
