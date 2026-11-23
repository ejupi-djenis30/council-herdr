# Council for Herdr

## Delegation lifecycle {#delegation}
files: [lib/jobs.js, lib/job-worker.js, lib/herdr.js, lib/recipes.js, herdr/mods/council/runtime/wait-alignment.mjs]
- [x] Record delivery, acknowledgment, wait outcome, and the saved result {#record-delivery}
  evidence: tests/jobs-acceptance.test.js
- [x] Preserve blocked and borrowed terminals for recovery {#preserve-recovery}
  evidence: tests/jobs-acceptance.test.js

## Team roles {#team}
files: [lib/team.js, herdr/mods/council/team-view.js, herdr/mods/council/runtime/team.mjs, skills/council-team/**]
needs: [delegation]
- [x] Call named roles and shut down completed managed processes {#managed-roles}
  evidence: tests/team.test.js

## Decisions and review {#decisions}
files: [lib/modes.js, herdr/mods/council/runtime/discussion.mjs, herdr/mods/council/runtime/polls.mjs, herdr/mods/council/runtime/debate-room.mjs]
links: [team, delegation]
- [x] Bind formal ballots to the saved proposal digest {#bind-ballots}
  evidence: tests/desktop-discussion.test.js
- [x] Turn discussions into linked polls or accountable decisions {#workshop-decisions}
  evidence: tests/desktop-discussion.test.js

## Workspace activity {#activity}
files: [herdr/mods/council/workspace-view.js, herdr/mods/council/runtime/activity*.mjs, herdr/mods/council/delegation-view.js]
needs: [delegation, team, decisions]
- [x] Read declared work plans, recorded runs, and observed Git changes {#collect-activity}
  evidence: tests/workspace-activity.test.js
- [x] Link Team calls and preserve progress notes independently of outcome {#link-handoff}
  evidence: tests/workspace-activity.test.js

## decisions
- Council records workflow outcomes. Scope from PLAN.md and agent reports provide context for operators.
- Git working-tree paths are local observations. The workspace shows them without attributing edits to an agent.
