#!/usr/bin/env node
/**
 * `ralph-runner` — the **in-container runner entrypoint** (ADR-0038 / issue #185, epic #182).
 * This process runs *inside* the per-target agent container; the daemon launches it via
 * {@link import("../container/docker-runner").DockerRunner}. It reads its
 * {@link ContainerDispatch} from the {@link DISPATCH_ENV_VAR} env var — its only "what to do"
 * input, so it makes **no GitHub read to learn its assignment** — fresh-clones the branch, hosts
 * the impl SDK session (the agent commits/pushes/opens its PR itself), streams telemetry to the
 * daemon, and reports a terminal result.
 *
 * **stdout is the frame pipe.** The daemon decodes the runner's stdout as newline-delimited
 * protocol frames (`transport.ts`), so this process must write **nothing else to stdout** — all
 * diagnostics go to stderr (which the daemon inherits into its own logs). Credentials are the
 * container's own mounted creds (Claude OAuth at `~/.claude`, the GitHub token in `GH_TOKEN`);
 * cred isolation is an explicit non-goal (ADR-0038) and the dedicated-box rule stays.
 *
 * Required env: {@link DISPATCH_ENV_VAR} (the dispatch JSON), `RALPH_TARGET_REPO` (the
 * `owner/repo` this container works), `GH_TOKEN` (clone/push auth). Optional: `RALPH_CONFIG_PATH`
 * (the mounted daemon config; defaults to `.ralph/config.yaml`).
 */
import { stdin, stdout, stderr } from "node:process";
import { loadConfig, resolveTargets } from "../config/load";
import { LocalPipeTransport } from "../container/transport";
import { DISPATCH_ENV_VAR } from "../container/docker-runner";
import { runContainerRunner } from "../container/runner";
import {
  createFixSessionHost,
  createGitCloner,
  createImplSessionHost,
  createReviewSessionHost,
  createRunnerEscalation,
  readContainerRoute,
} from "../container/in-container-session";
import type { ContainerDispatch } from "../container/assignment";

function fail(message: string): never {
  stderr.write(`ralph-runner: ${message}\n`);
  process.exit(1);
}

/** Parse + minimally validate the dispatch pushed in at `docker run` time. */
function readDispatch(): ContainerDispatch {
  const raw = process.env[DISPATCH_ENV_VAR];
  if (!raw) {
    fail(`${DISPATCH_ENV_VAR} is unset — the daemon must push the dispatch in at docker run`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`${DISPATCH_ENV_VAR} is not valid JSON: ${String(err)}`);
  }
  const d = parsed as ContainerDispatch;
  if (!d?.assignment?.prompt || !d.assignment.branch || !d.assignment.base || !d.token?.value) {
    fail(`${DISPATCH_ENV_VAR} is missing required assignment/token fields`);
  }
  return d;
}

async function main(): Promise<void> {
  const dispatch = readDispatch();

  const repo = process.env.RALPH_TARGET_REPO;
  if (!repo) {
    fail("RALPH_TARGET_REPO is unset — the container does not know which repo it works");
  }
  const token = process.env.GH_TOKEN;
  if (!token) {
    fail("GH_TOKEN is unset — the runner cannot clone or push without the GitHub token");
  }

  const configPath = process.env.RALPH_CONFIG_PATH ?? ".ralph/config.yaml";
  const target = resolveTargets(loadConfig(configPath)).find((t) => t.targetRepo === repo);
  if (!target) {
    fail(`no target '${repo}' in ${configPath} — mount the daemon config into the container`);
  }

  // The resolved route the daemon injected (ADR-0037 / issue #220): provider + model. The session
  // hosts instantiate the matching SessionBackend from it — fail loud if it is absent (the daemon
  // always injects it; no box-default fallback).
  const route = readContainerRoute((name) => process.env[name]);

  // stdout = runner→daemon frames; stdin = daemon→runner control frames (best-effort).
  const transport = new LocalPipeTransport({ inbound: stdin, outbound: stdout });

  stderr.write(`ralph-runner: starting issue #${dispatch.assignment.issueNumber} on ${repo} (${route.provider}${route.model ? `/${route.model}` : ""})\n`);
  await runContainerRunner(
    {
      cloner: createGitCloner({ repo, token }),
      session: createImplSessionHost(target, route),
      // The review-loop's review + fix passes (#189): a `kind: "review"`/`"fix"` assignment is
      // hosted by these instead of the impl session — the agent's fix pushes runner-direct, and
      // the review's worklist is relayed back to the daemon's (unchanged) review loop.
      reviewSession: createReviewSessionHost(target, route),
      fixSession: createFixSessionHost(target, route),
      transport,
      // `escalate` lands runner-direct (#187): push WIP + post the ralph-question straight to
      // GitHub via the container's own mounted git/gh, so the question survives a dead pipe.
      escalation: createRunnerEscalation({ repo, token }),
    },
    dispatch,
  );
  await transport.close();
}

main().catch((err) => fail(String(err)));
