# Implementation Plan: Triage and review Council work items

- **Branch** `codex/002-work-item-review`
- **Baseline** `bd4a7c6272cc43c82defa4739a0aa668b3115ea1`
- **Spec** [spec.md](spec.md)

## Technical Context

| Area | Decision |
| --- | --- |
| Runtime | Node.js 20+, ESM, existing filesystem stores and Herdr engine. No external runtime dependency |
| Durable records | Immutable COU-2 first two slots, add a project-local lifecycle journal and content-addressed evidence in each item directory |
| Concurrency | No-replace publication of a numbered event, expected revision and request ID. Use the existing first-intent slot to arbitrate legacy writers |
| Execution | Managed Team and existing JobManager. Reuse the durable deadline, delivery protocol, terminal ownership and capture verification |
| Formal evidence | Read the authoritative completed-round and validation data through existing Council helpers. Bind and verify the exact proposal and observed evidence before an explicit acceptance |
| Surfaces | CLI and MCP use a shared coordinator. Workspace uses the installed project-machine CLI with argv tokens and existing project navigation |
| Platforms | Supported local filesystems with same-volume hard links on Windows, macOS and Linux. Per-target native release evidence is tracked in COU-7 |
| Performance | List reads validated metadata and peer dependencies on disk. Show resolves one item's active evidence. History pages immutable events. No background scan or launch |
| Package | Native installer ships both lifecycle runtime and prior tool/store assets. Existing npm and MCP package checks exercise actual installed entry points |

## Constitution Check

The [repository instructions](../../AGENTS.md) and [owner brief](../../docs/owner-brief.md) govern all work. The design keeps execution in Herdr, preserves uncertain delivery and the original deadline, and reuses Team behavior. Formal acceptance keeps the exact author artifact and existing direct ballot and completed-turn checks. Screen evidence remains a handoff or informational finding. The explicit operator decision is distinct from the worker, tally and formal verdict. Plan, tests and reviews classify live and simulated evidence separately. No additional agent launches are in scope for authoring or verification without explicit assignment.

## Design Artifacts

- [Decisions and research](research.md)
- [Persistence, migration and concurrency](data-model.md)
- [CLI and MCP](contracts/interfaces.md)
- [Herdr Workspace](contracts/workspace.md)
- [Formal evidence contract](contracts/formal-review.md)
- [Acceptance matrix](test-plan.md)
- [Quickstart](quickstart.md)
- [Tasks](tasks.md)

## File Ownership and PR Order

| Increment | Owner | Files and boundary |
| --- | --- | --- |
| Specification and review | Development lead | `specs/002-work-item-review/**`, acceptance evidence and integration reviews |
| PR A, CLI/MCP and persistence | Terra | `lib/work-items.js`, new `lib/work-item-lifecycle.js` and `lib/work-item-review.js`, `bin/council.js`, `lib/mcp-server.js`, `lib/mcp-tool-definitions.js`, `lib/team.js` and `lib/jobs.js` plus optional job binding in `runtime/job-record.mjs`, the item store and new lifecycle runtime under `herdr/mods/council/runtime/`, minimal formal read helper in `lib/formal-rounds.js` if required, `herdr/install.js` runtime list, `.github/scripts/package-smoke.mjs`, and tests named by T003–T015 |
| PR B, Workspace | Frontend lead via CEO | `herdr/mods/council/work-item-actions.js`, `work-item-view.js`, minimal wiring in `main.js` and `workspace-view.js`, purpose-built tests named by T016–T020. No job or lifecycle store mutations in UI code |
| Integration and release evidence | Development lead with CEO | Review exact commits. Verify package, real Herdr transport fixture and native Workspace on the combined revision. Document platform/harness evidence under COU-7 |

PR A delivers the full lifecycle from normal CLI and MCP entry points and is reviewable without the UI. PR B develops against the frozen contract and includes the native path with A installed. Create both from the published contract commit. Tests can use independent fixtures. Run package and integrated verification before accepting the combined flow. Contract changes require a replacement commitment and digest from the development lead. COU-9 starts after COU-8.

## Spec Kit

Specify CLI 0.16.1 initialized the dedicated worktree. Spec Kit's spec, plan and task templates and Python setup and prerequisite scripts produced the feature structure. The repository publishes the feature artifacts. The local agent scaffold can be regenerated with `specify init`.
