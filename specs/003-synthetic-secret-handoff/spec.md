# Feature specification · Synthetic secret handoff

**Feature branch** `codex/003-synthetic-secret-handoff`

**Created** 2026-11-28

**Status** Proposed for independent specification review

**Product authority** COU-6 decision `7a1b7ce3-4c6b-4189-baa1-7538136844f4` and acceptance matrix `d3c1d24b-5d61-4f4b-abae-ab85408c8fb2`. The [accepted product brief](../../docs/herdr-project-product-brief.md#secret-handoff-design) sets the broader roadmap.

## User scenarios and testing

### US1 · Let a managed participant use a named operation (P1)

A local operator offers a synthetic entry to an enrolled participant, or the participant requests the fixed operation. The operator can identify both parties and the run in a native prompt. The participant consumes the approval from its verified execution context and receives an outcome and receipt ID. The fake service verifies the canary internally.

**Independent test** Run A01 and A02, then check that the fake has zero invocations before the authorized participant invokes and one matching effect afterward. Confirm the participant receives the allowlisted receipt.

### US2 · Receive a named output from a managed participant (P1)

The enrolled participant explicitly offers the named synthetic output, either on its initiative or after an operator request. The adapter generates it inside the broker. The authenticated operator accepts and then chooses **Show once** in the native UI. The participant can retrieve receipt metadata.

**Independent test** Run B01 and B02. Count one render, no second render, and three independently attributed request, offer and acceptance events in B02. Compare the value inside the reveal surface and export the comparison outcome.

### US3 · Keep control through failure and restart (P1)

An operator can decline, cancel an authorized pending request, revoke a grant, or return after interruption to a known receipt or an unresolved attempt. Wrong actors, replacements and changed routes lose access. Reopening through Workspace preserves the next action and never triggers delivery.

**Independent test** Run C01–C10, force both sides of the revocation race and every crash cut in both directions, and verify zero forbidden canary occurrences with a working detector.

## Requirements

- **FR-001** The pilot MUST use a local Windows ARM64 test host, one local project, generated synthetic entries, one fixed operation with two directions, one registered adapter and one controlled fake service. Pilot mode defaults to unavailable and requires explicit local provisioning. Real entry, import, paste, OS-vault export, arbitrary destinations, raw delivery to an agent, other hosts and additional provider adapters are outside this feature.
- **FR-002** The broker MUST bind a managed participant enrollment to the verified project, live Council run and native process generation. OS user, role display name, PID, Herdr address and request ID by themselves carry zero authority. Borrowed terminals cannot enroll. The broker and native peers MUST restrict each local pipe opener to identification-only security QoS and verify the effective Windows token level before granting authority.
- **FR-003** Consent MUST bind the immutable request revision, verified initiator and recipient principal, project, run, generation, direction, purpose, exact fixed operation and destination, absolute UTC expiry, one-use limit and authenticated operator. Any change to those terms needs a fresh request and consent.
- **FR-004** Direction A MUST support operator offers and participant requests. Only native operator approval followed by the enrolled recipient's invocation allows use. Consent MUST immutably bind the exact selected synthetic entry and version in broker-private state. Claim and Start MUST verify that binding. Replacement, missing entry or mismatch requires fresh consent and cannot substitute another value. The participant receives a typed receipt.
- **FR-005** Direction B MUST support participant offers and operator requests. An explicit offer from the verified participant stages a distinct generated output. The designated authenticated operator accepts explicitly and separately selects **Show once**. Only the protected native control may display the value. A request, an offer or accepting alone cannot reveal it.
- **FR-006** Workspace MUST show metadata, availability and a next action. Its launch path passes a non-authorizing reference to a fixed, verified local helper. The operator MUST be able to recognize the requester and recipient from broker-verified identities on an authenticated native surface. Close is passive. Deny and authorized pre-approval cancel are distinct terminal outcomes.
- **FR-007** An approved grant MUST default to one use within five minutes and have a 15-minute ceiling, bounded by the run deadline and immutable request expiry. Zero or negative time remaining, clock rollback, run end, replacement or stale generation must fail closed. A restart MUST preserve the original absolute expiry while invalidating any unused approval and prior enrollment.
- **FR-008** The broker MUST serialize claim, decline/cancel, expiry, generation invalidation and revocation with the first irreversible dispatch or reveal. One winner can proceed. Late revocation blocks future use, preserves history and exposes the limits of local recall.
- **FR-009** The broker MUST durably record the original attempt before the irreversible boundary. Identical requests are idempotent, conflicting reuse is explicit, and interrupted effects resolve to the durable receipt, authenticated reconciliation or visible uncertainty with no replay. A lost reveal acknowledgement may remain unresolved and cannot lead to another render.
- **FR-010** Sensitive bytes MUST remain within broker custody, protected storage, authorized fixed adapter/fake channel and deliberate protected native rendering. Outside these surfaces, structured errors, receipts and audit carry allowlisted metadata only. Normal work items, formal Council votes and Plane state confer no authority over any handoff.
- **FR-011** Unsupported or unavailable storage, UI, runtime identity or route MUST fail closed. Council's ordinary project workflow continues independently. Provisioning failure, no authenticated operator, a wrong OS session and any attempted remote launch leave the protected action unavailable.
- **FR-012** A reviewer MUST be able to trace all 14 accepted cases to the contracts and evidence. Independent review of this specification gates implementation. A separate independent review of the pilot and per-platform boundaries gates any future real-value enablement.

## Acceptance

- **SC-001** A01, A02, B01 and B02 each pass using the installed local ARM64 stack, with exactly one authorized dispatch or reveal and correct attribution. Two-entry variants prove authorized selection and deny pre-Start substitution. The ARM64 record identifies the package, OS build, architecture, Desktop, core and participant type.
- **SC-002** C01–C09 pass with per-variant receipts, ordered durable events and independent invocation, effect and reveal counts. Invalid, expired and refused uses initiate zero effects and zero reveals. Recovery initiates zero replays. Every installed pilot pipe role has native proof of identification-only QoS and safe rejection of excess or unverifiable authority.
- **SC-003** C10 records zero forbidden matches across the listed surfaces with isolated positive controls for the scanner. Unobserved required surfaces fail the gate.
- **SC-004** A person can verify the requester, distinguish terms and actions, and complete the native flow from the keyboard with visible focus. Supported accessibility output exposes metadata and controls, keeping the canary out of assistive APIs and evidence.
- **SC-005** The regular Council suite and package smoke retain their supported behavior. Native pilot, mocked controls, live Herdr fixture transport and any later real-agent result have separate evidence.

See the [implementation plan](plan.md), [threat model](threat-model.md), [authority contract](contracts/authority.md), [request and effect contract](contracts/requests-and-effects.md), [Workspace and operator UI contract](contracts/operator-ui.md) and [acceptance matrix](test-plan.md).
