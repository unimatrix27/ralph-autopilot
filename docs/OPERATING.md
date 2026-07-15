# Operating ralph-autopilot safely

ralph-autopilot runs autonomous coding agents with **`bypassPermissions`** — they
execute arbitrary `Bash` (build, test, git, network) on the host with no
per-action prompt. The first two safety properties below (§1, §2) are **accepted by
design**, not bugs to be hardened away; the third (§3) is the daemon's guarantee
that makes unattended auto-merge safe. The pilot is only safe to run when all three
are respected.

If you run this daemon, you must understand them before you start it.

## 1. The git-guardrails hook is advisory, not a containment boundary

A `PreToolUse` hook ([`src/executor/git-guardrails.ts`](../src/executor/git-guardrails.ts),
DESIGN §8) inspects each `Bash` command and blocks dangerous local git ops —
force-push, branch/ref deletion, history rewrites, `reset --hard`, `clean -f`.
Its job is to stop an agent from *accidentally* destroying its own branch, a
sibling worktree, or the shared object store.

It is **not** a security boundary and **cannot** be relied on to contain a
determined or confused agent. The check is a best-effort string inspection of
the command and is trivially bypassable, e.g.:

- **command substitution** — `git push $(echo --force)`, or building the flag
  from variables, so the dangerous token never appears literally;
- **`git -C <path>` / `--git-dir` / `--work-tree`** — operating on a *different*
  repository or worktree than the one being inspected;
- **absolute paths and indirection** — invoking git via an absolute path, a
  wrapper script, a shell alias, `xargs`, `sh -c`, or any tool that isn't
  pattern-matched as `git`;
- **non-git destruction** — `rm -rf`, `find -delete`, truncation, etc., which the
  git-focused hook does not even attempt to cover.

**Treat the hook as a guardrail against mistakes, never as a wall against intent.**
The real blast-radius limiter is the box itself — see below.

## 2. The box is the blast radius — run only on a dedicated, credential-free machine

Because agents run with `bypassPermissions`
([`src/executor/agent.ts`](../src/executor/agent.ts)) and every in-flight issue
shares **one clone's object store** across git worktrees
([ADR-0002](adr/0002-worktrees.md)), there is no filesystem or privilege wall
between an agent and the host. **A git worktree is not an isolation boundary** —
it shares the object store, the filesystem, the network, and every credential
reachable from the host. Whatever the host can reach, a runaway or adversarial
agent can reach.

Therefore the blast radius is the **entire machine**, and the only real
containment is what that machine *cannot* touch. The operating requirement is:

- Run **only on a dedicated machine** used for nothing else.
- The machine must be **credential-free**: **no reachable production secrets** —
  no prod AWS credentials (Aurora / Cognito / Batch), no prod database access, no
  long-lived deploy tokens, no SSH keys into prod. AWS is deliberately
  uncredentialed; this is the biggest blast-radius limiter (DESIGN §8).
- The only credential present should be the **GitHub access** the loop needs to
  read issues and open/merge PRs, and **one or two Claude OAuth** logins on the box
  (never an API key — [ADR-0008](adr/0008-oauth-fresh-context.md)). A second login
  is optional, for dual-subscription rotation
  ([ADR-0028](adr/0028-dual-subscription-rotation.md)); it lives in its own
  `CLAUDE_CONFIG_DIR` but is **not an isolation boundary** — both credentials are
  readable by the box's user, so two logins widen the credential blast radius by
  exactly one more Claude account. If the **OpenAI (Codex) provider** is enabled
  ([ADR-0033](adr/0033-multi-provider-agent-backends.md)), the box may **also** hold a
  **ChatGPT-subscription `auth.json`** under its own `CODEX_HOME` dir (the
  `CLAUDE_CONFIG_DIR` analog) — still **OAuth subscription only, never an API key**,
  and likewise *not* an isolation boundary: it widens the blast radius by one more
  subscription. Capture and copy it per the
  [Codex auth runbook](runbooks/openai-codex-auth.md), and treat it exactly like the
  Claude login dir (never commit it, never paste it anywhere). Scope GitHub
  access to **every** configured target repo; prod is gated behind a separate tag
  release, not the merge
  ([ADR-0014](adr/0014-harness-owned-ci-gated-rebase-aware-merge.md)).
- Do **not** run on a developer workstation, a CI runner with deploy rights, or
  any host with ambient cloud credentials.

If untrusted targets ever enter scope, the clean seam to containers noted in
[ADR-0002](adr/0002-worktrees.md) must be taken first — the credential-free-box
assumption no longer holds for code you do not trust.

