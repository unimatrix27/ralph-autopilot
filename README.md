# ralph-autopilot

A locally-running, always-on daemon that autonomously implements GitHub issues
end-to-end — pick up → implement → review → fix → merge — across one or more
target repositories. The local-machine successor to
[`ralph-harness`](https://github.com/unimatrix27/ralph-harness) runs many issues
in parallel on one box, driven by a long-lived reconciler.

**Status:** experimental and actively developed. Configuration and operational
contracts may still change. See [`docs/DESIGN.md`](docs/DESIGN.md) for the
architecture, [`CONTEXT.md`](CONTEXT.md) for the language, and
[`docs/adr/`](docs/adr/) for the decisions and their rationale.

> ⚠️ **Before you run this:** agents execute with `bypassPermissions`, so the box
> is the blast radius and the git-guardrails hook is advisory, not a containment
> boundary. Read [`docs/OPERATING.md`](docs/OPERATING.md) — run **only** on a
> dedicated, credential-free machine with no reachable prod secrets.

Targets are configured independently in `.ralph/config.yaml`; the checked-in
example uses placeholder repositories and contains no credentials.

## Getting started

Prerequisites: Node.js 22 or newer, Docker, an authenticated `gh` CLI, and at
least one supported agent-provider login. Read the dedicated-box safety contract
in [`docs/OPERATING.md`](docs/OPERATING.md) before running anything.

```bash
npm ci
cp .ralph/config.example.yaml .ralph/config.yaml
# Edit targets and provider settings in .ralph/config.yaml.
npm run build
node dist/bin/ralph-daemon.js
```

Before the first dispatch, onboard each target using
[`docs/runbooks/container-onboarding.md`](docs/runbooks/container-onboarding.md).

## The loop, in one picture

```
reconcile tick (30s) ── eligible issue? (open + ready-for-agent + afk + !hitl + unblocked)
   │  fill open slots up to cap (default 5), FIFO by age + priority
   ▼
worktree on ralph/<n>-<slug>  →  impl agent (mode:tdd | mode:infra, fresh context, no memory MCP)
   │                                   ├─ escalate  → checkpoint WIP, master-triage, free slot
   │                                   └─ stuck     → checkpoint WIP, master-triage, free slot
   ▼ PR opened (Closes #n)
Phase 0 — CI gate   (await `gh pr checks` green BEFORE review; red → fix the checks, re-await)
   │  ≤3 fix attempts; maxout/timeout → master-triage (ci), STOP
   ▼ green / no checks
Phase 1 — normal review   (correctness/security/spec/tests; ingests bot comments)
   │  ≤3 fix attempts; maxout → master-triage (review-maxed), STOP
   ▼ clean
Phase 2 — behaviour-conserving thermo   (structural / thermo-nuclear)
   │  ≤3 fix attempts; maxout → master-triage (review-maxed)
   ▼ clean
daemon  rebase onto base (re-await CI if moved; conflicts → fix, else master-triage)
        →  hosted-review gate (unresolved Codex threads block; findings → fix)
        →  gh pr merge <pr> --squash --delete-branch  →  issue closes  →  slot frees
```

No failure pages a human directly. Every issue-scoped failure is adjudicated by a
fresh top-tier **master** session first, and only its `ask-human` outcome reaches
you — durable in GitHub, answered out-of-band:

```
every issue-scoped failure — escalate · stuck · phase maxout · ci · rebase · merge ·
hosted-review · wedged session · issue anomaly
   │
   ▼
master-triage  ──►  a fresh tier-1 master session adjudicates (≤2 per run phase)
   │
   ├─ resolved · redispatch · retry  →  back into the loop; nothing pages you
   ├─ ask-human                      →  awaiting-answer + one ralph-question
   │                                    └─ ralph-answer CLI (anywhere, one at a
   │                                       time) → daemon resumes the MASTER
   └─ terminal-stuck                 →  agent-stuck; only a completed master
                                        adjudication selects it, and it is NOT
                                        answerable through ralph-answer
```

## Components

| Component | What it is |
| --- | --- |
| **daemon** | long-lived reconciler: polls GitHub every 30s, schedules agents up to the cap, drives the CI gate + review loop + rebase-aware merge; each tick proves the no-silent-loss completeness invariant (an issue-scoped island → master triage, an unclassifiable or host-wide one → `daemon-anomaly`) and sweeps orphaned runs/worktrees ([ADR-0016](docs/adr/0016-reconciler-completeness-invariant.md), [ADR-0042](docs/adr/0042-master-triage-cutover.md)) |
| **executor** | per-issue git worktree + an Agent SDK session; enforces the wall-clock ceiling and the stuck budget |
| **web control plane** | an embedded HTTP server (loopback `:4280`, reached over Tailscale) serving a built SPA: live agent activity, run history + transcript viewer, and the HITL inbox — a read-only projection over SQLite (the Ink TUI is retired, legacy issue 120; [ADR-0029](docs/adr/0029-embedded-web-control-plane.md)) |
| **`ralph-answer` CLI** | portable, GitHub-only; serves the master's open questions one at a time and writes answers back as comments — the answer resumes the **master**, not the worker |
| **SQLite store** | runtime state (fix-attempt counters, resume context, run log); rebuildable from GitHub on restart |

## Language

`TypeScript` / Node. Agent sessions can run through Claude, OpenAI Codex, or an
Anthropic-compatible z.ai backend. Claude and Codex use local OAuth credentials;
z.ai reads its API key from an environment variable. See
[ADR-0001](docs/adr/0001-typescript.md) and the provider ADRs under
[`docs/adr/`](docs/adr/).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
