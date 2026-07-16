# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ralph-autopilot` is a long-lived **daemon** that autonomously implements GitHub issues
end-to-end (pick up → implement → review → fix → merge) across one or more **target
repos**. This repo is the daemon itself and is generic over targets. The daemon
drives containerized agent sessions through its configured provider backend under
`bypassPermissions`. Claude and OpenAI use local OAuth credentials; z.ai reads an
API key from an environment variable.

It models itself as a **reconciler** (the k8s pattern): every 30s it diffs **desired
state** (GitHub labels) against **actual state** (SQLite + running agents) and acts on
the difference. **GitHub is the source of truth; SQLite holds only runtime state and is
rebuildable** from GitHub on restart. There are no webhooks.

## Commands

```bash
npm run build          # tsc → dist/ (compiles the three bin entry points)
npm run typecheck      # tsc --noEmit (strict; CI gate)
npm test               # vitest run (all *.test.ts)
npm run test:watch     # vitest watch mode
npx vitest run src/core/admission.test.ts          # a single test file
npx vitest run -t "fills open slots"               # tests matching a name
```

Runtime entry points (after `npm run build`, or via the `dist/bin/*` bins):

```bash
node dist/bin/ralph-daemon.js                 # the long-lived reconciler (reads .ralph/config.yaml)
node dist/bin/ralph-daemon.js --drain         # signal a running daemon to drain + exit
node dist/bin/ralph-answer.js                 # portable GitHub-only HITL: answer escalations one at a time
```

The operator's live view is the **embedded web control plane** (an HTTP server the
daemon starts on loopback `:4280`, reached over Tailscale — see ADR-0029). The Ink
TUI (`ralph-monitor`) is retired (legacy issue 120).

There is no lint step and no separate formatter config — `typecheck` + `test` are the gates.
Config lives at `.ralph/config.yaml` (copy from `.ralph/config.example.yaml`, which documents
every knob); it is validated against the zod schema in `src/config/schema.ts` with **unknown keys
rejected**, so a typo fails loud.

## The design of record is binding

Before changing behaviour, read the relevant design doc — they are authoritative, not
background:

- **`CONTEXT.md`** — the glossary. Terms like *admission, eligibility gate, escalate,
  worklist, heal-card, completeness invariant, island, resume-not-restart* mean something
  precise here. Use these names; the `_Avoid_` lists are enforced.
- **`docs/DESIGN.md`** — the architecture of record, section by section (§1 shape, §2 gate,
  §3 execution, §4 review loop, §5 merge, §6 HITL, §9 label state machine, §9a completeness).
- **`docs/adr/`** — one decision per file with rationale (e.g. ADR-0011 design-authority,
  ADR-0012 hardcoded rubrics, ADR-0014 harness-owned merge, ADR-0016 completeness invariant).
- **`docs/OPERATING.md`** — the safety contract (below).
- **`docs/LABELING.md`** — how to label an issue to hand it to the daemon (modes,
  complexity tiers, the recipe, and which labels are daemon-owned).

Per the **design-authority rule** (ADR-0011): when implementation hits an obstacle, resolve
it *toward* what the design already committed to — do not silently substitute a different
library/architecture to route around it. If a binding decision genuinely can't be honoured,
surface it rather than drift.

## Architecture: the loop

One pass through the system, mapped to modules (all under `src/`):

1. **`daemon/reconciler.ts`** — the tick loop. Each tick: rebuild/verify state, run
   **admission**, launch the executor for picked issues, drive resumes, and run the
   **completeness pass** + **orphan sweeper**. `daemon/daemon.ts` is the composition root
   (wires the real `gh` client, worktree manager, SDK agents, executor, review loop);
   `bin/ralph-daemon.ts` is the process (config, store, logger, signal handling, drain).

2. **`core/admission.ts`** — `admit()` is one **deep, pure** module: given the injected
   `World` (in-flight test, run lookup, dependency port, open-slot count, priority labels)
   it returns a `LaunchPlan` (`picked` + `excluded` with reasons). It folds the **eligibility
   gate** (`OPEN` + `ready-for-agent` + `afk` + not `hitl` + carries a `mode:*` + all
   `## Blocked by` deps closed-and-merged — `#n`, same-repo issue URL, or `owner/repo#n`;
   a cross-repo ref fails closed), the exclusions, and the slot-capped FIFO fill.

3. **`executor/`** — per-issue execution. `worktree.ts` makes a `ralph/<n>-<slug>` git
   worktree (shared object store, isolated tree). `agent.ts` runs the Agent SDK session
   under a **wall-clock** (`wall-clock.ts`) and a **process reaper** (`process-reaper.ts`,
   SIGKILLs the whole `claude` CLI process group on overrun). `prompts.ts` builds the impl
   prompt by `mode`. `escalate-tool.ts` / `stuck-tool.ts` are the agent's two custom exits.
   `git-guardrails.ts` is a `PreToolUse` hook — **advisory, not a security boundary**.

