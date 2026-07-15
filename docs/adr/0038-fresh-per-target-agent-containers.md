# Fresh per-target agent containers — a thin in-container runner, daemon-as-orchestrator, and the one ExecutionEnvironment seam

## Context

The daemon runs every agent under `bypassPermissions` directly on the box, in `ralph/*` git
**worktrees** (ADR-0002) that share the main clone's object store, the daemon's own `node_modules`,
and the host's global toolchain. Two structural problems follow:

1. **That shared environment gets shredded under the daemon (legacy issue 178).** A restart / rebuild /
   self-update (ADR-0018) emptied the live checkout's `node_modules` and damaged `.wt/` worktrees
   while the daemon kept ticking on in-memory modules — silently sticking in-flight runs across
   *both* repos: a hollow "success" that pushed no branch, a missing Codex CLI binary, a worktree
   lost mid-run whose turns of work opened no PR. Work was lost; a human re-admitted each issue by
   hand. The shipped daemon-side completeness gate (`ops/verify-deps.sh`, `c383881`) stops the
   *daemon* from running degraded, but it does nothing to isolate the *agents* — they still run on
   the same mutable substrate the daemon is restarting.

2. **A shared host cannot be reproducible across heterogeneous targets.** The daemon is generic over
   targets (ADR-0020) — today this repo (TypeScript/Node) and `acme/example-monorepo`
   (.NET + Angular). A shared host holds one global, drifting toolchain version; a fresh clone of
   the .NET repo still depends on whatever .NET the box happens to have installed. Per-target
   reproducibility is impossible on a shared host, and a .NET target cannot be worked in-process at
   all.

The operator wants a single guarantee that cures both: **every run starts from a completely fresh,
clean, isolated environment — filesystem, deps, and toolchain.** This is a *freshness /
reproducibility* requirement, **not** a security boundary against the agent — the sandbox
legitimately holds the agent's own credentials, and the dedicated-box / blast-radius rule (ADR-0008,
`OPERATING.md`) stays. Kernel-isolation techniques (microVM / Firecracker / gVisor) are therefore out
of scope: they buy security, which is not the goal.

This decision is the design of record for legacy epic 182 (the container rollout), triggered by legacy issue 178. It
amends ADR-0018 (image lifecycle) and relates ADR-0008, ADR-0014, ADR-0016, ADR-0030, ADR-0033.
Grabbable work is the vertical slices legacy issue 183–legacy issue 195, parented to legacy issue 182; the slices are ordered for a
strangler migration (ADR-0025).

## Decision

Run **each agent execution in a fresh, ephemeral, per-target Docker container** built from layered
images, with a **thin in-container runner** that hosts the SDK session. The **daemon shrinks to an
orchestrator**: admission (DESIGN §2) stays the deep, pure core; instead of running the SDK
in-process it `docker run`s the target image, streams telemetry back over a best-effort pipe, and
observes results through the same GitHub side effects it already uses. The whole legacy issue 178 failure family
becomes *structurally impossible* for agents — there is no shared, mutable environment left to
shred — and every target gets a reproducible, pinned toolchain.

### One execution seam — `ExecutionEnvironment`

The shared impl/resume/review/fix/moding execution chokepoint — `runReapedWallClockedSession`, the
one session-runner every Claude-SDK-backed agent type flows through (ADR-0035, the session-drive
primitive) — is a **port**: `ExecutionEnvironment`, "run one agent session to completion". Its sole
implementation is **`ContainerExecution`**: it `docker run`s the target image with the assignment +
per-run token pushed in at dispatch, maps the streamed pipe frames into the store, `docker kill`s on
abort, and tears the container down at the end. (The port was introduced alongside a second,
behaviour-preserving `InProcessExecution` impl to migrate *off* the old in-process model; in-process
has since been retired — legacy issue 227 — leaving one impl.)

The transcript sink (ADR-0030), the wall-clock ceiling, the process-group reaper, the in-session
`escalate`/`stuck` tools, and the git-guardrails hook live **inside the runner**, not in the daemon.
All agent types containerize through this one seam. `CodexSessionBackend` is a separate session
backend (ADR-0033) that shells the `codex` CLI outside the Claude SDK primitive; it containerizes
through the same runner substrate.

### Layered per-target images (L0→L3)

- **L0 — `ralph/agent-base`** (ralph-shipped): Node + the `claude`/`codex` CLIs + the thin runner.
  Versioned by ralph release; a new release is adopted under **operator control**, never auto-pulled
  mid-fleet. Base direction is **ralph-base-up** only — the target never supplies the base.
- **L1 — target toolchain** (target repo owns): `FROM ralph/agent-base:<ver>` + the target's
  toolchain (.NET SDK, Node, Python, …). Authored from a template.
