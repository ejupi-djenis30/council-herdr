# Quickstart: Review and reopen an item

Use a combined build containing COU-8 in an isolated project. Existing COU-2 items are readable on the upgraded build. The example uses an available read-only role called `verifier` and an item called `wi-release-check`. Use an authorized member or the deterministic fixture for tests that send work.

## Triage and delegate with CLI or MCP

Read current state using `council work-item show --id wi-release-check`. To set priority and the next action on a newly created item at revision 1, save the following UTF-8 JSON as `triage.json`:

```json
{
  "id": "wi-release-check",
  "ifRevision": 1,
  "requestId": "triage-1",
  "actor": "Lead",
  "patch": {
    "priority": "high",
    "nextAction": "Ask the verifier to check the release notes."
  }
}
```

```sh
council work-item triage --input-file triage.json
council work-item list --role verifier --state open --sort priority
council work-item delegate --id wi-release-check --if-revision 2 --request-id delegate-1 --actor Lead
```

Use the revision actually returned by your client. Omit a new dispatch if an existing attempt already has a saved intent. A later client opens the same item and session using `show` and can look up the reservation with `history --id wi-release-check --request-id delegate-1`. Continue after the item shows a verified saved handoff.

## Freeze and confirm acceptance

1. Run `council work-item review start --input-file review.json` with the common mutation fields, `reviewOwnerRoleId: "verifier"` and `policy: "operator"`.
2. Read the returned review and verify the criteria, attempt ID, capture label and snapshot. Optionally record a finding or dissent through `review note` using an independent request ID.
3. Run `council work-item close --input-file close.json` with the current common fields, review ID, evidence token, `decision: "accept"`, concrete reason and next action. Use the exact token from your current review.
4. Close the client and open it again. Use `council work-item history --id wi-release-check` to inspect the decision and `show --id wi-release-check --review-id <review-id>` for the frozen bytes and metadata.
5. Reopen with `council work-item reopen --input-file reopen.json`. Supply the current common fields, close decision ID, frozen snapshot digest, reason, responsible `roleId` and next action. Inspect the new cycle. Delegate again only if you explicitly want a new attempt.

For formal policy, include the [binding line](contracts/formal-review.md) in the completed author proposal of an existing formal Council review. Attach the verified session ID and round using `review attach`. Inspect its outcome before attempting closure. A rejected or provisional outcome remains visible. A lead can use `review return` to record a rework decision.

The corresponding MCP tools take the same request fields. Add `action` to review calls and use the same absolute `project` whenever needed. After losing a reply, read history for the original request ID in the original project. Retry only deliberately with the same original fields or make a fresh decision on the latest revision.

## Herdr Workspace

1. Focus or pin the project and open **Workspace → Work items**. Inspect priority and the role, state and attention filters.
2. Open the item and triage it. Delegate if needed. Reopen after the result is ready and select **Start review**.
3. Read the frozen capture, criteria and findings. Record explicit acceptance or return for changes. Close and reopen the app, inspect History and reopen the closed item with a responsible role and next action.
4. Confirm that the new cycle and the old evidence are visible separately. A loss of response calls for a read-only refresh on the original project. Keep the original intent and session when delivery is uncertain.
