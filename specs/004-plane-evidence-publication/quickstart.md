# Quickstart

## Specification and implementation review

1. Read the [specification](spec.md), [provider protocol](contracts/providers.md), [CLI/MCP contract](contracts/interfaces.md) and [Workspace contract](contracts/workspace.md) at the frozen commit. Check the baseline merge and request bodies before starting development.
2. In a disposable test root create two local same-named projects and configure the two same-named remote scopes in [examples.json](contracts/examples.json). Run the fixture GitHub/Plane provider and ensure the test client is isolated from configured production credentials.
3. Run the [acceptance vectors](test-plan.md), `npm test`, `node bin/council.js doctor` and ordinary installed package smoke. Record results and revision. An installed package starts disabled, including from CLI/MCP.
4. Verify after restart that `council work-item plane show --id <itemId>` can report the original reference, scope and outcome when the implementation exists. Show never contacts Plane.

## Installed engagement after G3 approval

1. Provision the approved dedicated Plane test item, distinct operator/worker identities and key in the protected publisher context. Verify ordinary users cannot read, replace or drive that context. Verify local durability and Plane role, audience, exact v1 routes and receipt shape.
2. On the accepted Windows ARM64 profile, start from Workspace, choose the Council work item and use “Link Plane item”. In the authenticated operator console choose the configured instance/project, resolve the existing issue, verify full identity and confirm the link. Return to the same item in Workspace.
3. Use “Prepare Plane update”, enter a known public allowed GitHub PR/commit URL and inspect the destination, exact outbound status, canonical URL, visibility and reference. Confirm one publication. Check one internal comment and the durable positive receipt and compare unchanged planning fields.
4. In a separate approved fixture/deployment-gate trial, drop the response after the server commits, restart, choose “Check delivery” and prove a recovered original receipt with zero additional POSTs. Simulate offline before Start and ensure the next action requires fresh confirmation. Return to normal Council work while disconnected.
5. Save only redacted evidence, including the combined tree, tool versions, observed platform, role/visibility coverage and exact receipt counts. Publish neither a live credential nor task content in the evidence.
