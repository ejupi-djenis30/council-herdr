# Async delegate — independent acceptance review

Status: **PASS — independent acceptance of candidate `4f35661`**.
The restart checkpoint was `2e83cc6`; the reliability milestone `c31bc90`
is a different, previously accepted scope. This document and
`tests/jobs-acceptance.test.js` are owned by the independent reviewer;
product code and existing tests are not.

## Final candidate: `4f356619117518611d7a17f06306ed89b6866783`

- The tracked product tree was clean at this exact commit before and after the
  runs; only these two reviewer-owned files were untracked. The acceptance test
  Git blob was `0d86b56130f9b077ee572aec71a473fd24498d56`.
- Independent acceptance, `node --test --test-timeout=5000
  tests/jobs-acceptance.test.js`, ran under Herdr terminal `t161`: **60/60
  passed**, exit 0. All eight release-gate regressions listed below passed:
  deadline before send, uncertain borrowed claim, owned exit-zero, message
  followed by fresh done, terminal name, recovery address, failed dispatch,
  and truncated completed record. The previous failure descriptions remain
  historical evidence for `a8ec720`, not findings on `4f35661`.
- Independent full suite, `node --test --test-timeout=5000 tests/*.test.js`,
  ran under `t162`: **146/146 passed**, exit 0, including the 60 acceptance
  cases and the existing baseline. CLI result and MCP cases exercise the public
  surface with simulated worker/participant transport; raw Herdr wait payloads
  are simulated through the actual adapter. No live AI or participant was run
  by this reviewer.
- The PO separately reports passing checks on the same product hash: 146/146,
  live CLI/MCP with a plain Node borrowed helper (turns 12 to 13 and 14),
  durable result, reconnect without another send, responsive read and preserved
  borrowed settings/lifetime. The PO also reports process-race/crash and lost
  dispatch ACK checks, candidate-edge 5/5 and wait 3/3. These are **owner
  evidence**, not independent reviewer executions or a new AI smoke test.

## Candidate audit: `a8ec7204621908e7f63c697223f08f3d93a6a605`

- The pre-extension suite, run under Herdr terminal `t14k`, passed **134/134**:
  the existing 81, five new product tests and 48 independent cases. This does
  not cover the edge cases below.
- The expanded independent suite, `node --test --test-timeout=5000
  tests/jobs-acceptance.test.js`, ran under `t14y`: **52/60 passed, eight
  failed**, process exit 1. Its test-file Git blob hash was
  `0d86b56130f9b077ee572aec71a473fd24498d56`. CLI pending/ready/missing-result
  and MCP start/result/status success/error tests passed with simulated worker
  and participant transport. Actual `HerdrClient.wait` parsing was exercised
  with simulated raw process responses, not a live `hc` subprocess.
- Before and after this run, tracked product files were clean at `a8ec720`;
  blob hashes for `lib/jobs.js`, `lib/job-worker.js`, `lib/herdr.js` were
  respectively `47c45cd47c0de4d7b730acccce23830306fa0fd5`,
  `3e3b6fdc69e3d657800d3bdeade9874523f4cdee`, and
  `ac279d41136d1f9cf6ae64ad0a47db45362444f0`. Only the two reviewer-owned
  files were untracked. These blob hashes are not commit hashes.

### Release-gate reproductions

All eight are deterministic, isolated-temp, mocked-transport tests in
`tests/jobs-acceptance.test.js`; their names identify the exact assertions.
The first three are additional independent findings, while the remaining five
independently reproduce the owner's candidate edge checks.

1. **Deadline during borrowed readiness:** advance a simulated clock across the
   persisted deadline inside `get`; one initial send still occurs. Expected no
   send after expiry. This is a simulated timing interleaving, not a live race.
2. **Ambiguous borrowed delivery / competing claim:** after `started:null`
   leaves delivery uncertain, a second session can claim the same address before
   the original deadline. The owner confirmed retention until that deadline,
   without auto-retry or teardown; afterward only a new explicit start with
   readiness rechecked is permitted. A crash-left real lock requires an
   inspection action, not automatic reclaim.
3. **Owned exit-zero false completion:** the actual adapter classifies a raw
   `reason:exit`, exit 0, turn 0 as successful; the worker reads the screen and
   treats that as completion without a fresh task turn. No real process exited
   in this test.
