# Repository knowledge map

This index points to maintained evidence. Code and executable configuration describe current behavior; plans and specifications describe intended behavior.

## Product and specifications

- [Product intent](../IDEA.md): local-first, single-user workflow and explicit human gates.
- [Product requirements](GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md): detailed backend, UI, persistence, and security requirements.
- [Current UI contract](UI_UX_SPEC.md) and [visual design contract](VISUAL_DESIGN_SPEC.md).

## Architecture and decisions

- [README](../README.md): runtime topology, commands, authentication boundary, and operational safety.
- The browser uses `src/tracker` plus `src/api.ts`; it must not import server internals.
- The API uses `src/server` plus `src/shared.ts`; it must not import tracker components.
- Runtime state and generated personal artifacts stay in ignored local directories.
- The deterministic boundary check is `npm run harness:check`.

## Planning artifacts

Working plans and execution records are intentionally local-only. They are not required application source and are not tracked in the repository.

## Quality, evaluation, and reliability

- `npm run check`: whitespace, TypeScript, documentation links, manifest, and architecture boundaries.
- `npm test`: deterministic unit and integration suite.
- `npm run eval`: representative golden-fixture and health-path evaluation without live providers.
- `npm run smoke:browser`: real browser acceptance path with fixture services.
- `GET /health`: machine-readable startup signal.
- `npm run doctor`: fail-fast local harness check; it does not rewrite tracked files.

## Security

- [README workflow and safety boundaries](../README.md#workflow-and-safety-boundaries) are authoritative.
- Provider credentials remain in Pi authentication storage or environment variables and must not enter this repository.
- Live scrape and live AI evaluation are explicit, never default verification steps.
- Security and prompt-boundary regressions are covered by `tests/injection.test.ts`, `tests/pi-tools.test.ts`, and related workflow tests.

## Debt and deferred capabilities

- CI is deferred because no repository CI provider is configured.
- Observability is partial: workflow telemetry and JSON health are structured, while general request, error, and lifecycle logging is not complete.
- Live-provider evaluation remains opt-in; deterministic fixtures are the default acceptance evidence.

See [.harness/manifest.json](../.harness/manifest.json) for the machine-readable capability receipt.