- **L2 — deps** (target repo owns): baked and cached, cache key = the declared `depManifests`. So
  `node_modules` / `obj` are immutable for a run — an in-flight agent can never lose them mid-run.
- **L3 — code**: a **fresh clone at run start**, never baked. This is the freshness guarantee: the
  filesystem, deps, and toolchain are all clean and pinned for every run.

### The thin in-container runner

A new component shipped in `ralph/agent-base`. Per run it:

- reads its **assignment** (issue, mode, branch, base, prompt, injected answer) + a **per-run token**
  handed to it at dispatch — it never reads GitHub to learn *what* to do;
- drives a `SessionBackend` (the existing provider seam, ADR-0033, now running *inside* the
  container) — hosting the SDK session, the escalate/stuck tools, git-guardrails, and transcript
  capture;
- performs **git + PR + `escalate` directly** against GitHub, so its work product lands independent
  of the pipe;
- streams transcript + lifecycle **telemetry** to the daemon over the pipe;
- honours an **abort/drain** control signal, with `docker kill` as the backstop.

**Resume-not-restart in a container** (DESIGN §6 / ADR-0004): clone the **WIP branch** (not base) and
re-inject the question + answer, so an escalation answered via `ralph-answer` continues the work
rather than restarting. An escalation is posted to GitHub **directly by the runner**, so a blocked
agent's question survives even if the pipe is down.

### Daemon as orchestrator

Admission (DESIGN §2) stays the deep, pure core — pick-order and the eligibility gate are exactly as
today. The daemon:

- dispatches by `docker run`-ing the target image with the assignment baked in;
- stays the **sole writer** of the transcript/run event store (ADR-0030), mapping pipe telemetry
  into SQLite — so the live web control plane keeps working from one consistent source;
- keeps owning **labels, the CI gate, and the squash-merge** (ADR-0014) — the control plane is
  unchanged;
- aborts with the graceful-then-hard `docker stop -t <N>` (SIGTERM, grace period, then SIGKILL —
  the real Docker flag for a timed kill) and tears the container down at end-of-run; the orphan
  sweeper runs a "kill containers with no live run" pass each tick, enumerating the running
  `ralph-*` fleet via `docker ps` so a daemon crash / lost run row that strands a container is
  reaped without relying on in-memory state (legacy issue 219).

### Transport-agnostic pipe (best-effort, never load-bearing)

The daemon↔runner channel is a best-effort **telemetry + control** pipe; **correctness never depends
on it** — GitHub remains the source of truth, so the completeness invariant (ADR-0016) holds either
way. A dropped pipe degrades to "less live", never to "lost work": the runner's work still lands via
GitHub side effects.

- **The protocol is a pure, versioned frame codec**: runner→daemon `telemetry` (transcript message,
  lifecycle event) and `result` (terminal: pr-opened / escalated / stuck / failed); daemon→runner
  `control` (abort, drain). Version skew is explicit and unit-testable (frames round-trip; a
  mismatch fails loud).
- **A `Transport` interface** with a functionally-complete **`LocalPipeTransport`** first; a future
  `DialBackSocketTransport` (the CI-runner pattern, for worker fleets) slots in unchanged.

### The boundary split

- **Runner-direct:** git + work outputs — clone/fetch/push, open the PR, post `escalate`.
- **Daemon-direct:** the control plane — labels, CI gate, merge, admission, reconcile.
- **The pipe:** best-effort telemetry + control, never load-bearing for correctness.

### Onboarding contract (in the target repo)

A target opts in by carrying `.ralph/agent.*` — **distinct from the daemon's per-deployment
`.ralph/config.yaml`**:

- **`.ralph/agent.yaml`** — `build`, `test`, `restore` commands; `depManifests: string[]`;
  `baseBranch`. Validated with the same strict-zod discipline as `src/config/schema.ts` (ADR-0010:
  unknown keys rejected, missing required fails loud). Versioned with the code so it evolves with
  the codebase, not in the daemon's config.
- **`.ralph/agent.Dockerfile`** — `FROM ralph/agent-base:<ver>` + the target toolchain.
- **`.dockerignore`**.

A **`ralph onboard` Claude skill** detects the toolchain, scaffolds the `.ralph/` files from
templates, builds the image, and **smoke-tests** it (clone → `restore` → run `test` in-container).
The smoke-test is the **onboarding acceptance gate**: a misconfigured repo fails at onboarding, not
mid-run.

### Container is the only execution model

