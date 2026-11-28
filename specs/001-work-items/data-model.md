# Data model and lifecycle

## Definition and dispatch intent

Canonical project root is the native real path of an existing folder. Same physical folder aliases share records. Separate Git worktrees and separate machines have their own stores. The project path is a runtime address, not a stored portable identifier. Validate IDs before joining paths. Use the repo's non-symlink directory/file validation for the storage and linked job parts.

Store immutable revisions in `.agent_workspace/.work-items/<id>/` with the existing `appendEvent` publication technique. A definition is revision 1 at `00000001.json`. A dispatch intent is revision 2 at `00000002.json`. Both include the item ID and strict schema validation. A temporary file or empty directory cannot establish that a revision exists.

| Record | Fields |
| --- | --- |
| Definition `council.work-item/v1` | `$schema`, `id`, `title`, `roleId`, `criteria`, `createdAt` |
| Intent `council.work-item-dispatch/v1` | `$schema`, `id`, `sessionId`, `roleId`, `timeoutSec`, `createdAt` |

The intent's `sessionId` is `wi-job-<lowercase UUID v4>`. Generate it before the atomic intent write. A Team job created for an item carries additive `workItemId` metadata in `job.json` and in that job's input fingerprint. Keep fingerprints for existing jobs unchanged. A verified job is an ordinary delegate managed by the saved Team role, with matching `job.sessionId`, `job.workItemId`, and `job.participant.team.id`. Other modes, a corrupted job and a foreign or mismatched record cannot validate the link. A linked job owns its actual deadline and result. Expose an address only from its stored participant record.

## Dispatch ordering and recovery

1. Load the definition and any existing intent. An existing intent goes straight to read/inspect, before checking Team configuration. Repeating with a conflicting explicit timeout fails without mutating anything.
2. For a draft, validate the request and current Team role. Build a deterministic brief with the ID, title, numbered saved criteria and request for a handoff covering the criteria and remaining steps. Preserve all normalized criterion text in order.
3. Atomically attempt revision 2. If publication loses, reread and inspect the winner. If it throws, inspect any visible intent and report the storage error or observed state. Only a positively acknowledged publisher may call Team.
4. The winner invokes `callTeamMember` once with the intent's session, the exact brief, role and timeout. Use existing preflight, worker, deadline, receipt, status and result handling. Do not reissue the Team call if it times out, throws, or returns a failure. Inspect the durable job and return the current item state.
5. Later invocations can only observe the claim and underlying job. If a lost reply occurs before the job is verifiable, the item may remain in attention permanently. Preserve its evidence. Once inspected, the lead can choose to create a different work item if more work is needed. A new item is a separate manual decision.

Use same-volume publication with local hard-link support as required by the current stores. No fallback overwrite or incomplete-file publication. Use regular bounded UTF-8 record reads, validate schema and release handles before returning. Allow at least 64 KiB per work-item event to accommodate encoded input. Protect the job and dispatch paths before resolving or returning any output paths. The durability target is across Council/Herdr process exits and partial writes. Full storage-device failure and external edits are outside the guarantee.

## Projected lifecycle

| Persisted or observed evidence | Projected state and action |
| --- | --- |
| Valid definition, no intent | `draft`. Delegate to the recorded role |
| Intent, job absent | `needs_attention`, `unconfirmed_start`. Inspect session and Herdr, then refresh the original item |
| Intent or job invalid, or binding fails | `needs_attention`, `integrity_error`. Inspect the storage in this project. Do not offer an unverified job link |
| Correlated job starting or deliberating with ordinary delivery status | `in_progress`. Inspect the linked job or refresh later |
| Correlated job awaiting input, blocked, timed out, uncertain, dispatch failed, failed or worker stopped | `needs_attention`. Surface outcome, last trusted delivery state, deadline and existing job recovery guidance |
| Correlated completed job with acknowledged delivery and saved output, validated by the existing result path | `result_ready`. Review the handoff against the acceptance criteria |
| Unknown job state or an inconsistent completion | `needs_attention`, `integrity_error`. Investigate the saved record |

List projects state from disk and may temporarily differ from show, which can observe a linked worker using existing bounded read-only probing. A later validated job/capture can move attention to in-progress or result-ready. The original intent remains immutable. A list row marked result-ready must have valid persisted completion evidence even though it omits the capture body.
