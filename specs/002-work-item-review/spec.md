# Feature Specification: Triage and review Council work items

- **Feature branch** `codex/002-work-item-review`
- **Date** 2026-11-28
- **Status** Ready for implementation
- **Decision record** COU-8 and the [accepted product roadmap](../../docs/herdr-project-product-brief.md)
- **Baseline** Work items in Council and Herdr Workspace at `bd4a7c6272cc43c82defa4739a0aa668b3115ea1`

## User Scenarios & Testing

### User story 1 — Triage one project's work (Priority P1)

A lead prioritizes items, sees blockers and responsibility, and filters Workspace by responsible role, lifecycle state or attention. The lead can revise the criteria or responsible role before sending the current cycle to an agent.

**Independent test.** Open a project of ten items, including old records. Set priority and blockers, change criteria on an unsent item, reopen the client, and check the filters and preserved order. In an adjacent worktree with identical item IDs, confirm that reads and writes stay in the selected project.

1. Given a work item saved before this increment, when the lead opens it, then the original definition, criteria, role, saved attempt and result remain visible with their provenance.
2. Given an open work item, when the lead saves valid triage changes, then another client sees the priority, linked blockers, responsible role and next step at the resulting revision.
3. Given an existing dispatch intent, when the lead tries to edit the title, criteria or responsible role of that cycle, then Council returns a conflict with a recovery action. The brief sent to the member remains reproducible.
4. Given two clients with the same starting revision, when both write changes, then at most one change commits and the other client sees the revision conflict. A replay of the winning request returns its original receipt.

### User story 2 — Review evidence and explicitly close (Priority P1)

A lead puts a saved handoff in review, sees the exact evidence and the criteria sent to the responsible role, records findings or dissent, and explicitly accepts and closes the item when the review qualifies.

**Independent test.** Freeze a verified handoff, reopen from another client and compare the frozen bytes and digest. Record a dissenting finding and accept with the current evidence confirmation. Check that worker completion by itself leaves a separate review and decision to perform.

1. Given a completed Team job, when no lead has accepted a qualifying review, then the work item remains open or in review and the saved job remains available.
2. Given a review marked formal, when formal evidence is rejected, provisional, mismatched, or unverifiable, then Council keeps the actual verdict visible and refuses closure. Changing to a later cycle preserves the formal requirement.
3. Given a formal review authorized by valid direct ballots from completed voters, when the lead confirms the current evidence and records acceptance, then the history binds that acceptance to the exact frozen work revision and formal proposal and decision evidence.
4. Given changed evidence, a stale revision or a failed publication, when the lead submits a decision or resumes a lost reply, then the UI can reconcile the attempt or show the conflict. No earlier confirmation approves new evidence.

### User story 3 — Reopen without losing the decision (Priority P1)

A lead reopens a closed item with a responsible role and concrete next action. The completed cycle, findings, decision and review evidence remain visible. If the lead opts for more execution, the new cycle uses a new durable intent and an explicitly confirmed dispatch.

**Independent test.** Close an item, reopen it in another process, begin a new Team attempt, then inspect both cycles and the old decision. Inject a lost reply after the new intent is saved and verify zero additional sends.

1. Given a closed item, when the lead reopens it against the current decision, then the item keeps its ID and starts a new cycle with its own next action, role and work revision.
2. Given a frozen review that needs changes, when the lead returns it for rework, then the review and any formal rejection or provisional result remain in history and a later attempt requires an explicit dispatch.
3. Given uncertain delivery of the current attempt, when a client reconnects or retries an operation after a restart, then Council retains the original intent, session and deadline, and exposes the recovery step. It cannot start a second attempt for that cycle.
4. Given a profile removed after a handoff, when the lead reads its history or closes a qualifying review, then the previous role record stays readable. Reopening or sending a new task requires an available responsible role.

### Edge cases

- A stale desktop or CLI may still see the original definition. Once a new workflow owns the item, the old execution path cannot send a task for it.
- Old uncertain attempts and corrupted intent or journal files keep an actionable read state. Usable neighbouring items and validated historical evidence remain available.
- Linked blockers are local references for triage. A missing or unresolved linked item is visible. Dependency cycles create no automatic task or lifecycle transition.
- A screen capture may be reviewed as handoff evidence with its capture source preserved. A screen marker carries no authority to approve a formal review.
- A changed or missing frozen file is shown as an integrity issue. Previously recorded decisions and their cited hashes stay in history.

