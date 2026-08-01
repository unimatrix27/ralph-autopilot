import { describe, expect, it } from "vitest";
import {
  inspectMasterCommand,
  MASTER_WITHHELD_CAPABILITIES,
  type MasterGuardrailContext,
} from "./guardrails";

const ctx: MasterGuardrailContext = { branch: "ralph/42-master" };
const inspect = (cmd: string) => inspectMasterCommand(cmd, ctx);

describe("master harness invariants (ADR-0041)", () => {
  describe("what the master MAY do (capability is the point)", () => {
    it.each([
      "npm run typecheck",
      "npm test -- src/master",
      "git add -A",
      'git commit -m "fix(master): repair the failing assertion"',
      "git push origin ralph/42-master",
      "git push",
      "git push -u origin ralph/42-master",
      "git push origin HEAD:ralph/42-master",
      "gh pr view 12 --json body",
      "gh pr checks 12",
      "gh run view 99 --log-failed",
      "gh issue comment 42 --body-file /tmp/note.md",
      "cat src/foo.ts",
    ])("allows %s", (cmd) => {
      expect(inspect(cmd)).toEqual({ blocked: false });
    });
  });

  describe("no direct merge or issue close", () => {
    it.each(["gh pr merge 12 --squash", "gh pr merge --auto 12", "gh issue close 42", "gh pr close 12"])(
      "blocks %s",
      (cmd) => {
        expect(inspect(cmd)).toMatchObject({ blocked: true, invariant: "no-merge-or-close" });
      },
    );

    it("blocks merging through the raw API", () => {
      expect(inspect("gh api --method PUT repos/o/r/pulls/12/merge")).toMatchObject({
        blocked: true,
        invariant: "no-merge-or-close",
      });
    });
  });

  describe("no CI bypass", () => {
    it.each([
      "gh pr merge 12 --admin",
      "gh run cancel 991",
      "gh run delete 991",
      "gh api --method DELETE repos/o/r/branches/master/protection",
    ])("blocks %s", (cmd) => {
      expect(inspect(cmd).blocked).toBe(true);
      expect(["no-ci-bypass", "no-merge-or-close"]).toContain(inspect(cmd).invariant);
    });
  });

  describe("no force-push / destructive git", () => {
    it.each([
      "git push --force origin ralph/42-master",
      "git push --force-with-lease",
      "git push origin :ralph/42-master",
      "git reset --hard HEAD~3",
      "git clean -fdx",
      "git branch -D ralph/41-other",
      "git filter-branch --tree-filter true HEAD",
      "git update-ref -d refs/heads/ralph/42-master",
    ])("blocks %s", (cmd) => {
      expect(inspect(cmd)).toMatchObject({ blocked: true, invariant: "no-destructive-git" });
    });
  });

  describe("only the issue's own branch", () => {
    it("blocks a push to an unrelated branch", () => {
      expect(inspect("git push origin ralph/41-other")).toMatchObject({
        blocked: true,
        invariant: "no-destructive-git",
      });
    });

    it("blocks a push to master through a refspec", () => {
      expect(inspect("git push origin HEAD:master")).toMatchObject({ blocked: true });
    });

    it("blocks a push whose remote half is another branch even when the local half is ours", () => {
      expect(inspect("git push origin ralph/42-master:release")).toMatchObject({
        blocked: true,
        invariant: "no-destructive-git",
      });
    });
  });

  describe("no host or supervisor control", () => {
    it.each([
      "systemctl restart ralph",
      "journalctl -u ralph -n 100",
      "docker kill ralph-agent",
      "kubectl delete pod ralph",
      "reboot",
      "crontab -e",
      "pkill -f ralph-daemon",
      "rm ~/.ralph/quarantine",
    ])("blocks %s", (cmd) => {
      expect(inspect(cmd)).toMatchObject({ blocked: true, invariant: "no-host-control" });
    });

    it("allows an ordinary kill of a test subprocess", () => {
      expect(inspect("kill -9 4242")).toEqual({ blocked: false });
    });
  });

  it("blocks the first offending segment of a compound command", () => {
    const verdict = inspect("npm test && gh pr merge 12 --squash");
    expect(verdict).toMatchObject({ blocked: true, invariant: "no-merge-or-close" });
  });

  it("never hands the master the daemon-held merge/close capabilities", () => {
    expect(MASTER_WITHHELD_CAPABILITIES).toEqual(["mergePullRequest", "closeIssue", "closePullRequest"]);
  });
});
