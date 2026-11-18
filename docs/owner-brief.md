# Council: product ownership and acceptance

Owner: Codex (`t10k`). Implementer: Antigravity (`t106`). Independent reviewer: Junie (`t10c`).
Baseline reviewed: `5672d53`, 2026-11-17.

## Product outcome

Council must make a real Herdr workflow easier: give a bounded task to visible agents, exchange actual work, review it against the user's constraints, and return an evidence-backed result with clear next actions. Herdr owns terminal execution and visibility; Council adds task briefs, handoffs, review, and durable session results.

The first acceptance milestone is a reliable read-only council/review/delegate flow. Do not expand modes, retention, election machinery, or host integrations until this works. Existing modes must report failures honestly.

## Review findings that block acceptance

1. `lib/modes.js` ignores wait/read outcomes. A timeout, startup idle, blocked agent, failed read, or missing output can be treated as a completed submission and then cleaned up.
2. `parseBallotFromOutput` invents approve/amend ballots and high scores for text without explicit votes. Current mocks affirm this behavior. Missing votes must remain missing.
3. Failed tally becomes `conditional`; `validateChoice` does not check quorum/approval and allows promotion. Even three explicit rejections can produce a successful report.
4. Council launches all reviewers before the author proposal exists. Workspace paths in briefs say `draft`, but the orchestrator stores `deliberation`. Direct artifacts are ignored in favor of terminal screens. A reviewer must receive the exact proposal and digest being evaluated.
5. The final ruling/synthesis is static text attributed to a representative who never performed a synthesis turn. Do not claim human/agent validation that did not occur. An honest mechanical aggregation is an acceptable first milestone if clearly identified.
6. Direct ballot files are parsed without validating schema, voter, session, round, score, or target digest. Corrupt ballots contribute to quorum, and their exclusion from the approval denominator can turn one approve plus two corrupt files into a passing result. Invalid/mismatched ballots must not authorize promotion.
7. Launches use fixed terminal names and discard the returned address/first-message state. Concurrent sessions and recovery need actual owned terminal addresses. Cleanup must never target an unrelated terminal or erase a blocked/incomplete agent needed for recovery.

## Implementation scope: Antigravity

Own code and regression tests in `lib/`, `bin/`, `tests/`, plus factual README/skill updates. Keep changes cohesive and avoid broad rewrites. Tell Junie and Codex the commit/hash and exact limitations when ready. Do not edit this brief or Junie's review report.

Acceptance requirements:

- Track launch address, task delivery, turn/status, and wait reason from actual `hc` JSON. A successful CLI exit is not evidence that the task finished. Handle timeout/message/idle-before-task/blocked/error conservatively; preserve incomplete terminals and return an actionable status. No force, permission bypass, core restart, or unrelated-terminal cleanup.
- Obtain an actual author submission before launching reviewers, hand off its content/path and SHA, and use the same artifact location in prompts and persistence. Prefer valid direct output; label any screen fallback honestly. Read-only agents must have a usable response channel without asking them to bypass their permission mode.
- Only explicit, valid ballots count. Reject or record missing/malformed/mismatched votes. A failed quorum or failed approval cannot be promoted as conditional success. Dissent must remain visible. A checksum proves file consistency, not authorship or endorsement.
- Make `success`, report wording, saved verdict, CLI exit status and MCP `isError` agree about unsuccessful execution. A policy rejection can be a completed workflow, but must not look approved.
- Do not attribute a synthetic ruling to an agent. Either run an actual bounded synthesis turn over the submissions or describe the result as an orchestrator aggregation with no representative sign-off.
- Add meaningful regressions for the cases above. Run slow commands under `hc run --bg`, inspect the results, and report evidence.
- No new AI agents without an explicit follow-up assignment from Codex. Plain test helpers are allowed. Coordinate through Codex; Junie stays read-only on product code.

## Independent review scope: Junie

Audit baseline first, then Antigravity's changes. Own only `docs/independent-review.md` and scratch probes outside tracked product files. Do not edit implementation or existing tests. Send concrete reproductions and severity to Codex (`hc send t10k`) and Antigravity (`hc send t106`).

