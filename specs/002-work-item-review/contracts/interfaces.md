# CLI and MCP work-item lifecycle contract

This implementation amendment adds a single policy field to the [frozen COU-8 interface contract](https://github.com/Ejupi-Labs/council-herdr/blob/e43ae3d4f7cf567bd9b1e3c4aca06f05dfa8a52a/specs/002-work-item-review/contracts/interfaces.md).

The [COU-2 inputs and responses](../../001-work-items/contracts/interfaces.md) remain the base. Project scope, canonical local identity, flag-only CLI output, exit codes and MCP text JSON with `isError` stay consistent. The CLI defaults to cwd and accepts `--project <absolute-folder>`. MCP requires explicit `project` when the configured project guard requires it. Stderr remains for diagnostics.

## Operations

| Operation | CLI after `council work-item` | MCP tool or options |
| --- | --- | --- |
| Create | existing `create --input-json` or `--input-file` | existing `council_work_item_create` |
| List | `list [--role <id>] [--state <lifecycle-state>] [--needs-attention] [--sort created\|priority]` | existing `council_work_item_list` gains optional `roleId, lifecycleState, needsAttention, sort` |
| Show | `show --id <id> [--review-id <reviewId>]` | existing `council_work_item_show` gains optional `reviewId`, returning its frozen review in `archivedReview` |
| Triage | `triage --input-json <JSON>` or `--input-file <path>` | `council_work_item_triage` |
| Delegate | `delegate --id <id> [--timeout <seconds>] [--if-revision <rev> --request-id <key> --actor <name>]` | existing `council_work_item_delegate` gains `ifRevision, requestId, actor`. Supply all three for v2 |
| Review start, note, attach or return | `review <start\|note\|attach\|return> --input-json <JSON>` or `--input-file <path>` | `council_work_item_review` with `action: "start"\|"note"\|"attach"\|"return"` and corresponding fields |
| Accept and close | `close --input-json <JSON>` or `--input-file <path>` | `council_work_item_close` |
| Reopen | `reopen --input-json <JSON>` or `--input-file <path>` | `council_work_item_reopen` |
| History | `history --id <id> [--before <rev> --limit <n>]` or `history --id <id> --request-id <key>` | `council_work_item_history` with `{id, beforeRevision?, limit?, requestId?}` |

For JSON CLI forms send one input source. The CLI subcommand supplies the review action. MCP sends it as the `action` field and includes optional `project`. Use operation-specific object schemas, reject arrays, unknown or conflicting fields and missing values, and advertise the new commands in help and MCP tool discovery.

## V2 mutations

Every v2 mutation takes `id`, positive safe integer `ifRevision`, stable `requestId` matching `^[a-z0-9][a-z0-9-]{0,63}$`, and named `actor`. The CLI form uses `--if-revision` and `--request-id` for the existing delegate command. Normalize actor and user text by trimming outer spaces. Use 1–120 UTF-16 code units for actor and 1–500 for reason, next action or note. Use the existing single-line text rules, including rejection of control characters. Review and decision IDs are `review-<positive-revision>` and `decision-<positive-revision>`. SHA-256 fields use 64 lowercase hexadecimal digits. Role, work-item and timeout constraints remain as in COU-2.

| Operation | Additional fields and constraints |
| --- | --- |
| Triage | `patch` with at least one of `title, roleId, criteria, priority, blockedBy, nextAction`. Priority is `none\|low\|medium\|high\|urgent`. `blockedBy` has up to 20 distinct IDs in the same project, excludes self, and normalizes to ASCII order. Replace the blocker list as a value. Existing links whose target becomes unreadable are reported. Validate changed roles and current lifecycle preconditions. |
| Delegate | Existing optional `timeoutSec` (default 180). Use the current saved definition and no user-supplied task, permission, agent or terminal override. An automatic retry may read the saved intent only. For v2, use the original request identity to recover its receipt. A different request cannot claim an occupied cycle. |
| Review start | `reviewOwnerRoleId` from the current Team and `policy: "operator"\|"formal"`. Requires a verified completed handoff for the active cycle. Operator policy is unavailable once formal review is required. |
| Review note | `reviewId, kind: "finding"\|"dissent", text`. Up to 50 notes per review. Prior notes are immutable. |
| Review attach | `reviewId, formalSessionId, round`. The bounded formal session ID is a safe repository session ID with no path components. Only one exact session and round can be bound. Accept readable bound rejection and provisional results without converting them to approval. |
| Review return | `reviewId, evidenceToken, reason, roleId, nextAction`. Persists `changes_requested` and the frozen evidence. The new cycle uses the selected responsible role. |
| Close | `reviewId, evidenceToken, decision: "accept", reason, nextAction`. Requires the same verified review before publication. Does not depend on a historic role remaining in the current roster. |
| Reopen | `decisionId, snapshotSha256, reason, roleId, nextAction`. Both references must match the current closure. The selected responsible role must be available. |

Request replay compares normalized content with the same request ID, project and item. Always compare ordered criteria as ordered text. Normalize omitted timeout to its default for a v2 claim. History lookup by request ID is read-only. A known receipt wins before a stale revision check. A different request with an old revision must be confirmed again against the current item.

## Response additions

### Legacy and current projections

Keep the existing success envelopes and their `item`, `items` and `errors`. Add a `lifecycle` object to each item. The existing job/result/attention fields describe the current cycle's execution. Keep the existing execution-state enum. Use `canDelegate: false` for managed v2 items to protect old UIs. New UIs use `lifecycle.actions.delegate`. Keep the existing create fingerprint tied to the original definition even after triage. An exact replay of create with the original input returns the current item view. List returns no captured body.

| Lifecycle summary field | Type and meaning |
| --- | --- |
| `revision, workRevision, cycle` | Positive integers for journal head, executable definition revision, and active cycle |
| `managed` | Boolean. Version 2 owns the legacy intent slot or a lifecycle journal exists |
| `state` | `open\|in_review\|closed` |
| `priority` | Priority enum above |
| `blockedBy` | Array of `{id, title, state}`, where title may be null and state is a lifecycle state or `unavailable` |
| `nextAction` | Latest lead-authored instruction, or null for legacy or unactioned items |
| `guidance` | Nonempty instruction for the current workflow or recovery |
| `needsAttention` | True for unresolved blocker links, execution attention, rejected/provisional/unverified formal evidence, or a lifecycle integrity issue |
| `reviewState` | Null or `operator\|pending\|provisional\|rejected\|approved\|unverified`, independent of closure |
| `actions` | Booleans for `triage, editDefinition, delegate, startReview, addNote, attachFormal, close, returnForChanges, reopen`. Show eligibility on detail. A fresh server write revalidates everything, including current evidence and role availability. List may omit `actions` |

Filters are AND-combined. `needsAttention: true` selects attention items and `false` selects the rest. Default sort retains created time descending and ID ascending as in COU-2. Sort `priority` uses descending priority then the same default tie breaks. List projects on-disk statuses and metadata. Detailed formal authority and capture integrity checks are made on show and write.

Detail adds under `lifecycle`:

- `formalRequired` is a boolean derived from the item's validated lifecycle history. It starts false, becomes true when the first formal review starts, stays true in all later cycles and survives return before attach, closure, reopening and restart. True requires formal policy for every future review. An engine implementing this amendment emits the field on every item detail, including the projected legacy record and mutation replies. List summaries may omit it. An older detail may omit the field. Treat its policy as unknown and apply the [Workspace compatibility rule](workspace.md#review-policy-compatibility). A present non-boolean value is malformed. This field leaves the review snapshot, evidence token, historical verdict and acceptance checks intact.
- `integrity` is null or `{code, message}`. If replay can validate a prefix only, expose that prefix with all mutations unavailable. A corrupted intent keeps a valid item in the list.
- `review` is null or `{id, cycle, workRevision, reviewOwnerRoleId, policy, definition, snapshotSha256, capture, evidenceToken, notes, formal}`, where `definition` is `{title, roleId, criteria}`. `capture` is `{sessionId, sha256, byteCount, output, source, captureScope, turn, completedAt, verified}`. `output` is null if unavailable. `evidenceToken` is null when the freeze cannot be verified. Each note is `{kind, actor, text, at, revision}`. `formal` is null for operator policy or `{sessionId, round, state, verdict, proposalSha256, manifestSha256, dissent}`, with nullable session/round/verdict/digests before verification. `dissent` contains `{voter, vote, rationale}` from verified direct reject/amend votes. Formal findings and informational contributions remain available through the original reviewed session. Open that session using the existing Reviews surface in the same project.
- `decision` is null or the latest decision `{id, reviewId, cycle, workRevision, disposition, actor, reason, nextAction, at, snapshotSha256, evidenceToken, formal}`. Dispositions are `accepted` and `changes_requested`. Persist the formal state, verdict, session, round, proposal and manifest digests as observed at decision time. Reopen never turns a prior decision into the current cycle's authority.

A successful v2 mutation adds `receipt: {requestId, event, revision, replay}` to the detail envelope. `event` is the committed type, `revision` is that event's revision, `replay` records whether this is a retry. The returned item is current and may be newer than the receipt. A verified reservation with unresolved delivery remains success with attention, never a second dispatch.

History success is `{success:true, project, id, events, nextBeforeRevision, integrity}`. Return summaries newest first, before the optional exclusive revision, default 30 and maximum 100. Expose `revision, type, actor, at, requestId, cycle, workRevision, references`. Synthesized legacy events use null actor and request ID, with their recorded times. References may include session, review ID, decision ID, definition or snapshot digest, or pointers to the archived prior cycle. Request-ID history instead returns `{success:true, project, id, receipt}`, with null for an absent request. A damaged suffix cannot hide the validated prefix. After opening history, a client can use `show` by review ID to read the immutable review and capture. A closed snapshot retains the formal state and evidence at the decision.

Error envelopes use COU-2 codes plus `revision_required`, `stale_evidence`, `invalid_transition` and `review_not_authorized`. Include `error.currentRevision` for revision conflict if known. Wrong or corrupt bindings use `integrity_error` or an unverified review state, as applicable. Missing entity returns `not_found`. Use `conflict` for stale revision, request reuse with changed input, or a cycle already dispatched. A read that returns an accurate non-approved formal verdict is a successful inspection. Do not use CLI exit 0 or MCP transport success as approval.

The fixtures illustrate the wire shape. Generate real persisted ballots with the existing formal workflow in tests that establish authorization. See [representative fixtures](examples.json) and the [formal snapshot rules](formal-review.md).
