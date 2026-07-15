#!/usr/bin/env node
/**
 * The `ralph-answer` CLI (DESIGN §6 / §7, ADR-0007). Portable and GitHub-only —
 * it talks to nothing but the `gh` CLI, so it runs on *any* box that can reach
 * GitHub, with no SQLite and no daemon. It serves open `awaiting-answer` /
 * `review-maxed` / `agent-stuck` (stuck-card) questions one at a time, FIFO, in a
 * forever loop: render the question, capture the operator's reply (free text, an
 * option number, or accept-recommendation), write the `ralph-answer` comment, and
 * swap the label back to `ready-for-agent`. The daemon then resumes the paused agent
 * next tick — or, for a healed `agent-stuck`, re-admits a fresh run with the guidance
 * injected (#86).
 *
 * Usage:
 *   ralph-answer --repo owner/name      (or set RALPH_TARGET_REPO)
 *   ralph-answer --repo owner/name --once
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { GhCliClient } from "../github/gh-cli";
import { RalphAnswerService } from "../hitl/ralph-answer";
import { renderQuestion } from "../hitl/render";
import type { OpenQuestionItem } from "../hitl/queue";

interface CliArgs {
  repo: string;
  once: boolean;
  pollSeconds: number;
}

function parseArgs(argv: string[]): CliArgs {
  let repo = process.env.RALPH_TARGET_REPO ?? "";
  let once = false;
  let pollSeconds = 15;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo" || arg === "-r") {
      repo = argv[++i] ?? "";
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--poll") {
      pollSeconds = Number(argv[++i] ?? "15") || 15;
    }
  }
  if (!repo) {
    throw new Error(
      "no target repo: pass --repo owner/name or set RALPH_TARGET_REPO. ralph-answer is GitHub-only and needs nothing else.",
    );
  }
  return { repo, once, pollSeconds };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const github = new GhCliClient(args.repo);
  const service = new RalphAnswerService(github);
  const rl = createInterface({ input: stdin, output: stdout });

  const prompter = async (item: OpenQuestionItem): Promise<string> => {
    stdout.write(renderQuestion(item));
    return rl.question("\nYour answer (free text · option number · empty=accept recommendation): ");
  };

  stdout.write(`ralph-answer — serving questions for ${args.repo}. Ctrl-C to stop.\n`);
  try {
    for (;;) {
      const served = await service.serveOne(prompter);
      if (served) {
        stdout.write(`\n✓ Answered #${served.issue.number}; the daemon will resume it.\n\n`);
        continue;
      }
      if (args.once) {
        stdout.write("No open questions.\n");
        return;
      }
      stdout.write(`No open questions; polling again in ${args.pollSeconds}s…\n`);
      await sleep(args.pollSeconds * 1000);
    }
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ralph-answer: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
