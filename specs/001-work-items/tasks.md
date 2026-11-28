# Tasks: Durable Council work items

## Phase 1 — Shared contract

- [X] T001 Freeze the feature specification and shared wire contract in `specs/001-work-items/spec.md` and `specs/001-work-items/contracts/`.
- [X] T002 Document project scope, lifecycle, interrupted writes and the evidence gates in `specs/001-work-items/data-model.md` and `test-plan.md`.

## Phase 2 — Record and reopen (PR A, Terra, Story 1)

- [ ] T003 [US1] Implement the project root and bounded immutable definition/intent store in `herdr/mods/council/runtime/work-item-store.mjs`. Reuse `store-files.mjs`. Protect paths and isolate unreadable rows.
- [ ] T004 [US1] Implement validation, idempotent create and disk-only list in `lib/work-items.js`.
- [ ] T005 [US1] Add CLI command and JSON envelope handling in `bin/council.js`. Add MCP definitions and routing in `lib/mcp-tool-definitions.js` and `lib/mcp-server.js`.
- [ ] T006 [US1] Add definition, project isolation, error contract and CLI/MCP process regressions in `tests/work-items.test.js` and `tests/work-items-interfaces.test.js`.

## Phase 3 — Delegate and reconnect (PR A, Terra, Stories 2 and 3)

- [ ] T007 [US2] Atomically claim one dispatch intent and construct the deterministic saved brief in `lib/work-items.js`. Permit one call to the existing Team path per intent.
- [ ] T008 [US2] Persist the optional job binding through `lib/team.js`, `lib/jobs.js` and `herdr/mods/council/runtime/job-record.mjs`. Preserve existing job fingerprints, delivery and worker behavior.
- [ ] T009 [US3] Project the verified job, result, evidence and next action into list and detail in `lib/work-items.js`. Keep the list disk-only and show bounded.
- [ ] T010 [US2] [US3] Add cross-process claim, interrupted dispatch, uncertain delivery, integrity and result regressions in `tests/work-items.test.js` and `tests/work-items-interfaces.test.js`.
- [ ] T011 [US2] [US3] Extend `.github/scripts/package-smoke.mjs` to check the packaged CLI/MCP contract and the project guard. Run the existing suite and doctor. Submit PR A with its tested SHA and evidence categories.

## Phase 4 — Herdr Workspace (PR B, frontend, all stories)

- [ ] T012 [P] [US1] Implement the Work items perspective, list/detail and form in `herdr/mods/council/work-item-view.js` and `herdr/mods/council/workspace-view.js`.
- [ ] T013 [P] [US2] [US3] Implement project-machine CLI wiring, request scope, envelope parsing, recovery and deep-linking in `herdr/mods/council/work-item-actions.js` with minimal integration in `main.js` and `navigation.js`.
- [ ] T014 [US1] [US2] [US3] Check arguments, focus races, readonly recovery and linked-result navigation in `tests/desktop-work-items.test.js`. Run the native mod check and submit PR B against the available integration base.

## Phase 5 — Integration and acceptance

- [X] T015 Correct active references to the previous repository owner in README, the alignment link and the tagged changelog link.
- [ ] T016 Review PRs A and B against the frozen contract. Reproduce the failure cases, check the packaged mod and rerun the suite and doctor on the final integration revision.
- [ ] T017 Record the hosted matrix, one bounded real Herdr transport test and a separately authorized real-agent check. Record the revision and result of each in Plane.
- [ ] T018 Send the CEO the review disposition, test evidence, residual failures or missing environments, and the next action.

T003–T006 enable new item persistence through CLI/MCP. T007–T011 complete PR A's runnable vertical path. T012/T013 can begin against the frozen fixtures before PR A merges. T014–T018 require the integrated core and UI. Keep PR A independently testable and PR B focused on Workspace.