- **Every target runs in a fresh per-target container.** There is no in-process alternative: the
  composition root builds `ContainerExecution` unconditionally. The migration `executionMode` knob is
  retired — accepted-and-ignored for config back-compat only (legacy issue 227); there is nothing to switch to,
  and no rollback-to-in-process.
- **The daemon never autonomously changes its own execution substrate.** A target becomes
  agent-eligible only after a passing onboarding smoke-test, and **base-image releases are adopted
  under operator control** (never auto-pulled mid-fleet).

> History: the container model landed via a strangler (ADR-0025) — the seam shipped behind an
> `executionMode: in-process | container` switch (default `in-process`); the .NET target migrated
> first (it cannot run in-process at all); legacy issue 195 flipped the default to `container`; legacy issue 227 removed the
> in-process path entirely. Procedure for onboarding / refreshing a target image:
> [`docs/runbooks/container-flip.md`](../runbooks/container-flip.md).

### Credentials are mounted, not brokered

The Claude OAuth dir, Codex `CODEX_HOME` auth.json, the GitHub token, and the z.ai `.env` key are
**mounted into the container**. There is no credential broker. Credential isolation / blast-radius
hardening (egress proxy, short-lived scoped tokens, daemon-proxied GitHub) is an **explicit
non-goal**; the container holds its own creds by design, and the dedicated-box rule (ADR-0008 /
`OPERATING.md` §2) stays.

## Consequences

- **The legacy issue 178 failure family becomes structurally impossible for agents.** There is no shared,
  mutable environment left to shred: a daemon restart/rebuild/self-update cannot touch a live run,
  because the run's filesystem, deps, and toolchain are immutable for its lifetime and torn down
  after. A wall-clock overrun is `docker kill`, reaping the whole process tree.
- **Per-target reproducibility.** Each target runs in its own pinned toolchain image; a .NET repo
  builds and tests with the real .NET SDK, a Node repo with the real Node. Adding a target in any
  language is onboarding, not a daemon change.
- **One seam to test.** `ExecutionEnvironment` orchestration is tested behind a **fake transport**
  + the existing `src/testing/` fakes (`fake-github`, `fake-worktree`, `fake-agent`,
  `fake-review-agents`): dispatch → telemetry-to-store → abort → terminal-result-observed-via-GitHub.
  The pipe protocol is a pure encode/decode unit. The in-container runner is unit-tested against a
  scripted `SessionBackend` fake. **No real images or containers run in ralph's unit
  suite** — image builds and the onboarding skill are infra; their acceptance test is the
  smoke-test, run at onboarding / the target's CI, not here.
- **Operational cost.** The box gains a docker dependency and an image build/publish/refresh
  burden; runbooks (slice legacy issue 194) carry provisioning, onboarding both shipped repos, auth wiring,
  flip-to-container, image refresh, and incident recovery / rollback.
- **Container is the only execution path** (in-process retired, legacy issue 227); `verify-deps.sh` keeps
  guarding the *daemon's* own deps.

## Amends / relates

- **Amends ADR-0018** (self-update): adds an image lifecycle — L0 `ralph/agent-base` versioned by
  ralph release and adopted under operator control; L1/L2 rebuilt on `.ralph/` / manifest change;
  the daemon-side `verify-deps.sh` gate stays for the daemon's own deps.
- **Relates** ADR-0008 (OAuth / blast-radius — unchanged; creds mounted, dedicated-box rule stays),
  ADR-0014 (harness-owned merge — daemon keeps the control plane), ADR-0016 (completeness
  invariant — the pipe is best-effort so it holds either way), ADR-0030 (daemon-owned transcripts —
  daemon stays sole store writer), ADR-0033 (the `SessionBackend` provider seam, now hosted inside
  the container), ADR-0035 (the `runReapedWallClockedSession` primitive this seam wraps).

## Out of scope (parked / non-goals)

- **Credential isolation / blast-radius hardening** — egress proxy, credential broker, short-lived
  scoped tokens, daemon-proxied GitHub. Explicit non-goal; the container holds its own creds and the
  dedicated-box rule stays.
- **microVM / Firecracker / gVisor** — kernel isolation buys only security, which is not the goal.
- **The dial-back runner-client socket transport** and **multi-host / cloud worker fleets** —
  deferred behind the `Transport` abstraction; `LocalPipeTransport` ships first.
- **Warm runner pools** — conflicts with "completely fresh".
- **Reusing a target's own CI image as the base (target-CI-down)** — deferred alternate template.
- **Auto-adopting new base images mid-fleet** — base-image adoption stays under operator control.
- **Open items deferred to slice design (not blocking):** docker-in-docker vs host-socket if the
  daemon is itself containerized; image registry choice (local vs remote); per-container resource
  limits; concurrency ceiling vs the existing open-slot budget.
