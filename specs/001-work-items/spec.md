# Feature Specification: Durable Council work items

**Feature Branch** `codex/001-work-items`
**Created** 2026-11-28
**Status** Ready for implementation

## User Scenarios & Testing

### User Story 1 — Record a work item in the project (Priority P1)

A lead records a title, acceptance criteria and the Team role responsible. On reopening the project, the lead can find the same work item and see that it is ready to delegate.

**Independent test.** Create a work item, exit the original client, then list it and open it from a different Council client pointed at the same project.

1. Given a configured Team role, when the lead saves a complete form, then Council returns a stable ID and shows the title, ordered criteria, responsible role and Draft state.
2. Given a saved ID, when the same create request is replayed, then Council returns the existing item. If the same ID is used with different inputs, Council reports a conflict and preserves the original.
3. Given missing criteria or an unknown Team role, when the lead attempts to save, then Council explains the input error and leaves the item unsaved.
4. Given a different project, when the same ID is requested, then Council reads only that project's data.

### User Story 2 — Delegate from the saved work item (Priority P1)

The lead assigns the recorded work to the responsible Team member with one explicit delegation action. Council sends the title and all saved criteria as part of a bounded Team call.

**Independent test.** Delegate a draft with mock Herdr transport. Verify that the Team job receives the saved brief and uses the member's configured agent and permissions.

1. Given a draft with a current role, when the lead delegates it, then Council records the intent before starting the existing asynchronous Team job and returns without waiting for a response from the member.
2. Given two delegates for the same item, when their requests race, then at most one request starts a job. Both can inspect the same saved intent and linked session.
3. Given a removed role, when a draft is delegated, then Council explains how to restore that role or create a replacement item. No execution starts.
4. Given CLI, MCP and the Herdr Workspace form, when each is used with the same project, then it addresses the same saved work and execution.

### User Story 3 — Reopen the work and recover the next action (Priority P1)

In a later turn or process, the lead reopens the item to retrieve the member's saved response, the linked session and the next action appropriate to the recorded execution.

**Independent test.** Simulate a lost dispatch response and reopen from a fresh client. Confirm that the existing session is inspected without a second launch or task send. Finish the original job and reopen again to retrieve its saved result.

1. Given a correlated, completed job with a saved response, when the lead opens the item again, then Council displays the response and its evidence source, and asks the lead to review it against the criteria.
2. Given blocked, expired, uncertain or failed execution, when the lead opens the item, then Council displays the attention state, evidence available from the job and a recovery action.
3. Given a persisted intent and no verifiable job, when a client reopens it or repeats delegate, then Council exposes that uncertainty and the reserved session ID. The item cannot dispatch a second time.
4. Given a verified late result on the linked job, when the lead opens the item again, then Council shows the result and the review action.

### Edge cases

- Filenames and links use validated IDs and remain within the selected project. Corrupt or mismatched records produce a readable error or an attention state, with unaffected items still available.
- Closing and reopening a client, losing its response, and switching Workspace focus during a request preserve project identity and the original execution deadline.
- An existing successful Council capture is handoff evidence. The lead decides whether the criteria were met.
- Local filesystems that cannot publish a work-item record atomically fail the write with an actionable message. A failed intent write cannot start a Team job.

## Requirements

- **FR-001** Council MUST save a stable, project-scoped ID, title, ordered acceptance criteria, responsible Team role ID and creation time for each work item.
- **FR-002** The initial lifecycle state MUST be Draft. Invalid or ambiguous inputs MUST leave the item unchanged.
- **FR-003** Council MUST provide create, list, show and delegate in the CLI, MCP and Herdr Workspace. The Workspace flow MUST start in a particular project and offer the configured Team roles.
- **FR-004** Delegation MUST use the existing asynchronous Team execution path and a bounded deadline, with the saved title and criteria and the current profile of the recorded role.
- **FR-005** Council MUST publish a single immutable dispatch intent before any launch, bind it to one job session and allow only the caller that published it to initiate execution. A later invocation MUST inspect the existing intent and job.
- **FR-006** Council MUST use the existing job's delivery, status, result, deadline and evidence. Missing or inconsistent linkage MUST remain visible as uncertainty or an integrity issue. Reads MUST be free of dispatch, send and cleanup side effects.
- **FR-007** A completed, verified handoff MUST expose its saved output and evidence source with a next action to review the criteria. Provisional screen evidence MUST retain its label. The work item grants no formal approval.
- **FR-008** The Workspace MUST show work-item state and next action and offer a path to the linked Delegations detail for a verified session, in the original project and machine.
- **FR-009** Work-item records MUST be durable across client exits and readable on supported local Windows, macOS and Linux filesystems without changing existing Team, session, or formal approval behavior.
- **FR-010** Replay after concurrent or interrupted writes MUST preserve both record integrity and the at-most-once dispatch guarantee, including when a worker may have been launched with no returned receipt.

### Key Entities

- **Work item** — immutable definition for a piece of work in one project.
- **Dispatch intent** — immutable link from the work item to one reserved Team job session.
- **Team job** — existing Council execution record and status for the responsible member.
- **Handoff** — saved response with capture provenance, linked to a verified job.

## Success Criteria

- **SC-001** In an isolated project a lead creates one item, closes the client and retrieves the same ordered criteria, role, ID and state through another surface.
- **SC-002** Concurrent requests and the tested interruption windows produce at most one normal worker launch and one task delivery per work item. Reopening performs zero additional sends and preserves the original deadline.
- **SC-003** For every documented job outcome, the lead sees a state, a next action, and any verified saved result. Any completed work shown still requires lead review.
- **SC-004** The regression suite passes on the project's Windows, macOS and Linux CI matrix. A bounded local Herdr transport check and an explicitly assigned real-agent check are reported with separate evidence and tested revisions.

## Scope and Assumptions

This increment serves one local project at a time, with a single existing Team role as assignee and at most one dispatch per item. Lead is the operator in the local project trust model. Team profile permissions control agent execution. Editing, reassignment, redispatch, approval, cross-worktree sharing, Plane sync and vault storage are outside this increment. A later turn means any client invocation in the same project. Council retrieves the handoff on demand.