Probe timeout/blocked/startup/message wait responses, read failures, all-reject ballots, missing markers, malformed direct ballots, wrong voter/session/round/SHA, reviewer handoff, direct artifact precedence, and cleanup ownership. Read actual `hc` launch/wait JSON using bounded shell helpers in Herdr so mocks reflect the installed CLI. No new AI agents; no manipulation of unrelated terminals. Run your own verification after the implementation is committed. A green suite alone is not an acceptance decision.

## Definition of done for this milestone

1. Independent reproductions fail safely rather than manufacturing success.
2. Regression suite passes with realistic Herdr protocol fixtures.
3. A bounded integration check uses real `hc` launch/get/wait/read and verifies task completion plus cleanup of owned helpers.
4. A real agent smoke check is assigned only after the above passes; its report must contain actual task-specific work.
5. Documentation distinguishes tested functionality from planned/unverified host support. Replace the blanket `RATIFIED / LGTM` claim in the earlier combined review with its historical scope and current limitations.

Backlog after acceptance: existing-terminal participation, resumable sessions, round revisions, and explicit parallel/pipeline input surfaces. These are not grounds to postpone the reliability fixes.

## Owner verification of the baseline

The owner independently ran the existing suite at `5672d53`: **37/37 pass**. A separate bounded probe then reproduced all of the following:

| Input | Observed baseline result | Required result |
| --- | --- | --- |
| No explicit ballot from any participant | Two invented approvals, validated, promoted | Missing votes, no approval |
| Three explicit reject ballots | Conditional success, report promoted | Rejected, no promotion |
| Failed wait | Validated, all participant terminals dismissed | Incomplete, preserve recovery |
| Blocked wait | Validated, all participant terminals dismissed | Blocked, preserve recovery |
| One approve and two corrupt ballot files | Quorum met, approval rate 100%, passed | Invalid ballots excluded from valid quorum, no approval |

Reproduction and raw results are in the ignored local review folder `.council/owner-review/`. These findings supersede the blanket release sign-off in the historical combined review.

Owner integration fixtures were also collected from the installed `hc`, using owned Node helpers reporting OSC 7501 state. Actual wait payloads showed `idle` and `blocked` with `ended: true`, `working` with `reason: timeout` and `ended: false`, and an initial `done` at turn 0 without any executed task. Neither exit code 0, `ended: true`, nor an uncorrelated status word proves completion. All fixture terminals were removed after collection. Raw payloads: `.council/owner-review/hc-real-wait.json`.

## Owner decision: screen evidence cannot authorize

Independent probes confirmed that a quoted author's vote can be attributed to a reviewer, even overriding the reviewer's later explicit rejection. Screen scraping cannot establish ballot provenance.

- Only valid direct ballots bound to the session, expected voter, round and exact proposal digest can authorize promotion, after that participant's turn completes successfully.
- Screen output and parsed markers remain informational. They do not contribute to the authorizing quorum. Preserve their text and dissent without claiming agent endorsement.
- If a workflow finishes with screen evidence but insufficient direct ballots, return a readable provisional report with next actions: `success: false`, `status: provisional`, `authorized: false`. Save it under `validation/`, not as an approved report under `reports/`. Keep CLI/MCP failure signaling consistent with the existing result contract.
- Read-only agents can always return useful screen output. They must not be asked to circumvent read-only permissions to create files. Direct submission through an available permitted channel can authorize; otherwise the provisional result is honest and useful.
- Do not build quote/fence heuristics to turn screen text into authorization. A checksum proves content consistency, not authorship.

The owner's workflow probes are being updated accordingly: positive cases use explicit direct ballots, while a new screen-only case must remain provisional. Negative execution cases also carry direct approvals so an execution failure cannot be hidden behind a separate missing-quorum failure.

## Test ownership assignment

Junie is explicitly authorized to create and own `tests/acceptance.test.js`, in addition to the independent review document and scratch probes. This is an exception to the earlier read-only test restriction, not permission to edit implementation or other existing tests. The new file should preserve the independent workflow/delegate/wait contracts as ordinary `node:test` regressions in isolated temporary directories, without depending on the ignored owner scratch folder. Antigravity retains ownership of product code and all other existing tests. Junie may commit only the new test file before the implementation checkpoint and then audit the stable implementation hash.

