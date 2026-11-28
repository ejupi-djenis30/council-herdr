# Work-item CLI and MCP contract

Version 1. The Herdr Workspace uses the CLI wire format below. All operations address one local project. The CLI defaults to its working directory and accepts optional `--project <absolute-folder>`. MCP uses its configured default project or requires explicit `project`, following the current project guard. Resolve the folder through the native filesystem. IDs are project-local.

| Operation | CLI arguments after `council work-item` | MCP tool | Input |
| --- | --- | --- | --- |
| Create | `create --input-json <JSON>` or `create --input-file <UTF-8 JSON>` | `council_work_item_create` | `{id, title, roleId, criteria}` |
| List | `list` | `council_work_item_list` | `{}` |
| Show | `show --id <id>` | `council_work_item_show` | `{id}` |
| Delegate | `delegate --id <id> [--timeout <seconds>]` | `council_work_item_delegate` | `{id, timeoutSec?}` |

MCP also accepts optional `project` on each tool. Reject unknown input keys, conflicting input sources, missing values and invalid IDs. Do not quietly sanitize an ID to a different one. `work-item help` and top-level help show the operations. The four operations emit one JSON object to CLI stdout, including typed failures. Exit 0 for a successfully read or persisted envelope. Use a nonzero exit for an error envelope. Stderr remains available for launcher diagnostics. MCP returns the same JSON in a text content block and sets `isError` only for error envelopes.

## Input constraints

| Field | Accepted input |
| --- | --- |
| `id` | `^wi-[a-z0-9][a-z0-9-]{0,59}$`. Chosen by the client before submission. The Workspace generates a unique ID for the form |
| `title` | String, trimmed, 1–160 UTF-16 code units, one line |
| `roleId` | Existing Team member ID, matching Team's `^[a-z][a-z0-9-]{0,31}$` |
| `criteria` | Ordered array of 1–12 nonblank trimmed strings, single line per string, at most 500 UTF-16 code units each. Reject NUL and control characters in all user text |
| `timeoutSec` | Integer from 1 to 3600. Default 180. On an item with an intent, a different explicit timeout returns conflict. Omitting it reopens the saved intent |

Replay create by normalized title, criteria in their original order and role ID. A matching existing item is returned even if the role was subsequently removed. Validate presence of a role for a new item or a new delegation only. Delegation takes no task, member address, model, agent or permission overrides.

## Responses

- List success is `{success: true, project, items, errors}`. `items` contains summaries ordered by `createdAt` descending, then `id` ascending using ASCII comparison. `errors` contains zero or more `{id, code: "integrity_error", message}` for unreadable item definitions. An identifiable item with a damaged intent is an attention item. List does not probe Herdr or include output.
- Create/show/delegate success is `{success: true, project, item}` with detail. Create replay may return its latest detail.
- Failure is `{success: false, project, error: {code, message}}`, with `project: null` until a valid project has been resolved. Codes are `invalid_input`, `not_found`, `role_unavailable`, `conflict`, `integrity_error`, and `storage_error`. Job failure and unresolved delivery are successful item inspections with attention state.

| Summary field | Type and meaning |
| --- | --- |
| `id`, `title`, `roleId`, `createdAt` | Strings. UTC ISO 8601 time |
| `state` | `draft`, `in_progress`, `needs_attention`, or `result_ready` |
| `nextAction` | Nonempty human-readable instruction |
| `canDelegate` | Boolean. True only for draft. Delegate revalidates the current role |
| `job` | Null or `{sessionId, linked, outcome, deliveryState, deadlineAt, address}`. `linked` is boolean. `outcome` is a string. The last three fields are nullable strings |
| `attention` | Null or `{code, message}`. Use the job outcome as code when derived from a linked job |

Detail adds `criteria` and `result` (always present, null until a verified capture). Result is `{output, source, captureScope, artifactPath, turn, completedAt}`. `output` is the saved text, `source` is `direct_artifact` or `terminal_screen`, `captureScope` and `artifactPath` are nullable strings, `turn` is a nullable integer, and `completedAt` is a nullable UTC timestamp. Base provenance on the original capture. The existing Team worker emits terminal captures in this increment. Only use direct_artifact for evidence explicitly identified as a direct submission by the job. An artifact path containing persisted terminal output is still screen evidence. Use a path only when the underlying result supplies a verified contained artifact reference. Relative references are resolved within the verified job directory. All supported captures are handoffs requiring lead review.

`job.linked` is true only after validation of the persisted binding, session and participant role. An unconfirmed start can show its reserved `sessionId` with `linked: false` and `outcome: "unconfirmed_start"`. A corrupt intent with no trustworthy session exposes `job: null`. An observed but mismatched job has `linked: false`, `outcome: "integrity_error"`, and its result and terminal address remain unavailable.

Representative wire objects are in [examples.json](examples.json). Job projection rules are in [the data model](../data-model.md).