4. **`review/review-loop.ts`** — the harness-owned, CI-gated, rebase-aware review+merge
   (ADR-0014). Order: pre-review rebase onto base → **Phase 0** CI gate (`gh pr checks`
   before review) → **Phase 1** normal review → **Phase 2** behaviour-conserving thermo →
   rebase-aware **merge** (`gh pr merge --squash`). Each phase allows ≤3 **fix attempts**;
   maxout → `review-maxed` + heal-card. **Review rubrics are hardcoded** in
   `review/prompts.ts` and target-independent (ADR-0012). `sdk-agents.ts` are the real SDK
   review/fix runners; `worklist.ts` is the deduped, severity-ranked finding list.

5. **`hitl/`** — the async escalate/heal path. An agent calls **`escalate`** (never Claude's
   built-in `AskUserQuestion`): it checkpoints WIP, posts a structured `ralph-question`
   comment, swaps `ready-for-agent → awaiting-answer`, frees the slot. `ralph-answer.ts`
   (CLI in `bin/`) serves open questions one at a time anywhere; the next tick **resumes,
   not restarts** the agent (`resume.ts`) from its WIP branch with the answer injected.

6. **`daemon/completeness.ts`** — `classifyIssueState()` is a **total, pure** function that
   sorts every open issue + non-terminal run into exactly one of
   `{eligible, in-flight, awaiting-human, terminal}`. Anything unclassifiable or
   contradictory (an **island**) is surfaced as a `daemon-anomaly` label within one tick.
   This is the **no-silent-loss** guarantee and the completion criterion for unattended
   auto-merge — it is matrix-tested in `completeness.test.ts`; keep it total.

Supporting layers: **`github/`** (`gh` CLI window — `GhCliClient`, `## Blocked by` parsing,
the `<!-- ralph-launch: … -->` PR marker, check classification), **`store/`** (`better-sqlite3`,
transactional, schema in `migrations.ts`), **`config/`**, **`log/`** (structured + secret
redaction), **`projection/`** (the pure `snapshot.ts` projection the web read API consumes — the Ink TUI that rendered it is retired, legacy issue 120), **`core/labels.ts`**
+ **`core/slug.ts`**.

## Conventions

- **Dependency injection + pure cores.** Modules take a `*Deps` interface and inject their
  world; the decision logic (`admit`, `classifyIssueState`, `buildSnapshot`, prompt builders)
  is pure so it can be exhaustively unit-tested. Match this — push side effects (gh, git, fs,
  SDK) to the edges behind an interface, keep the decision pure.
- **Tests are colocated** `*.test.ts` next to the source, run by vitest (node env). Fakes for
  the injected ports live in **`src/testing/`** (`fake-github.ts`, `fake-worktree.ts`,
  `fake-agent.ts`, `fake-review-agents.ts`) — reuse these rather than re-mocking.
- **TS is strict**: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`,
  `noImplicitOverride`. Target CommonJS / ES2022, Node ≥22. **zod v4** (ADR-0010 — do not
  downgrade). `src/index.ts` is the curated public surface; export new public API there.
- **Labels are the protocol.** State transitions are label swaps the reconciler observes next
  tick (`core/labels.ts`, `hitl/labels.ts`, `daemon/completeness.ts` `LABEL_DAEMON_ANOMALY`).
  The human-attention states are `agent-stuck`, `awaiting-answer`, `review-maxed`, and
  `daemon-anomaly`; success is *merged + issue closed* (no success label). See DESIGN §9.
- **No-deferral rule.** Agent output contracts have nowhere to record a hedge: either it
  matters → `escalate`, or it doesn't → do it. Don't add "deferred items" fields.

## Operating safety (read `docs/OPERATING.md` before running the daemon)

Agents run with `bypassPermissions`, so **the box is the blast radius**. A git worktree is
*not* an isolation boundary and `git-guardrails.ts` is *advisory* (trivially bypassable). Run
**only on a dedicated, credential-free machine** with no reachable prod secrets — the only
credentials present should be scoped GitHub access and the box's Claude OAuth login. The
daemon merges to `master` with no human in the loop; that is safe only because prod is gated
by a separate tag release (no agent triggers it) and the completeness invariant guarantees no
issue is ever silently dropped.

## Native toolchain (better-sqlite3)

`better-sqlite3` compiles a native addon and **recompiles on any Node version bump**, which
runs `node-gyp` → which needs a Python that still ships `distutils`. **System Python 3.14
removed `distutils`**, so `npm install` / rebuilds fail there. Use Python **3.13** (or point
`npm_config_python` at a 3.13 that has `setuptools`) for installs and native rebuilds. Don't
rediscover this from scratch each time.
