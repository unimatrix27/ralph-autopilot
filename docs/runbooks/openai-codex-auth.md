# Runbook — authenticating the OpenAI (Codex) provider with a ChatGPT subscription

The OpenAI provider runs agent sessions through the **Codex SDK** on a **ChatGPT
subscription OAuth login** — never an API key (ADR-0033, amending ADR-0008). Codex
authenticates with a pre-cached `auth.json` under a `CODEX_HOME` directory, the direct
analog of Claude's `CLAUDE_CONFIG_DIR`. This runbook is the one-time setup to get that
credential onto the daemon box.

> **The box is the blast radius** (OPERATING.md §2). `auth.json` holds live access
> tokens — treat it exactly like the Claude OAuth login dir: never commit it, never
> paste it into an issue/PR/log, and keep it only on the dedicated, credential-free box.

## Steps

1. **Sign in on a machine with a browser.** Install Codex and log in with the ChatGPT
   subscription:

   ```bash
   codex login                 # opens a browser to the ChatGPT login
   # or, on a headless box:
   codex login --device-auth   # prints a code to enter on another device
   ```

   This writes `~/.codex/auth.json` (or `$CODEX_HOME/auth.json` if `CODEX_HOME` is set).

2. **Copy the credential onto the daemon box** into a dedicated dir, e.g. `~/.codex-ralph/`:

   ```bash
   scp ~/.codex/auth.json box:~/.codex-ralph/auth.json
   ```

   Or run `codex login --device-auth` directly on the box if it has a terminal but no browser.

3. **Point the config at it.** In `.ralph/config.yaml`, set the `CODEX_HOME` dir and route
   the agent types you want on GPT:

   ```yaml
   agent:
     types:
       review: { provider: openai }   # GPT for review
       fix:    { provider: openai }   # GPT for fixes incl. thermo Phase 2
   providers:
     openai:
       codexHome: ~/.codex-ralph      # CODEX_HOME with the ChatGPT-subscription auth.json
       model: gpt-5.5                 # ChatGPT-subscription Codex serves plain gpt-5.x ids
       # baseUrl: https://...         # optional OpenAI-compatible gateway
   ```

   > **Model ids:** a ChatGPT-subscription Codex login accepts only the plain `gpt-5.x`
   > ids (e.g. `gpt-5.5`) — **never the `-codex`-suffixed ids** (`gpt-5.5-codex`,
   > `gpt-5-codex`), which are API-tier and 400 under the OAuth-only stance (`"… not
   > supported when using Codex with a ChatGPT account."`). The default is `gpt-5.5`; if
   > you override it, use a plain id. The Codex client maps that 400 to an actionable error
   > pointing at `providers.openai.model`.

   Selecting `provider: openai` for any agent type while `providers.openai` is unset fails
   loud at load time, so a typo is caught before the daemon starts, not hours into a run.
   (`review`, `fix`, and `autoMode` run on Codex today — only `impl` on openai is not
   yet wired and fails loud at startup; see ADR-0033.)

4. **Verify** by starting the daemon and watching a review/fix session run on the OpenAI
   provider. The daemon never sets an API key — if `auth.json` is missing or expired the
   Codex turn fails; re-run step 1–2 to refresh it.

## Security notes

- `auth.json` is an OAuth credential on disk, selected by `CODEX_HOME` — the same posture
  as the Claude login dir selected by `CLAUDE_CONFIG_DIR`. It is **not** an isolation
  boundary: the box's user can read it, so adding it widens the credential blast radius by
  exactly one more subscription. Acceptable only on the dedicated, credential-free box.
- Never put the credential in `.ralph/config.yaml` — the config holds only the *path* to
  the `CODEX_HOME` dir, never the token itself (mirrors `usageLimit.subscriptions`).
- Driving a ChatGPT subscription from an automated box is an operator decision
  (risk-accepted, ADR-0033). Remove the provider by deleting the `providers.openai` block
  and any `provider: openai` overrides.
