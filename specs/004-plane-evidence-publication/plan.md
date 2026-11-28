# Implementation plan · COU-9

## Summary

Deliver a single-machine pilot that links a COU-8 item to a pre-existing Plane item and publishes one fixed, explicitly approved internal comment through an isolated operator publisher. The project roadmap defines Council as owner of its work/evidence and Plane as owner of planning fields. The first backend PR is independently verifiable with Plane/GitHub and filesystem fixtures.

## Technical context

- **Stack** — Existing Node CLI, MCP coordinator, Herdr JS Workspace and local filesystem. Node 20/24 test matrix on Linux, macOS and Windows. Initial installed authority and UI acceptance target is Windows ARM64.
- **Baseline** — COU-8 work item detail and durable revision at merge `58ae01470347a04d59008308f8f0f953485360d3`. Existing local work items get an additive empty publication overlay on read. There is no write migration.
- **Providers** — Plane self-hosted API v1 pinned to a configured exact origin and scope. Public GitHub REST evidence verification with exact allowlisted repository identity. Keep Plane writes disabled until an operator-admin grants the deployment profile after demonstrated trust and provider gates.
- **Persistence** — Operator-private local journal, single installation, tested durable exclusive creation and immutable event publication, no network filesystem or shared/copyable writer. Existing lifecycle journals remain independent.
- **Product constraint** — Council review or job completion never grants a remote permission. Work-item and formal-vote semantics are carried forward from COU-8.

## Constitution check

GitHub Spec Kit scaffolds spec, plan and task list. Project rules come from the repository instructions and owner brief. The added remote write is opt-in and fixed; a persisted outbound fence makes uncertain delivery continue in place; protected operator approval remains distinct from mechanical checks. Review, implementation and deployed authorization remain separate gates.

## Structure and ownership

| Owner | Allowed change area |
| --- | --- |
| Backend (Terra) | `bin/council.js`, `lib/` and existing MCP entry/wrapper files for additive queries; `herdr/mods/council/runtime/plane-*.mjs` for packaged runtime; tests and fixtures under `tests/`; minimal `herdr/install.js` entries for packaged runtime where required. Any new privileged launcher or manifest belongs in a separately reviewed Windows deployment increment. |
| Frontend (assigned by CEO) | `herdr/mods/council/work-item-actions.js`, `work-item-view.js`, `workspace-view.js` and corresponding frontend fixtures. Coordinate before changing shared installation or CLI files. |
| Integration owner | Contract amendments at immutable refs, final combination, installed checks, independent review and deployment permission. |

## Roadmap and gates

| Gate | Scope | Evidence |
| --- | --- | --- |
| G1 · backend A | Local scope/read-only target verification, strict forms, fixtures, guarded writer design. Candidate is inert on installed hosts. | A01–A03, A11, installed packaging/read-only smoke and existing suites. Backend A contains no active remote sender. |
| G2 · backend B | Durable publication protocol and outbound adapter verified through fixture transport only. Protected operator backend can be exercised with injected test principal/transport. | A05–A13, fault injection, full ten-repetition suite, review of exact bytes and no-retry controls. Standard installations still disable live writes. |
| G3 · installed capability | Administrator provisions dedicated Plane API principal and operator boundary. Verify code and data permissions, invocation isolation, persistent filesystem primitive and live v1 comment behavior using a dedicated test item. | A02, A05–A07, A10–A13 live where applicable. Filesystem/transport/root-of-trust must be demonstrated; host profile unsupported until then. |
| G4 · combined Workspace | Bundle reviewed backend and UI, run fixture then installed evidence walkthrough at a combined pinned tree. | A04–A13 applicable UI cases, installed native smoke and evidence manifest, privacy redaction. Enable only the accepted deployment profile. |

See [research](research.md), [data model](data-model.md), [tasks](tasks.md), [quickstart](quickstart.md) and [test plan](test-plan.md).
