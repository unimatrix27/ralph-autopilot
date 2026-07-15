# Security Policy

`ralph-autopilot` runs autonomous coding agents with broad permissions. Treat the
dedicated-machine requirements in [`docs/OPERATING.md`](docs/OPERATING.md) as part
of the security boundary; a worktree or container alone is not sufficient
isolation.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository so the report and any
supporting details remain confidential.

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. Reports involving leaked credentials should contain only
redacted examples; revoke the credential through its provider immediately.