## Next product increment, after reliability acceptance

The next priority is supervising existing Herdr agents, matching the user's actual Antigravity/Junie workflow. Do not implement this until the current gates pass.

1. **Reuse explicitly selected terminals.** Attach a bounded task to terminal addresses the user selected, record the starting turn and task delivery, and leave those borrowed terminals alive after completion. Never clean up a terminal merely because its name matches a role. Acceptance: one Council session coordinates the existing Antigravity and Junie without launching duplicates or interrupting unrelated work.
2. **Start, inspect, and retrieve without holding the host tool call open.** Return the session ID, participant addresses, state and next action promptly; let the host inspect progress and collect the final report later. Acceptance: progress/read/steering remain usable while an agent works, and stopping/restarting the client does not manufacture completion.
3. **Review concrete work.** Freeze a bounded diff or proposal, identify its revision, collect independent findings with file/line references, and produce an actionable list of fixes and owners. Acceptance: a real change is improved by the review and unresolved dissent stays visible.

Useful reports and recoverable execution take precedence over additional voting rounds, retention policies, more modes, or unverified host packaging.

## Closing handoff

After Antigravity's implementation and Junie's frozen acceptance tests (`b7afe33`), the owner took the final runtime/report/metadata fixes and integration commit. Antigravity is now read-only reviewer; Junie performs the independent audit of that stable commit. No implementation edits, extra feature scope or further AI smoke launches are assigned during this final audit. The owner's final suite passed 81/81; the real Codex delegation and terminal-lifetime checks passed separately, with their evidence limits recorded in the independent review.

## Acceptance decision — 2026-11-17

The owner accepts the local reliability milestone on implementation commit `c31bc9047ae7e47f1b2ab40b383ceb1e3ac97b30`. Antigravity's read-only review found no P0/P1 issues; Junie's independent audit recorded PASS in `c86866e`, with 81/81 tests, the owner gates and 36 additional persistence checks passing. The live Codex/lifetime evidence remains attributed to the tested WIP (`14b9d89` plus changes), with the positive execution branch checked against the stable implementation; it is not claimed as a fresh AI run on the final hash or proof of every host integration.

Next assignment is design only: reuse explicitly selected existing Herdr terminals and expose nonblocking session start/status/result operations. Keep production code/tests unchanged while proposing the smallest complete increment and its acceptance cases. A resume/re-tally command for provisional sessions is a later nonblocking backlog item.

## Next increment authorized — 2026-11-17

Both independent designs have been reviewed. The [next-increment brief](next-increment-brief.md) supersedes the design-only hold and authorizes a bounded asynchronous delegate path: explicit borrowed address or new participant, durable delivery attempts, a separate Herdr worker, and start/status/result. Antigravity resumes implementation in its assigned product files; Junie owns the new jobs acceptance file and new review document. Existing 81 tests stay unchanged. Async council/review and late-ballot re-tally remain backlog. Acceptance of the reliability milestone does not constitute acceptance of this new work.

## Async delegation acceptance — 2026-11-18

The owner accepts implementation commit `4f356619117518611d7a17f06306ed89b6866783` for local asynchronous delegation with one new or explicitly adopted participant. Junie's independent audit passed all 60 acceptance cases, including the eight regressions that blocked `a8ec720`. The full suite passed all 146 tests in the owner and independent runs. [Independent audit and tests](next-increment-review.md)

The owner verified the real CLI and MCP paths through Herdr on Windows with Node.js 24.14.1 and `hc 0.1.21`. In each check, a worker survived the start client's exit, reconnect reused the same job, and the borrowed terminal completed consecutive jobs from turn 12 through turns 13 and 14. Its original settings stayed intact and the saved results were retrievable from another process. A plain Node program supplied the terminal's responses. Separate process probes passed for a lost dispatch response, worker contention, and abrupt worker termination.

Council reserves an address through the deadline when delivery is uncertain. A subsequent task requires an explicit start and a fresh readiness check. An orphaned lock from a crashed worker remains available for inspection. The scope for this milestone is a single asynchronous delegation. Combining multiple existing agents in one council or review session remains a separate increment.
