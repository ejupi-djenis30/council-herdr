# Implementation plan · Synthetic secret handoff

**Branch** `codex/003-synthetic-secret-handoff` | **Source** [COU-6 specification](spec.md)

**Baseline** Council 3.7.1 at main `7bb80e5ca5e891d2d06a0b0b46f4a56acd42fc18`. Desktop 0.1.16 and hc 0.1.21 are the observed feasibility pair, subject to confirmation on the pilot package.

## Summary

Deliver one opt-in synthetic vertical slice for a managed run on a local Windows ARM64 host. Council selects and records the run. Herdr owns launch and terminal execution. A native broker binds operating-system principals to the run, controls consent and performs one reversible preparation and at most one external effect per grant. Workspace reads state and stages a metadata reference. Authority, custody and irreversible decisions are outside the mod runtime. Establish the complete boundary before enabling even the synthetic reveal path.

## Technical context

| Area | Choice |
| --- | --- |
| Runtime | Existing JS/Node package for Workspace, launch and read-only projection. Native Win32 ARM64 broker, supervisor/fixture launcher, UI and fixed fake. C++20 and a pinned Microsoft ARM64 toolchain/SQLite build are the candidate implementation baseline. |
| IPC | Versioned length-bounded Windows local named pipes with explicit ACLs, mutual peer checks and per-channel command allowlists. Private adapter/fake and render endpoints. |
| Storage | Dedicated service identity, protected local NTFS and SQLite WAL/FULL. Current-user DPAPI for retained synthetic data under a loaded broker profile. |
| Provisioning | Separate explicitly installed isolated Windows test package. Administrator provisions dedicated accounts, signed/hash-pinned binaries, paths and ACL/pins. Local operator console and supervised one-role run. No hosted routing or package-triggered service install. |
| Testing | Existing Node regressions, native unit/fault tests, installed ARM64 OS checks and transport with a deterministic native fixture under actual Herdr. Record all separately. |
| Performance | Single project and one fixed route. Put finite bounds on messages, calls and reveal lifetime. Report timings from durable decisions without making a throughput claim. |

## Council constraints

- Preserve managed and adopted delegation behavior. Use installed `hc --skill` for launched terminal lifecycles and preserve uncertain delivery.
- Use the supervisor trust boundary for enrollment and keep operator decisions inside authenticated native UI. A worker exit, result, formal vote or Workspace gesture cannot authorize use. Normal project flows remain usable when unavailable.
- Keep implementation independent of COU-8 decision persistence and COU-9 publication. Treat the existing managed run as an input contract. Runtime changes must preserve existing callers and tests.
- The full matrix implementation, dependency installation, package wiring and native evidence run begin only after the separate independent spec review. Per-platform independent pilot review gates any later real-value decision.

## Delivery slices and file ownership

1. **Constrained feasibility** proves protected process launch from a genuinely managed Herdr run, the operator's dedicated session and safe disabled behavior. Candidate code roots are `native/secret-handoff/windows/` and `test/secret-handoff/` under the native owner. Freeze the verified packaged architecture and ownership before widening the branch. If the host cannot supply trusted enrollment or UI isolation, record the proof gap and keep the capability unavailable.
2. **Native vertical paths and state** add broker protocol, fixture fake, durable store, A operation and B reveal. Native owner also owns ARM64-only installer/provisioning assets inside the isolated pilot package and its native test harness. Shared installer or workflow changes require integration owner review.
3. **Integration and review** adds Council launch/identity bridge using the existing managed job path and Workspace read-only UI via [the contracts](contracts/authority.md). Integration owner owns existing `lib/`, `bin/`, runtime and package wiring. Workspace owner confines UI to `herdr/mods/council/` plus matching frontend test fixtures. Agree on shared entry points before concurrent edits. An independent reviewer receives exact combined commit and package digest, sanitized evidence and unresolved gaps.

## Spec Kit outputs

- [Feasibility and decisions](research.md)
- [Threat model](threat-model.md)
- [Data model](data-model.md)
- [Authority and enrollment](contracts/authority.md)
- [Requests and effects](contracts/requests-and-effects.md)
- [Workspace and native UI](contracts/operator-ui.md)
- [Acceptance matrix and leakage evidence](test-plan.md)
- [Implementation tasks](tasks.md) and [verification quickstart](quickstart.md)
