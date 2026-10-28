# Repository Rules

## Pi-first development (mandatory)

piwork is built on [Pi Agent](https://github.com/earendil-works/pi). Before implementing any feature, fix, or refactor, first understand the official Pi usage for the capability involved — never implement from memory, assumptions, or third-party examples.

1. Identify the Pi packages, modules, APIs, and extension points involved. All `@earendil-works/pi-*` packages are pinned to the same version (see `package.json` and the lockfile); the `docker/pi-runtime` image is rebuilt in sync.
2. Check the official docs (<https://pi.dev/docs/latest>) for the relevant guide and SDK reference. When docs are incomplete, ambiguous, or possibly version-mismatched, verify against the official repository source, type definitions, and tests.
3. Prefer official Pi APIs (agent loop, state management, tool calls, event streams, extension mechanisms) over reimplementing them. Never guess Pi APIs — mark unverified behavior as uncertain and confirm it before proceeding.
4. When sources conflict, prefer in this order: installed-version source and types → versioned official docs → official tests and examples → latest docs. Third-party material is supplementary only.

## Directory map

| Directory | Responsibility |
| --- | --- |
| `app/(auth)`, `app/(chat)`, `app/(admin)`, `app/(account)` | Pages, Server Actions, HTTP APIs and entry auth; chat routes never implement the Pi agent loop themselves |
| `components/`, `hooks/` | UI and client state; no direct dependencies on Pi SDK/RPC internals |
| `lib/runtime/protocol` | Runtime input, commands, events, and Backend/Session contracts |
| `lib/runtime/backends` | Pi runtime adapters and event normalization; every backend implements the same protocol |
| `lib/runtime/sandbox` | Pi-agnostic SandboxProvider/SandboxHandle/SandboxChannel seam |
| `lib/runtime/run` | RunManager, subscription/replay, run persistence, final message assembly |
| `lib/ai` | Pi sessions, models, tools, skills, attachment assembly; prefer official SDK calls |
| `lib/collab` | In-process realtime collaboration event hub |
| `lib/pi-packages`, `lib/mcp`, `lib/model-plugins` | Pi Package, MCP, and model provider plugin integration boundaries |
| `lib/db`, `lib/admin` | Schema, migrations, queries, and admin domain rules |
| `packages/`, `plugins/` | Reusable SDK and in-repo plugin examples |
| `docker/` | Sandbox runtime image (full pi preinstalled, version synced with `package.json`) |
| `tests/` | All automated tests, fixtures, and test support code |

## Core invariants

- Chat changes keep the responsibility direction `route → RunManager → RuntimeBackend → Pi AgentSession`; the UI receives events only through `RuntimeEvent → stream-mapping`.
- New backends satisfy the `lib/runtime/protocol` contracts first.
- Data access lives in the `lib/db` query layer; routes handle auth and orchestration.
- Sandbox routing failures are fail-closed: never silently fall back to in-process execution.
- Tests go in `tests/unit` or `tests/e2e` (fixtures and support code under `tests/`); never create `*.test.*` files inside `app/` or `lib/`.

## Language conventions

- Commit messages: English, following Conventional Commits — see [CONTRIBUTING.md](CONTRIBUTING.md).
- New code comments: English. Existing Chinese comments are migrated progressively; do not mix languages within a comment block.
- User-facing strings go through the i18n catalogs (`i18n/messages/zh.json`, `i18n/messages/en.json`) — never hardcode UI copy.
