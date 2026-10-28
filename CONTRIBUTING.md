# Contributing to piwork

Thanks for your interest in contributing!

## Getting started

1. Fork and clone the repository.
2. Install [Node.js](https://nodejs.org) >= 22 and enable [pnpm](https://pnpm.io) (`corepack enable`).
3. `pnpm install`
4. Copy `.env.example` to `.env.local`, point `POSTGRES_URL` at a local PostgreSQL database, and set `AUTH_SECRET` (any random string).
5. `pnpm db:migrate && pnpm dev` → <http://localhost:3000>

## Development workflow

- Read [AGENTS.md](AGENTS.md) first — it defines the Pi-first workflow, directory responsibilities, and core architecture invariants.
- Before touching Pi-related code, verify the official Pi docs or source for the installed version. Do not guess Pi APIs.
- Write new code comments in **English**. Existing Chinese comments are migrated progressively — when you substantially rewrite a block, translate it.
- Keep the responsibility direction `route → RunManager → RuntimeBackend → Pi AgentSession`; the UI only consumes normalized runtime events.

## Commit messages

All commit messages are in **English** and follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- Subject in imperative mood, lowercase, no trailing period, ≤72 characters
- Body wrapped at 72 characters, explaining **what** and **why**
- Use `!` plus a `BREAKING CHANGE:` footer for behavior breaks

## Testing

Run the relevant suites before opening a pull request:

```bash
pnpm exec tsc --noEmit   # type check
pnpm test:unit           # unit tests
pnpm test:runtime        # runtime tests
pnpm test:runtime:db     # DB tests (needs local PostgreSQL)
pnpm check               # lint (Biome via Ultracite)
```

- Unit tests belong in `tests/unit/…`, E2E tests in `tests/e2e/…`, fixtures under `tests/fixtures/`.
- Never place test files inside `app/` or `lib/`.

## Pull requests

- One logical change per PR, described in English.
- Reference issues where applicable (`Closes #123`).
- Make sure the type check, lint, and every suite your change touches pass.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please do not use public issues for vulnerability reports.
