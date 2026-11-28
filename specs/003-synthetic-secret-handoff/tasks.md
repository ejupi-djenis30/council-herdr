# Tasks · Synthetic secret handoff

Tasks remain pending until the preceding acceptance gate is recorded. The 14 accepted case identifiers refer to [the matrix](test-plan.md).

## Phase 1 · Independent specification gate

- [ ] T001 Publish exact spec SHA and contract digests. Record independent review and approval for the synthetic scope in COU-6 before opening implementation.
- [ ] T002 [P] Provision isolated Windows ARM64 package, NTFS custody, dedicated launch/participant/operator/service principals and restricted endpoints. Record OS/toolchain/Herdr versions and package identity.
- [ ] T003 Establish managed Herdr fixture launch and enrollment with stable role, generation and live OS handle. First run same-user, alternate user, borrowed-process, stale generation and wrong-project negative controls (C07/C09).
- [ ] T004 Establish dedicated operator console, measured UI, process/session pinning and participant-denied capture and injection checks. Verify disabled path and metadata/keyboard entry (C01/C10). If either T003 or T004 fails, stop enabling protected actions and return recorded feasibility evidence.

## Phase 2 · Durable foundation

- [ ] T005 Build versioned, bounded, mutually authenticated local IPC and fixed command/response schemas. Add explicit identification-only opens, server-side effective-level checks on each actual channel and scope, caller, unsafe-QoS, pipe collision, remote and redirect controls (C01/C04/C07/C09).
- [ ] T006 Implement broker-owned durable records and encrypted synthetic storage using the scoped service identity. Verify ACLs on DB/WAL/temp, positive DPAPI reopen, authenticated immutable A entry versions and locked/denied/unavailable storage (A01/C08/C10).
- [ ] T007 Implement immutable requests, attributed decisions, monotonic and UTC expiry, restart invalidation and unique claims. Cover refusal/cancellation, expiry and revoked-before-start variants (C02–C05).
- [ ] T008 Add durable Start and receipt fences shared by A and B. Wire deterministic race/crash barriers for both sides of Start and receipt, metadata-only lookup and reconciliation (C04–C08).

## Phase 3 · User story A

- [ ] T009 [US1] Add enrolled participant request and native U offer with exact synthetic entry/version binding, checks at Claim and Start, no substitution on replacement, and the two-entry regression (A01/A02).
- [ ] T010 [US1] Implement the approved one-shot fixed dispatch, ordinary typed participant receipt and positive independently retained fake proof for reconciliation (A01/A02/C05/C06/C08/C09).

## Phase 4 · User story B

- [ ] T011 [US2] Implement operator request, authenticated participant offer, protected synthetic staging, explicit operator acceptance and separate Show once (B01/B02).
- [ ] T012 [US2] Implement one-shot native renderer, local clearing, typed acknowledgement and loss/uncertain behavior. Confirm no clipboard/accessibility export and zero second render (B01/B02/C05/C06/C08/C10).

## Phase 5 · Workspace and integration

- [ ] T013 [US3] Wire read-only status, scope-safe selection, native reference-only opening, current receipt and expiry/revocation/uncertainty next steps (C01/C02/C06/C08).
- [ ] T014 [P] [US3] Build in-boundary leakage comparator and controls, independent counters, fixture evidence writer and metadata-only audit checks (C10).
- [ ] T015 Run A01–A02, B01–B02 and C01–C10 on the packaged ARM64 host, plus regular Council and package/disabled-path regressions. Publish exact artifact digests, build, test layers, coverage outcomes and gaps.
- [ ] T016 Record independent review of full combined synthetic pilot. Keep real-value enablement out of this increment and gated on separate independent per-platform verification.

T002 precedes T003/T004. T003 and T004 gate T005–T008 and any value-bearing fixture path. T009/T010 and T011/T012 share the same state and route authority. T013 and T014 can proceed after their interface dependencies; T015 depends on both directions, integration and coverage. T016 depends on the evidence from T015.
