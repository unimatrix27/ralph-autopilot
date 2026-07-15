# syntax=docker/dockerfile:1
#
# agent.Dockerfile — .NET + Angular onboarding template (ADR-0038, issue #191).
# A WORKED example for a .NET backend + Angular (nx) frontend monorepo (example-monorepo's shape).
# Copy to your target repo's `.ralph/agent.Dockerfile` and edit.
#
# L1 (toolchain): install the .NET SDK on top of the base's Node 24 (which already covers the
# Angular/nx client). The SDK channel here should match the repo's `global.json` `sdk.version`.
# L2 (deps): warm the NuGet + npm caches keyed on the manifests so the agent's fresh per-run
# clone restores fast. Full NuGet warming wants the whole *.csproj tree; this template warms the
# Angular client deps and leaves the per-run `dotnet restore` to fill the rest — tune to taste.
#
# Pin `:latest` to a released base tag once `ralph/agent-base` is versioned (ADR-0038 lifecycle).
FROM ralph/agent-base:latest

# --- L1: the .NET SDK (matches global.json; override the channel/version per your repo) ---
USER root
ARG DOTNET_CHANNEL=10.0
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_ROOT=/usr/share/dotnet \
    NUGET_PACKAGES=/home/ralph/.nuget/packages \
    PATH=/usr/share/dotnet:${PATH}
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir /usr/share/dotnet \
 && rm -f /tmp/dotnet-install.sh \
 && ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
 && dotnet --info
USER ralph

# --- optional L1: headless chromium for `mode:ui` (DESIGN §3) ---
# `mode:ui` issues verify by rendering — the agent runs `chromium --headless --screenshot=…`
# inside this image. Uncomment if this target takes `mode:ui` work; without it, a `mode:ui`
# agent escalates at the render step.
# USER root
# RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
# USER ralph

# --- L2: warm the Angular client's npm cache (keyed on its lockfile) ---
# Mirror this with a NuGet warm once you copy the *.csproj tree in; the per-run `dotnet restore`
# (L3) fills any gaps either way, so an incomplete warm only costs a slower first restore.
WORKDIR /home/ralph/.l2-cache
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --no-audit --no-fund && rm -rf node_modules
WORKDIR /home/ralph
