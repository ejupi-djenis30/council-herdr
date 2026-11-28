# Implementation Plan: Durable Council work items

**Branch** `codex/001-work-items` | **Date** 2026-11-28 | **Spec** [spec.md](spec.md)

## Summary

Add a project-scoped work-item record and an immutable intent ahead of the existing Council Team job. CLI and MCP share the coordinator. Herdr Workspace calls the same CLI on the project machine, reads status through the public contract, and deep-links into the existing job view. A repeat invocation reads the same item with the existing job and delivery record.

## Technical Context

| Area | Decision |
| --- | --- |
| Runtime | Node.js 20+, ESM, zero new runtime dependencies |
| Storage | Local JSON events under the project's `.agent_workspace/.work-items/`, using immutable atomic publication |
| Interfaces | Council CLI, MCP stdio, Herdr Desktop's existing project-machine engine |
| Execution | Existing `callTeamMember` and `JobManager`. One bounded Team job per work item |
| Tests | `node:test`, subprocess and injected transport regressions, existing package smoke, CI matrix, manual Herdr checks |
| Platforms | Windows, macOS and Linux local filesystems supporting same-volume hard links |
| Data ownership | The work-item store owns definition and intent. Council job records own delivery, result, terminal lifecycle and deadline |
| Performance | List reads bounded metadata without Herdr calls. Show/delegate may inspect only the linked worker through existing bounded code |
| Transaction boundary | One atomic intent before any launch. The interval between intent publication and job visibility is deliberately recoverable through observation |

## Constitution Check

The repository's [instructions](../../AGENTS.md) and [owner brief](../../docs/owner-brief.md) govern execution. Gates checked before and after design:

- Herdr owns execution and terminal visibility. Work items introduce no worker, send command or terminal cleanup.
- Team assignment is explicit. Existing permission, launch ownership, wait reason and deadline rules remain authoritative.
- Resume uses the durable intent and job record. A missing receipt never authorizes replay.
- Linkage and handoff evidence are checked against the recorded job. A result is available for lead review. It grants no formal approval or promotion.
- Tests and release records distinguish mocked regressions, live transport and real-agent evidence.

## Design Artifacts

- [Research](research.md)
- [Data model and state projection](data-model.md)
- [Shared CLI and MCP contract](contracts/interfaces.md)
- [Herdr Workspace contract](contracts/workspace.md)
- [Acceptance and evidence matrix](test-plan.md)
- [Quickstart](quickstart.md)
- [Implementation tasks](tasks.md)

## File Ownership and PR Order

| Work | Owner | Paths |
| --- | --- | --- |
| Specification, integration and review | Development lead | `specs/001-work-items/**`, live repository links and integration notes |
| PR A, core vertical path | Terra | `herdr/mods/council/runtime/work-item-store.mjs`, `lib/work-items.js`, `lib/team.js`, `lib/jobs.js`, `herdr/mods/council/runtime/job-record.mjs`, `lib/mcp-server.js`, `lib/mcp-tool-definitions.js`, `bin/council.js`, backend tests named in tasks. Package smoke where required |
| PR B, Herdr Workspace | Frontend | `herdr/mods/council/work-item-view.js`, `herdr/mods/council/work-item-actions.js`, `herdr/mods/council/workspace-view.js`, the minimum Workspace wiring in `herdr/mods/council/main.js` and `navigation.js` if needed, and `tests/desktop-work-items.test.js` |
| Repository owner migration | Development lead | `README.md`, `CHANGELOG.md` and the alignment link at `herdr/mods/council/main.js`. Land the link change before frontend edits touch that file |

PR A runs create → delegate → reconnect → result through CLI and MCP and includes the race/fault regressions. Frontend can develop against the contract and fixtures, and tests the final flow with PR A present. Review B against A until A lands, then rebase B. Integrate only after cross-surface checks and evidence for the packaged UI. Contract changes go through the development lead with a replacement commit and a new contract digest before dependent work is accepted.

## Spec Kit

Specify CLI 0.16.1 initialized the feature worktree. The Spec Kit spec, plan and task templates and Python setup/prerequisite scripts were used. Generated local agent integration and toolkit scaffolding are disposable. The branch publishes the feature artifacts; `specify init` can regenerate tooling for future authoring.
