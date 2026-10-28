# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please do not open public GitHub issues for security problems. Use GitHub's private vulnerability reporting instead:

<https://github.com/robotbird/piwork/security/advisories/new>

Include in your report:

- the affected component or endpoint,
- steps to reproduce or a proof of concept,
- the potential impact,
- any suggested mitigation.

We aim to acknowledge reports within 7 days.

## Scope notes

- piwork executes model-driven tools (`bash`, `read`, `write`, `edit`) inside sandboxed runtimes (Docker / OpenSandbox). Reports on sandbox isolation, credential handling, and access control are especially welcome.
- Model provider credentials are stored server-side only and are never exposed to sandboxes; sandboxed runs reach models through a scoped proxy with per-run tokens.
- When self-hosting in untrusted multi-user environments without a sandbox provider, keep execution tools disabled via `PIWORK_DISABLE_EXECUTION_TOOLS`.