## Requirements

- **FR-001** Council MUST expose priority, responsible role, ordered acceptance criteria, local blocker links, and next action, with project-scoped filtering and retrieval through CLI, MCP and Workspace.
- **FR-002** Council MUST read existing definitions and attempts without rewriting them, preserve their IDs, delivery, deadlines and evidence, and prevent old and new writers from dispatching the same current cycle.
- **FR-003** Council MUST enforce expected revision and idempotent request identity for lifecycle writes across processes. On conflict, callers can reread and make a fresh explicit decision.
- **FR-004** Council MUST freeze a verified handoff and bind its exact bytes, attempt, and work revision before exposing a review. Show the capture source, ordered criteria, review owner, findings, and dissent.
- **FR-005** Closing MUST require an explicit lead acceptance with a named actor, reason, next action, review ID, and current evidence confirmation. Execution outcome, Git activity, and advisory decisions cannot close an item.
- **FR-006** A formal review MUST stay bound to the reviewed evidence and existing Council formal session/round. Approval requires the existing completed-round, verified proposal, direct ballot, quorum and validation checks. Missing, invalid, provisional, and rejected evidence MUST remain visible and cannot authorize closure.
- **FR-007** Council MUST persist triage, attempt reservations, review findings, closure, return for changes, and reopening with revision, actor, time, and provenance. An archived decision MUST reference the frozen work revision and supporting evidence.
- **FR-008** Reopening or returning a review for changes MUST retain previous history and require a responsible role and next action. A new attempt needs its own explicit action and reserved session.
- **FR-009** Council MUST reuse managed Team execution, preserve terminal ownership rules, and perform no sends or cleanup while reading or reconciling. The caller with the successful intent publication is the only caller allowed to dispatch.
- **FR-010** Workspace MUST keep forms, recovery reads and links on the selected project machine. It MUST show conflict, partial read, unavailable engine, and evidence problems without changing the destination or replaying mutations.
- **FR-011** The feature MUST preserve existing formal ballot and report semantics, existing job behavior, and the distinction between regression fixtures, real Herdr transport, agent results, and native interaction evidence.

## Key Entities

- **Work item and work revision** — one project-scoped identity, with an ordered definition of the work sent in each attempt.
- **Work cycle and attempt** — the period in which one task may be dispatched, with its durable intent and linked Council job.
- **Review and frozen evidence** — a verified result with exact bytes, recorded criteria, and an operator or formal review policy.
- **Decision and history event** — an explicit acceptance or rework decision and the immutable events that led to it.

## Success Criteria

- **SC-001** A lead completes triage, review, closure and reopening in a ten-item project. Filters, accountable roles, decisions, criteria and evidence remain discoverable after a full client restart.
- **SC-002** Across concurrent mutations, old-client races and simulated lost responses, there are zero duplicate attempts in a cycle, zero silent overwrites, and zero cross-project writes.
- **SC-003** Rejected and provisional formal review fixtures remain distinguishable and cannot close. A correctly bound approved round can close only after an explicit lead decision. Tampered or stale evidence is refused.
- **SC-004** Two consecutive cycles can be inspected independently with their original identities, result provenance and decision history. The new cycle never recycles its predecessor's session or deadline.
- **SC-005** Existing CLI/MCP regressions and the new tests pass on Windows, macOS and Linux. The packaged Workspace flow is verified before integration. COU-7 records the wider release evidence per actual platform and harness.

## Scope and assumptions

One local project machine and one managed Team attempt per cycle. The existing local filesystem permission model authorizes Council writes. Operator names are recorded declarations in that trust model. The formal verdict remains separately accountable to the existing completed-participant and direct-ballot rules. A workspace alias can identify the same directory, and each actual Git worktree remains a separate project. COU-9 follows COU-8 and covers any explicit Plane publication. COU-6 has its own approved scope and specification. Cross-machine transfers, automatic dependency dispatch, role authentication and forced recovery of an ambiguous attempt remain outside this increment.
