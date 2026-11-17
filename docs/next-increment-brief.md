# Next increment: asynchronous single-task delegation

Owner decision, 2026-11-17. Owner: Codex (`t10k`); implementation:
Antigravity (`t106`); independent acceptance: Junie (`t10c`). The accepted
reliability baseline remains `c31bc90`, with 81 existing tests unchanged.
This brief supersedes the previous design-only assignment for this increment.

## Review of the two design proposals

Both proposals correctly choose durable local state, explicit terminal addresses,
separate ownership and additive interfaces. Approved with these corrections:

1. A state file cannot advance execution after the client exits. Use a small
   Node worker running visibly under Herdr, independent of the short-lived
   start client. No new daemon, production dependency or database is needed.
2. Recording delivery only after sending leaves a crash window. Persist the
   attempt before the side effect. An interrupted/ambiguous attempt must never
   become an automatic retry. Do not claim exactly-once delivery.
3. An existing terminal may start at turn 12. Completion must be newer than its
   captured baseline and follow acknowledged task delivery; `turn >= 1`, an old
   screen containing the brief, or exit code zero alone cannot establish this.
4. Borrowed means Council never tears down or changes that terminal's lifetime,
   recovery, permissions or directory. Its original parent or user can still
   terminate it. Do not change it to promise global survival.
5. `hc get` has observed state/status/turn, not a wait reason. Preserve actual
   payloads and distinguish snapshots from the worker's last wait response.

## Bounded product scope

Implement one asynchronous **delegate** job with one participant, either newly
launched using the existing agent recipes or explicitly adopted by address.
Existing synchronous delegate/council/review remain unchanged. Async council,
review, new rounds, late-ballot re-tally and general workflow scheduling remain
backlog. Do not launch additional AI agents during implementation/testing.

Add CLI `start --mode delegate --task <text> --agent <agent>` with optional
`--adopt <address>`, `--session <id>`, `--timeout <seconds>` and `--keep`.
Permission defaults to read; borrowed terminals keep their actual permissions.
Add `status --session <id>` and `result --session <id>`. Existing `status`
without a session keeps its behavior. Add MCP tools `council_start`,
`council_session_status`, `council_result` with equivalent structured fields.
Reject unsupported modes/invalid input before any launch or send.

`start` returns a durable session ID, current state, known addresses and next
action after dispatching a worker, without waiting for agent boot, task delivery
or completion. It may report starting with participant address still pending.
`status` and `result` do not send, launch, wait or perform cleanup. Incomplete
results explicitly say ready:false; operational failures use success:false and
consistent CLI/MCP error signaling. Delegate completion is execution, not approval
or a council verdict. Persist the collected output and its provenance.

## Driver, persistence and reconnect

- Use an additive versioned job record under `.agent_workspace/<session>/`
  (for example `job.json`); never overwrite/migrate a legacy session. Validate
  IDs and resolve paths inside the intended workspace. Do not reinitialize an
  existing session with `initSession`.
- Persist immutable inputs/fingerprint (task, agent, permission, adopted address,
  timeout/keep policy) and an absolute deadline. Reusing the same ID and inputs
  returns that job without a new worker/send. Conflicting inputs fail before I/O.
- Make job creation and worker claim exclusive across processes. Persist worker
  launch intent first; a launch with uncertain outcome cannot be repeated just
  because its address has not yet been saved. The worker claims the job before
  participant side effects. Concurrent starts must not overwrite each other.
- The worker runs as a plain Node program in `hc run --bg --outlive-parent`.
  Long launch/send/wait/read operations happen there, not synchronously in the
  MCP host's event loop. Parent/control calls must remain responsive. Worker is
  the sole execution-state writer; snapshot readers must not clobber it.
- Persist delivery transitions before side effects: planned -> attempting ->
  acknowledged, failed or uncertain. A crash between attempt and acknowledgement,
  malformed acknowledgement, or `started:false` is never evidence of delivery
  or completion. Retain evidence/addresses and show a concrete inspection action;
  never automatically submit keys, resend, relaunch or reset to planned.
- A dead/interrupted worker can be reported as recovery-needed/uncertain;
  transparent worker restart is outside this slice. Client reconnect must work
  while the independent worker continues. Corrupt/partial state fails honestly,
  without resetting delivery or erasing legacy/current records.
- Deadline is not extended by reconnect. Use bounded Herdr waits/events, no
  sleep or status-polling loops. A real deadline, blocked/error or read failure
  cannot become completed; preserve the terminal and relevant raw evidence.

## Borrowed ownership and completion

Adopt only a concrete observed address, never discover a participant by role/name.
Reject self, nonexistent/finished/unreported, blocked/error or busy working
terminals before delivery. Record observed baseline turn/status/address and
origin borrowed. Claim that address locally against concurrent Council jobs;
do not imply exclusivity against the user or unrelated tools. If readiness
changes or delivery is ambiguous, stop conservatively without forcing it.

Completion requires acknowledged delivery and a fresh done relative to the
baseline (e.g. baseline 12, done 12 is stale; done 13 may complete). Startup
idle/done turn 0 and message/blocked/timeout do not complete a job. Preserve
screen output as observed output, not proof of delivery or approval. Borrowed
clean exit alone is insufficient. Keep normal read/steering available while
the worker waits, without submitting a second initial task.

Never kill/dismiss/interrupt/reparent/change settings of borrowed terminals,
including failure, cancellation, client exit or cleanup. Newly launched agents
outlive the client/worker; cleanup only their recorded address after verified
completion, honoring keep. Incomplete/failed agents remain inspectable.
Repeated result reads must never repeat cleanup or any other side effect.

## Independent acceptance and file ownership

Antigravity owns new product modules/worker and additive changes in `lib/`,
`bin/`, plus its own new unit-test file if needed. Keep the current 81 tests
unchanged, including frozen `tests/acceptance.test.js`. No root docs or Junie
files. Prefer a small injectable job service/transport seam for deterministic
tests; share its public signatures promptly with Junie.

Junie owns only **new** `tests/jobs-acceptance.test.js` and
`docs/next-increment-review.md`, plus ignored/temp probes. No product-code,
existing-test or owner-doc edits. Independently test the public CLI/MCP/service
contract, including:

1. Same-ID concurrent/reconnect starts dispatch once; conflicting inputs fail.
2. Crash before/after delivery acknowledgement: no automatic duplicate task.
   Interrupted launch/claim and corrupt record also fail conservatively.
3. Borrowed baseline 12: stale done 12 cannot complete; acknowledged fresh done
   13 can. Idle0/done0/message and exit0 alone do not supply completion.
4. Invalid/busy/self/claimed borrowed terminal gets no send or settings change;
   no borrowed teardown under any outcome. Test a nonzero starting turn.
5. Blocked, deadline, failed read and uncertain delivery preserve evidence and
   recovery; reconnect does not reset the deadline.
6. Start returns before a deferred worker/agent completes. Status/result and an
   MCP read remain usable during work. Repeated result reads are side-effect free.
7. Owned completed cleanup happens once by recorded address; keep and failures
   preserve agents. Existing 81 tests and owner contracts remain unchanged.

Use meaningful assertions and real installed Herdr payload field shapes; mock
only the transport for deterministic regressions. Run slow tests under Herdr.
No polling for commits or waiting loops in agent turns. Commit only owned paths
and report checkpoint hash, evidence and limitations to `t10k`; then end the turn.

Owner acceptance requires stable implementation hash, independent tests/review,
old gates passing and a bounded real Herdr transport/lifetime check. A new real
AI task, if needed, is assigned explicitly by the owner after those checks.
