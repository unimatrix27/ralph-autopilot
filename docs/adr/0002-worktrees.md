# Isolate parallel agents with git worktrees, not containers

Each in-flight issue gets its own git worktree (`ralph/<n>-<slug>` branch) sharing
one clone's object store — cheap, fast, and enough isolation for branch + working
tree + build artifacts on a single trusted box running our own code. Containers
would give a harder filesystem/blast-radius wall but cost an image bake (.NET 10 +
node + gh + claude), credential mounting, and per-run start time we don't need
when the box holds no prod credentials anyway.

## Consequences

Agents can still run arbitrary bash (build/test) on the host; the blast radius is
the box itself. Acceptable for the pilot. A clean seam to containers is kept for
later if untrusted targets ever enter scope.

Two consequences are operator-facing safety constraints, accepted by design and
documented in [OPERATING.md](../OPERATING.md): a git worktree is **not** an
isolation boundary (the shared object store + `bypassPermissions` mean the box is
the blast radius), so the daemon must run only on a dedicated, credential-free
machine; and the git-guardrails hook is **advisory and bypassable**, not a
containment wall.
