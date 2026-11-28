# Quickstart: Create, delegate and reopen

Use these steps on a build containing the work-item implementation. Run them in an isolated project and verify any real agent launch is explicitly assigned. Examples assume the repository CLI or an installed equivalent is available as `council`.

## CLI

From the project, configure a read-only Team role if the project lacks one:

```sh
council team set verifier --agent codex --role "Read-only verifier" --permission read
```

Save a UTF-8 `work-item.json`:

```json
{
  "id": "wi-project-readme",
  "title": "Summarize the project README",
  "roleId": "verifier",
  "criteria": [
    "Quote the first Markdown heading exactly.",
    "Name one section from that file.",
    "Report one next action for the lead."
  ]
}
```

```sh
council work-item create --input-file work-item.json
council work-item list
council work-item delegate --id wi-project-readme --timeout 180
```

Exit that Council client or terminal. From another client in the same project:

```sh
council work-item show --id wi-project-readme
```

If the resulting state is In progress, reopen it after the member returns. For Needs attention, read the saved next action and original session ID before taking further action. Result ready shows the response and evidence source. Compare it to the three criteria. Use `council status --session <linked-id>` or `council result --session <linked-id>` from the same project when you need execution details.

## MCP

Use `council_work_item_create` with the JSON above, plus an absolute `project` when the server requires one. Call `council_work_item_delegate` with the same `id` and an optional `timeoutSec`. From a new MCP process or turn, call `council_work_item_show` with that `id` and the same project. `council_work_item_list` discovers prior IDs in the project.

## Herdr Desktop

1. Focus or pin the project. Open **Council → Workspace → Work items**.
2. Choose **New work item**, enter the title and one criterion per line, select the responsible role and save. Use another ID or a fresh project for a separate test run.
3. Open the saved item and choose **Delegate**. You can leave Workspace while the job runs.
4. Reopen the item (or open the same one previously created by CLI/MCP), review its state and next action, and use **Open delegation** if the session is verified. Compare the result with the saved criteria.

## Recover after a lost reply

Reconnect with `show` for the same item in the same project. A repeated delegate can inspect the original intent but cannot start another job for the item. If the item shows an unconfirmed start, inspect the reserved session and associated Herdr activity, then refresh. Leave the original intent in place so a late job remains attributable.
