# Verification quickstart

## Review the specification

1. Read the [specification](spec.md), the [threat model](threat-model.md) and the [14-case matrix](test-plan.md). Compare against the published COU-6 acceptance matrix and CEO decision listed in the spec header.
2. Walk each native and Workspace command through [authority](contracts/authority.md), the [effect fences](contracts/requests-and-effects.md) and the [operator path](contracts/operator-ui.md). Confirm what survives restart, which peer can act, and how each trace proves that the original attempt was preserved.
3. Record independent review against the exact spec commit and contract bytes. Baseline repository checks are `npm test` and `node bin/council.js doctor`. The pilot has no runnable product entry point at specification review.

## Run the pilot after implementation is approved

1. Use a disposable local Windows ARM64 environment and the provisioned native package, clean isolated Herdr profile and one eligible project. Record package digest, OS build, binaries and installed versions. Verify core, broker and restricted principals, active operator console, store isolation, offline/fake route and absence of provider credentials. A failed precondition ends the run with an unavailable observation.
2. Follow `hc --skill` for the managed fixture launch and terminal lifecycle. Launch one owned enrolled fixture and a separate unregistered decoy under its OS account. Confirm Workspace can show the project’s metadata and stage a reference without operating the broker.
3. From its own Windows sign-in, the operator opens the installed native prompt. Run the two A sequences and two B sequences with internally generated values. Review the pinned fields, expiry, actor attribution and one-use behaviour. For A, run both selectable entries and the replacement variants before Claim and Start. Verify B by an in-process comparison with no screenshot during reveal.
4. Run C01–C10 with isolated case records and both directions where specified. Observe effective pipe QoS at the installed Windows receiver for every channel role. Force crashes with barriers and inspect the original effect ID and count before and after restart. Check known receipt versus unresolved result without replay.
5. Collect only the [sanitized evidence](test-plan.md#evidence-to-publish) and run ordinary package and regression checks. Close only completed owned fixture terminals. Keep evidence from simulations, live Herdr fixture, native OS and any later real harness separate.

The approved target is synthetic Windows ARM64. Report the exact platform, controls exercised and gaps. A synthetic success is the input to a separate independent pilot review.