### Configuring the targets (multi-repo)

One daemon works a **set** of target repos
([ADR-0020](adr/0020-multi-repo-orchestration.md)). The config carries:

- **`targets: [...]`** — one entry per repo, each with its `repo` slug, its build/test
  `commands` (the gate differs per repo), and optional per-target overrides of the
  daemon-wide `agent` / `merge` / `review` / `priorityLabels` defaults (deep-merged).
  Per-target clone and worktree paths default to **`.target-repo/<owner>-<repo>`** and
  **`.wt/<owner>-<repo>`** so two targets never collide; override `target.paths` to
  place them elsewhere.
- **One global `scheduler.maxConcurrentAgents`** — the build budget shared across all
  targets (your Claude plan's total concurrent-agent ceiling), *not* per repo.
- **One shared `paths.database`** — a single SQLite file holds every repo's runtime
  state (rows carry a `repo` column).

The daemon **auto-clones** a target on startup if its clone dir is absent (via
`gh repo clone`), so adding a target to the config and restarting is enough.

**Peak concurrency** is `cap` build agents **+ up to one merge per repo** — the merge
lease is free per-repo concurrency, not counted against the build cap (DESIGN §5). When
sizing your Claude plan budget, account for that small, bounded overage.

### Cutting over to multi-repo (the v4 migration)

The first upgrade onto multi-repo runs a **v4 store migration** that **rebuilds runtime
state from GitHub**: it clears the rebuildable runtime tables and recreates `runs` with
a `repo` column (`UNIQUE(repo, issue_number)`). On the next boot each repo's
`rehydrate()` re-derives its in-flight / paused runs from open PRs (ADR-0003). So the
cutover is: **drain the daemon → upgrade → cold start.** Because the migration drops
only rebuildable state and GitHub is the source of truth, nothing is lost.

## 3. Stopping the daemon: drain cleanly, or force

Stopping the daemon is a **graceful drain** by default, not an abrupt kill. A
drain **stops starting and resuming agents** but lets the **in-flight** ones run
to completion — they finish their review and merge — and only then does the
process exit `0`, with **nothing wedged** at `running` and no orphaned PRs. This
replaces the old abrupt abort, which abandoned in-flight runs and needed manual
repair (`src/daemon/reconciler.ts` → `drainToCompletion`, legacy issue 35).

### Stop cleanly (drain)

Either of these begins a drain:

- **Signal the process**: `SIGTERM` or `SIGINT` (Ctrl-C in the foreground) —
  e.g. `kill -TERM <pid>`, or `systemctl stop` if you run it under systemd.
- **The control command**: `ralph-daemon --drain`. It reads the running daemon's
  PID file (`daemon.pid`, written next to the SQLite database — e.g.
  `.ralph/daemon.pid`) and sends it `SIGTERM`, then exits. It does **not** start a
  new daemon; run it from the same host. If no daemon is running it says so and
  exits non-zero.

On a drain the daemon logs `daemon.draining` with the issues still in flight,
stops all new pickups and resumes, waits for the in-flight runs to finish, and
exits `0` once the in-flight set empties. Paused runs (`awaiting-answer` /
`review-maxed`) are **not** resumed during a drain — they stay paused for a
human, which is a clean state, not an abandonment.

### The drain timeout (a stalled drain)

`scheduler.drainTimeoutSeconds` (default **3600**, one hour — matching the
per-agent wall-clock) bounds the wait. If an agent is genuinely hung and the
in-flight set has not emptied by the deadline, the daemon **force-exits**, logs
`daemon.drain-incomplete` with the **still-in-flight** issue numbers, and exits
non-zero so you know the stop was not clean. The per-agent wall-clock (legacy issue 13) kills
hung sessions, so reaching this timeout should be rare; raise it if your in-flight
runs legitimately need longer than an hour to finish review + merge.

### Force an immediate stop

Send a **second** `SIGTERM`/`SIGINT` while a drain is in progress (press Ctrl-C
again). The daemon stops at once, **abandoning** whatever is still in flight, logs
the still-in-flight issues, and exits non-zero. This is the abrupt path — use it
only when you cannot wait for the drain. A force-killed run is reconciled on the
next startup (DESIGN §1/§7): its review is re-driven if its PR survived, else it
is marked terminal and its worktree removed.

> The drain mechanism (`Reconciler.drainToCompletion`) is the shared core that
> self-update (legacy issue 30) builds on: legacy issue 30 drains the same way, then pulls, rebuilds, and
> relaunches instead of exiting.
## 4. The completeness invariant is the completion criterion for unattended auto-merge

The daemon merges to `master` with **no human in the loop** (DESIGN §5,
[ADR-0009](adr/0009-auto-merge.md) / [ADR-0014](adr/0014-harness-owned-ci-gated-rebase-aware-merge.md)).
That is only safe while the daemon can *guarantee* it never silently drops an
issue: with no human reading every PR before merge, an issue stranded in a state
no code path acts on would sit unnoticed indefinitely. The
**reconciler completeness invariant** (DESIGN §9a, legacy issue 27) is that guarantee, and is
the completion criterion for running unattended:

> After every reconcile tick, every open issue and every non-terminal run is
> provably exactly one of **being worked**, **awaiting a human** (on a visible
> label), or **terminal**. Anything unclassifiable or contradictory is surfaced
> within one tick as a `daemon-anomaly` label + a structured `daemon.anomaly` log —
> never a silent island.

What this means for operating the daemon:

- **`daemon-anomaly` is a human-attention state.** When the reconciler cannot
  classify an issue/run or finds a contradiction, it labels the issue
  `daemon-anomaly` and logs the reason (`grep daemon.anomaly` the log, or watch the
  web control plane's recent-outcomes panel at http://127.0.0.1:4280). The daemon advances nothing in this
  state — **a human must read the anomaly reason and repair the underlying state**
  (fix the labels/run, or close the issue). The label self-clears once the issue is
  no longer anomalous. The daemon self-creates the `daemon-anomaly` label on the
  target repo on first use, so no manual label setup is required.
- **Treat any `daemon-anomaly` as a stop-and-look.** A healthy unattended run keeps
  this set empty; a non-empty set is the daemon telling you its no-silent-loss
  guarantee found a state it could not resolve on its own.
- **The orphan / liveness sweeper** (DESIGN §9a) auto-remediates the slot-safe
  mechanical cases — a `running` row left by a crash, a non-terminal run whose issue
  closed under it, an in-flight run wedged past its lifetime ceiling, a worktree no
  live run references. These resolve without a human.
- **A wedged in-flight run is surfaced *and* auto-terminated (legacy issue 61).** If the
  per-session wall-clock fails and a run sits in flight past its lifetime ceiling
  (`scheduler.maxRunLifetimeSeconds`, default 6h), the orphan sweep actively kills it:
  it asks the executor — the single owner of the run's session-kill handle — to abort
  the run's live session, which terminalizes the run to `agent-stuck`, prunes its
  worktree, and frees the slot through that single owner once the killed session
  settles (no premature release while the session is still alive). In parallel it is
  surfaced as a `daemon-anomaly` (`reason: run-wedged-past-lifetime`) so you can see it
  while it settles, then the label self-clears — this case resolves itself. Restarting
  the daemon also reconciles orphaned `running` rows (`rehydrate` re-drives or
  terminates them) as a backstop. The *classifier* anomalies — an unclassifiable or
  contradictory state the sweeper cannot mechanically remediate — are the residue that
  needs you.

## 5. Self-update: running under the supervisor (legacy issue 30)

Self-update lets the daemon adopt new commits on its own branch — its auto-merged
fixes or your pushes — by *draining* (finishing in-flight work, starting nothing
new) and then asking a **supervisor** to pull + build + relaunch it. A Node process
cannot cleanly rebuild and re-`exec` itself, so the two concerns are split
([ADR-0018](adr/0018-self-update-supervisor.md)): the daemon detects + drains + exits
the restart code **75**; `ops/ralph-supervisor.sh` (kept alive by
`ops/ralph-supervisor.service`, `Restart=always`) does the pull + build + relaunch
**while the daemon is down**, build-gated and with rollback.

- **Off by default.** Set `selfUpdate.enabled: true` only when the daemon runs under
  the supervisor. A bare daemon that exits 75 with no supervisor simply stops — it is
  not relaunched.
- **A bad commit cannot wedge the box.** On a build-gate failure (the new commit
  fails `npm run build`) or a health-check failure (the fresh launch crash-loops
  within `RALPH_HEALTH_WINDOW`), the supervisor restores the last-good commit,
  rebuilds, relaunches last-good, and records a `daemon-anomaly` — it never relaunches
  into broken code. It also writes the failed remote sha to `.ralph/quarantine`; the
  daemon treats a remote HEAD equal to that sha as *not behind* (no re-drain) and
  clears the record the moment origin advances past it (you push a fix). So a
  persistently-failing commit parks the box at last-good and waits for a fix, with no
  drain → rebuild → rollback thrash.
- **`daemon-anomaly` here is supervisor-level**, distinct from the issue-level
  `daemon-anomaly` *label* (§4): the supervisor writes one JSON line per anomaly to
  `RALPH_ANOMALY_FILE` (default `.ralph/daemon-anomaly.log`) **and** to stderr
  (journald). Watch it with `tail -f .ralph/daemon-anomaly.log` or
  `journalctl -u ralph-supervisor -f`.
- **Inspect the quarantine** with `cat .ralph/quarantine` (a single sha; absent means
  nothing is quarantined). The matching failure is in the anomaly log.
- **A forced (timeout) restart is safe.** If an agent hangs past
  `selfUpdate.drainTimeoutSeconds` the daemon restarts anyway; startup rehydration
  re-derives in-flight runs from GitHub ([ADR-0003](adr/0003-reconciler-poll.md)), so
  nothing is abandoned.

Install steps and the full knob list live in the runbook,
[docs/SELF-UPDATE.md](SELF-UPDATE.md). As everywhere, the supervisor runs `git pull`
/ `npm ci` / `npm run build` with the daemon's privileges — **the box is the blast
radius** (§2); run only on a dedicated, credential-free machine.

## 6. Exposing the web control plane (the exposure runbook)

The daemon embeds an HTTP control plane in its own process
([ADR-0029](adr/0029-embedded-web-control-plane.md) / [0031](adr/0031-web-stack-and-contract.md) /
[0032](adr/0032-web-exposure-and-writes.md); config block `web:` in
[`.ralph/config.example.yaml`](../.ralph/config.example.yaml)). It serves the built SPA and
a read API. Because **the box is the blast radius** (§2) and the plane ships **no managed
auth by design**, *how you reach it* is a safety decision. This is the operator runbook for
that decision; the *act* of configuring Tailscale on the box is a separate human-only step.

### Default: loopback bind (do nothing)

The server binds **`127.0.0.1` by default** (`web.host`, default `127.0.0.1`; `web.port`,
default `4280`). On loopback the plane is reachable only from a process on the box itself —
nothing on the LAN or the internet can connect. **The bind host is configurable but is
never `0.0.0.0` by default**, and binding to any non-loopback address logs a loud
`web.exposure-warning` at startup ([`src/web/server/server.ts`](../src/web/server/server.ts)).
Set `web.enabled: false` to run fully headless (no server at all).

Leave `web.host` at `127.0.0.1`. To reach the UI from a laptop or phone, **do not widen the
bind** — tunnel to the loopback service instead (below). That keeps the only listening socket
on loopback, where the Origin guard plus the absence of a remote attack surface do the work.

### The Origin guard (confused-deputy hygiene)

Even on loopback a browser tab on any website can issue a cross-site `POST` to
`http://127.0.0.1:4280`. The **Origin guard** ([`src/web/server/origin-guard.ts`](../src/web/server/origin-guard.ts))
rejects unsafe-method requests (`POST`/`PUT`/`PATCH`/`DELETE`) with `403` unless the `Origin`
is same-origin (matches the request `Host`) or listed in `web.allowedOrigins`; a request with
no `Origin` (a non-browser client / the CLI) is allowed. The served SPA's own origin is always
accepted — add entries to `web.allowedOrigins` only if you front the UI from another host
(e.g. behind a reverse proxy, below). The foundations slice ships no mutating routes, so the
guard is a wired-but-idle seam today; the first write route is protected by construction.

### Reaching the UI remotely — keep the bind on loopback

Both of these reach the loopback service from elsewhere **without exposing a non-loopback
socket on the box** — the recommended posture:

- **Tailscale (`tailscale serve`)** — the intended path (ADR-0032: a single-user tailnet *is*
  the identity boundary). With the box on your tailnet, proxy the loopback port onto the
  tailnet over HTTPS, leaving `web.host` at `127.0.0.1`:

  ```bash
  tailscale serve --bg 4280          # https://<box>.<tailnet>.ts.net/ → http://127.0.0.1:4280
  tailscale serve status             # show what is being served
  tailscale serve --https=443 off    # stop serving
  ```

  (Flag spelling has shifted across Tailscale versions — confirm with `tailscale serve --help`.)
  Then open `https://<box>.<tailnet>.ts.net/` from any device signed into the same tailnet.
  Tailscale terminates TLS and authenticates by tailnet device identity; the daemon still only
  ever listens on loopback.

- **SSH tunnel** — works anywhere you already have SSH to the box, no Tailscale required:

  ```bash
  ssh -N -L 4280:127.0.0.1:4280 user@box   # then browse http://127.0.0.1:4280 locally
  ```

  The tunnel forwards your local `127.0.0.1:4280` to the box's loopback service; SSH provides
  the transport auth. Again the daemon's bind stays on loopback.

### PWA + web push need a secure context (legacy issue 119)

The control plane is an **installable PWA** with **web push**: native phone/desktop
notifications for escalations, anomalies, and a stalled daemon. Both require a **secure
context** — service workers, the Push API, and "Add to Home Screen" are disabled over plain
HTTP. The two paths above already provide one: `tailscale serve` terminates TLS (HTTPS), and
the SSH tunnel lands on `http://127.0.0.1` (localhost is treated as secure). A raw
`http://<tailnet-ip>:4280` URL does **not** — use one of the proxied paths to install or
subscribe.

To enable push, set `notifications.webpush` in `.ralph/config.yaml` and provide a VAPID
private key in an env var (the public key is derived and served to the browser
automatically):

```bash
# one-time: generate a VAPID private key and export it (the NAME goes in config)
export RALPH_VAPID_PRIVATE_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
```

```yaml
notifications:
  enabled: true          # the sink must run for the push channel to receive events
  endpoints: []          # [] is a valid push-only setup (no ntfy/webhook)
  webpush:
    enabled: true
    subject: mailto:you@example.com
    privateKeyEnv: RALPH_VAPID_PRIVATE_KEY   # NAME of the env var, never the key
```

Then open the Health page and tap **Enable notifications** on each device. Subscriptions
persist in SQLite, so they survive a daemon restart; the sink never blocks the reconcile tick
(fire-and-forget dispatch, ADR-0029).

### Binding beyond loopback ⇒ put a reverse proxy + auth in front

If you deliberately set `web.host` to a tailnet IP or `0.0.0.0`, the daemon binds a socket that
accepts connections from beyond the box and logs the `web.exposure-warning` — because **there
is nothing managed authenticating in front of it** (ADR-0032: the default deployment is
unauthenticated *by design*, safe only as loopback + tailnet on a credential-free box). Do
**not** expose a raw non-loopback bind. ADR-0032 requires, before any bind beyond loopback:

1. **A reverse proxy terminating TLS** (Caddy / nginx / Traefik / Tailscale's own proxy) in
   front of `127.0.0.1:4280` — never serve the daemon's plaintext socket directly off-box.
2. **Authentication at that proxy** — HTTP basic / OIDC / mTLS, or drop a real `AuthMiddleware`
   into the reserved auth seam ([`src/web/server/auth.ts`](../src/web/server/auth.ts), default
   allow-all). The plane has no built-in login; the proxy or the seam is where auth lives.
3. **Network reach constrained** to trusted clients — tailnet ACLs and/or a host firewall, so
   the widened bind is not actually internet-reachable.
4. **`web.allowedOrigins`** set to the proxied origin(s) so the Origin guard accepts the
   browser's same-site mutations through the proxy.

In short: loopback + a tunnel for the normal case; a TLS-terminating, authenticating reverse
proxy on a network-restricted box for the rare case you truly must bind wider. The exposure
warning and the reserved seam exist precisely so a riskier configuration is a conscious choice,
not an accident.

## See also

- [ADR-0002 — worktrees, not containers](adr/0002-worktrees.md) (the blast-radius decision)
- [ADR-0029 — embedded web control plane](adr/0029-embedded-web-control-plane.md) / [ADR-0032 — web exposure & writes](adr/0032-web-exposure-and-writes.md) (the exposure runbook, §6)
- [ADR-0016 — the reconciler completeness invariant](adr/0016-reconciler-completeness-invariant.md) (no silent loss)
- [ADR-0018 — daemon self-update](adr/0018-self-update-supervisor.md) and [SELF-UPDATE.md — the self-update runbook](SELF-UPDATE.md)
- [DESIGN.md §8 — Safety](DESIGN.md) and [§9a — the completeness invariant](DESIGN.md)
- [`src/executor/git-guardrails.ts`](../src/executor/git-guardrails.ts) (the advisory hook)
- [`src/daemon/completeness.ts`](../src/daemon/completeness.ts) (the classifier) and [`src/daemon/reconciler.ts`](../src/daemon/reconciler.ts) (the sweep + surfacing)