4. **Owned message event:** a raw `reason:message`, `status:working` response
   through the actual adapter is treated as timeout; a queued fresh `done` is
   never consumed. Startup idle followed by done passes.
5. **Long owned session:** a valid long session generates a Herdr terminal name
   longer than 32 characters. The fixture verifies the launch argument, not a
   live Herdr rejection.
6. **Missing recovery address:** `first_message.sent:false` returns failure but
   loses the address of the already spawned participant, preventing inspection.
7. **Failed worker dispatch:** an explicit launch failure is initially reported,
   but reconnect reports success and status does not retain the failure.
8. **Partial completed record:** a valid JSON record with only schema and
   `state:completed` returns success/ready with an empty result instead of
   failing closed.

The owner's separate live CLI/MCP smoke and race checks are not reproduced by
these mocks. The owner reported normal-path smoke success and five edge-check
failures; the owner owns those artifacts and their attribution.

## Evidence collected

- An initial `node --test tests/jobs-acceptance.test.js`, launched through
  Herdr terminal `t12n`, exited 1 with `ERR_MODULE_NOT_FOUND` for
  `lib/jobs.js`. No acceptance case was executed and no product failure or
  pass can be inferred from that run.
- After the product modules appeared as untracked WIP, a single
  `node --test --test-timeout=5000 tests/jobs-acceptance.test.js` run in
  Herdr terminal `t12y` reported **48 tests: 45 pass, 3 fail**. The failures
  are reconnect to the same job while its borrowed terminal is working,
  worker progress overwritten by `start` after the launcher returns, and
  missing `council_start` in the MCP tool list (the public surface was still
  under implementation). These are WIP observations, not a final verdict.
- `git hash-object` before and after that run gave `8adda980363f12098f1b3818b9435db70540263a`
  for `lib/jobs.js`, `5737d4c6fd035e3cc0d038df90af5f86f7c6bf31` for
  `lib/job-worker.js`, and `5b687d9a3df175b3bcb5244ca261d785bf17b60d` for
  the test file. These are content hashes, **not commit hashes**. `HEAD` was
  `2e83cc67e624029e138f5e5d2dbf8c650464fcae`; the new product files were
  untracked. No implementation result is attributed to that commit.
- Before the WIP run and subsequent additions, `node --check
  tests/jobs-acceptance.test.js` exited 0 in Herdr terminal `t12v`. That
  check verified JavaScript syntax only, not imports or fixture compatibility.
- The owner's earlier `borrowed-protocol-results.json` is a real Herdr
  transport fixture, not evidence that Council's async feature works. Its
  observed sequence is reported idle turn 12, send ACK
  `{started:true,status:'idle',turn:12}`, and done turn 13. The suite copies
  these shapes rather than depending on that ignored file.
- Implementer `t12k` confirmed injectable `JobManager`/`JobWorker` and async
  hooks: `beforeAttempt` after intent persistence and before send,
  `afterAttempt` after send and before ACK persistence, and `beforeWait`
  after ACK persistence. The final acceptance suite exercises these seams.

## Acceptance coverage

The new isolated-temp suite specifies fresh versus stale turns, malformed or
inconsistent ACKs, crash windows before and after the send side effect,
reconnect without resend or repeated readiness, worker progress persistence,
fingerprint conflicts, a simultaneous borrowed
address claim, the original caller's self-adoption prohibition, invalid
borrowed states, read failure, deadline preservation/expiry, legacy and
corrupt state, deferred start, MCP read and tool discovery, and owned versus
borrowed cleanup. Hook observations are asserted outside the transport so an
implementation cannot silently absorb the assertions. It exercises no real AI
or real participant terminals.

## Remaining work and limits

- The concurrent-claim test uses two workers in one process. Cross-process
  worker/claim races and genuinely separate responsive-host behavior are covered
  by the owner's separately attributed probes, not by this suite. Mocked crashes
  demonstrate ordering and no automatic resend, not an actual OS/process crash.
- No new AI was launched by this reviewer; the owner's live test used a plain
  Node helper. Existing baseline tests were not modified. A borrowed terminal's
  lifetime is still subject to its original owner and external termination.