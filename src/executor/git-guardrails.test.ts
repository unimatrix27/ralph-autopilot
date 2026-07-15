import { describe, expect, it } from "vitest";
import {
  GIT_GUARDRAILS_MATCHER,
  createGitGuardrailsHook,
  inspectBashCommand,
} from "./git-guardrails";

/** Build a PreToolUse hook input for a Bash command. */
function bashInput(command: string) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "t1",
    session_id: "s1",
    transcript_path: "/dev/null",
    cwd: "/wt",
  };
}

describe("inspectBashCommand — dangerous local git ops (AC3)", () => {
  const blocked = [
    "git push --force origin ralph/6-x",
    "git push -f origin ralph/6-x",
    "git push --force-with-lease origin ralph/6-x",
    "git push origin --delete ralph/6-x",
    "git push origin :ralph/6-x",
    "git push --mirror origin",
    "git push --all origin",
    "git push origin master",
    "git push origin HEAD:main",
    "git branch -D ralph/6-x",
    "git branch -d ralph/6-x",
    "git branch --delete ralph/6-x",
    "git reset --hard origin/master",
    "git reset --hard HEAD~3",
    "git clean -fd",
    "git clean -fdx",
    "git clean --force",
    "git checkout -f master",
    "git checkout --force .",
    "git switch -f master",
    "git filter-branch --tree-filter rm -rf .",
    "git filter-repo --invert-paths",
    "git reflog expire --expire=now --all",
    "git update-ref -d refs/heads/master",
  ];

  it.each(blocked)("blocks: %s", (command) => {
    const verdict = inspectBashCommand(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBeTruthy();
  });

  const allowed = [
    "git push origin ralph/6-x",
    "git push -u origin ralph/6-x",
    "git status",
    "git add -A",
    "git commit -m 'wip'",
    "git checkout ralph/6-x",
    "git switch ralph/6-x",
    "git fetch origin",
    "git rebase origin/master",
    "git diff --stat",
    "git log --oneline",
    "npm run build && npm test",
    "ls -la",
  ];

  it.each(allowed)("allows: %s", (command) => {
    expect(inspectBashCommand(command).blocked).toBe(false);
  });

  it("inspects every segment of a compound command", () => {
    expect(inspectBashCommand("npm test && git push --force origin ralph/6-x").blocked).toBe(true);
    expect(inspectBashCommand("git add -A; git reset --hard HEAD").blocked).toBe(true);
    expect(inspectBashCommand("git add -A && git commit -m ok && git push origin ralph/6-x").blocked).toBe(false);
  });
});

describe("createGitGuardrailsHook", () => {
  it("matches the Bash tool", () => {
    const matcher = createGitGuardrailsHook();
    expect(matcher.matcher).toBe(GIT_GUARDRAILS_MATCHER);
    expect(matcher.hooks).toHaveLength(1);
  });

  it("denies a dangerous git op in an agent session", async () => {
    const hook = createGitGuardrailsHook().hooks[0]!;
    const out = await hook(bashInput("git push --force origin ralph/6-x") as never, "t1", {
      signal: new AbortController().signal,
    });
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
  });

  it("allows a safe git op", async () => {
    const hook = createGitGuardrailsHook().hooks[0]!;
    const out = await hook(bashInput("git push origin ralph/6-x") as never, "t1", {
      signal: new AbortController().signal,
    });
    expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).not.toBe(
      "deny",
    );
  });

  it("ignores non-Bash tools", async () => {
    const hook = createGitGuardrailsHook().hooks[0]!;
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/etc/passwd" },
        tool_use_id: "t1",
        session_id: "s1",
        transcript_path: "/dev/null",
        cwd: "/wt",
      } as never,
      "t1",
      { signal: new AbortController().signal },
    );
    expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).not.toBe(
      "deny",
    );
  });
});
