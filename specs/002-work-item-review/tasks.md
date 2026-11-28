# Tasks: Triage and review Council work items

## Phase 1 — Freeze the shared design

- [X] T001 Publish the feature specification, data model, CLI/MCP, Workspace and formal evidence contracts in `specs/002-work-item-review/`.
- [X] T002 Publish representative wire fixtures, the staged acceptance matrix and the operator quickstart.

## Phase 2 — Backend foundation and triage (PR A, Terra, story 1)

- [ ] T003 Add bounded journal replay and append, same-slot activation and validated legacy projection in `herdr/mods/council/runtime/work-item-lifecycle-store.mjs` and `work-item-store.mjs`. Bind exact baseline bytes and valid prior events.
- [ ] T004 [US1] Implement revision and request comparison, triage, project-local blockers, filters and history in `lib/work-item-lifecycle.js` and `lib/work-items.js`.
- [ ] T005 [US1] Preserve old create/list/show/delegate inputs and output fields. Add detailed lifecycle projections and typed errors through `bin/council.js`, `lib/mcp-server.js` and `lib/mcp-tool-definitions.js`.
- [ ] T006 [US1] Cover two projects, migration, physical worktrees, alias resolution, incomplete files, UTF-8 corruption, filter behavior and simultaneous mutations in `tests/work-item-lifecycle.test.js`.

## Phase 3 — Review and explicit decisions (PR A, Terra, stories 2 and 3)

- [ ] T007 [US2] Implement verified capture freezing, binding to the work definition, and note persistence in `lib/work-item-review.js`. Reuse the original job and storage checks.
- [ ] T008 [US2] Attach and inspect a single verified formal scope in `lib/work-item-review.js`. Reuse the completed-round, proposal, direct-ballot and report rules. Add only the necessary read integration in `lib/formal-rounds.js`.
- [ ] T009 [US2] Implement explicit acceptance and close events with current evidence and review checks. Persist archived evidence and distinguish operator and formal authority.
- [ ] T010 [US3] Implement review return and reopen in `lib/work-item-lifecycle.js`. Preserve previous decisions and evidence. Carry required formal policy into the new cycle.
- [ ] T011 [US3] Start v2 attempts through existing Team and JobManager with additive binding in `lib/team.js`, `lib/jobs.js` and `herdr/mods/council/runtime/job-record.mjs`. Check the binding on read and preserve earlier job fingerprints.
- [ ] T012 [US2] Cover accepted, provisional, rejected, stale, wrong-binding, corrupt and screen-only cases in `tests/work-item-lifecycle-review.test.js`.
- [ ] T013 [US3] Verify competing launch, receipt loss, old/new first-slot race, archived evidence during rework or reopen, and preservation of the deadline through a second process in `tests/work-item-lifecycle.test.js`.
- [ ] T014 [US1] [US2] [US3] Exercise the full CLI and MCP flow in `tests/work-item-lifecycle-interfaces.test.js`. Cover the packaged entry points and isolated install in `.github/scripts/package-smoke.mjs` and the relevant installer regression. Add the lifecycle runtime to `herdr/install.js`.
- [ ] T015 Submit the backend PR with its tested SHA, matrix, doctor, package evidence, and the limitations of each fixture and transport check.

## Phase 4 — Workspace (PR B, frontend lead via CEO)

- [ ] T016 [P] [US1] Extend the queue, project-local filters, blockers and triage edit controls in `herdr/mods/council/work-item-view.js` and `workspace-view.js`.
- [ ] T017 [P] [US2] Add frozen review and evidence views, notes, formal link, explicit close and return confirmations.
- [ ] T018 [US3] Add reopen, history and archived review navigation. Preserve the original project and role path across focus changes.
- [ ] T019 [US1] [US2] [US3] Extend `herdr/mods/council/work-item-actions.js` and minimally wire `main.js` for v2 scope, request replay, revision conflict and old engine handling.
- [ ] T020 [US1] [US2] [US3] Add fixture and process coverage in `tests/desktop-work-item-lifecycle.test.js`. Exercise the ten-item Workspace flow with the installed combined package. Submit PR B.

## Phase 5 — Integration and release evidence

- [ ] T021 Review both PRs against the frozen contract and exact SHAs. Rerun suite, doctor, installer and packaged smoke on the combined revision.
- [ ] T022 Run the agreed native test on the combined revision and record platform and evidence class in COU-7. Use a real Herdr transport fixture separately from an explicitly assigned real agent. Keep unverified accessibility and platform combinations visible.
- [ ] T023 Record dispositions and evidence in COU-8 and report the integrated commit and residual release gates to the CEO. COU-9 depends on accepting COU-8.

T003–T006 establish migration and triage. T007–T015 complete the backend vertical slice. T016/T017 can begin from the shared contract while PR A is in progress. T020–T023 require both implementations.
