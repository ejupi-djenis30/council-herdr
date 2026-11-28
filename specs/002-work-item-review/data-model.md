# Data model, migration and concurrency

## Project identity and existing items

Resolve the native real path of the requested project. Keep the working-tree boundary and reject symlinked store, item, session, evidence and intermediate directories using the existing regular-file checks. Same-directory aliases share the item. Physical worktrees hold separate records. Project-relative record addresses are derived from validated identifiers. Callers cannot supply an output path.

Keep the COU-2 item directory `.agent_workspace/.work-items/<id>/` and both possible first slots. Read existing definitions and intents unchanged. Reads alone never migrate them. An old definition is revision 1, work revision 1, cycle 1, open, priority `none` and no blockers. A valid legacy intent adds a projected revision 2, an attempt in cycle 1, and its original job and deadline. A completed legacy result is eligible to freeze. A corrupt legacy intent remains an attention item with no write or dispatch allowed until restored from trustworthy storage. Legacy approval or closure cannot be inferred from an existing result or report.

### Activate version 2 without a mixed-writer gap

- The first version 2 write on a draft atomically claims the existing slot `00000002.json` with `{$schema:"council.work-item-lifecycle/v2", id, definitionSha256, activatedAt}`. Use the same no-replace primitive as legacy delegation. `definitionSha256` is the SHA-256 of the exact definition file bytes. This marker owns the slot and leaves the projected revision at 1. An old binary treats the marker as an invalid intent and will decline dispatch.
- If a valid legacy intent already holds slot 2, preserve it and use it as revision 2. An old binary can inspect or reconnect in its existing path and cannot launch a fresh job. Version 2 also treats that attempt as occupied.
- Re-read slot 2 and the journal after a lossy marker publication or an atomic claim loss. A legacy intent that won the race changes revision 1 to 2, so a stale request conflicts before any dispatch. A matching, valid marker can survive an interrupted activation with an empty journal. Only a positively acknowledged **attempt reservation event** authorizes calling Team.
- The unchanged legacy `delegate` form remains usable on a legacy draft or legacy intent with no version 2 journal. A marker or any committed lifecycle event makes unversioned delegate return `revision_required`. An older binary may display the earlier job of a migrated item. Use a current installation to view or mutate its lifecycle. Removing the marker or journal is outside supported rollback.

## Records

| Record | Contents and location |
| --- | --- |
| Legacy baseline | Definition plus optional intent, as above. Read both through the existing store. |
| Journal event `council.work-item-event/v2` | `id`, `revision`, `expectedRevision`, `previousSha256`, `requestId`, `requestSha256`, `at`, `actor`, `type`, and typed `data`. Store under `lifecycle/<eight-digit-revision>.json`. A first event references the exact baseline bytes via its anchor. |
| Work definition | Effective `title`, ordered `criteria`, and `roleId`. A work revision advances when any of these fields changes and on each new cycle. Persist a definition snapshot and its digest in every attempt reservation and review freeze. |
| Triage | `priority`, ordered-by-ID `blockedBy`, and human-authored `nextAction`, each carried forward until explicitly changed. Missing blockers are reported and have no execution or authorization effect. |
| Attempt | `cycle`, `sessionId`, `workRevision`, `definition`, `definitionSha256`, `timeoutSec`, and the reservation event. Jobs created for v2 carry the existing `workItemId` and additive `workItemBinding: {cycle, workRevision, definitionSha256}` in the job record and input fingerprint. Preserve earlier fingerprints. |
| Review | `reviewId`, `cycle`, `reviewOwnerRoleId`, `policy`, `workRevision`, `snapshot`, `snapshotSha256`, `startedAt`, optional bound formal session and round, and append-only findings. Use `review-<revision>` of the review-start event. |
| Decision | `decisionId`, `reviewId`, `cycle`, `workRevision`, `evidenceToken`, `snapshotSha256`, formal observation when present, `actor`, `at`, `disposition`, `reason` and `nextAction`. Use `decision-<revision>` of the close or return event. A reopen event records the exact close decision ID and snapshot digest and its own actor, reason, next action and role. |
| Frozen evidence | Exact capture and any formal evidence archived at binding/decision under `evidence/<lowercase-sha256>.blob`. Addresses derive from verified bytes. The journal references hashes and byte counts. Existing Council reports and ballots remain in their original folders. |

Event types are `triaged`, `attempt_reserved`, `review_started`, `review_note`, `formal_attached`, `review_returned`, `closed` and `reopened`. Synthesized history types are `created` and legacy `attempt_reserved`. Replay checks item ID, contiguous revisions, expected previous revision, actor, timestamp, request ID uniqueness, allowed event data and transitions. Unpublished temporary files cannot contribute state. An event with invalid content or a gap leaves the last valid prefix for inspection and refuses new writes. Two items' journals are independent.

Use SHA-256 over bytes. For definitions and snapshot objects serialize the fixed-order tuples in the contracts using Node `JSON.stringify` and UTF-8 with no BOM or trailing newline. Normalize request data first, then hash the operation with its validated fields in contract order, including the expected revision and excluding the request ID and project alias. The first event's `previousSha256` is the hash of UTF-8 JSON tuple `[definitionFileSha256, slot2FileSha256]`. Slot 2 must already be durable for this anchor. Subsequent events use SHA-256 of the immediately prior journal file's exact bytes.

## Write and replay order

1. Resolve the project and validate input. Reconstruct the current item and journal head from immutable data. Look up request ID before comparing the expected revision. An identical request gets its saved receipt and the current view. A reused ID with different inputs conflicts.
2. Verify the transition, role, job or evidence preconditions. Prepare any frozen content in the same item directory. Publish it atomically without replacing existing blobs. If a destination already exists, accept it only after verifying identical bytes. Use the existing 16 MiB job/result bound and a 64 KiB event bound. Save only bounded metadata in an event.
3. Activate version 2 if needed and recheck the observed revision. Publish the next event with a hard link using the existing no-replace pattern. A losing writer rereads, returns the existing receipt for the identical request, or reports conflict with the current revision. Never silently rebase a decision onto unseen evidence.
4. When the operation reserves an attempt, the successful publisher calls the existing Team path once. Use the saved session, role, immutable work revision, and requested deadline. Preserve the job's real deadline and delivery status. An exception, interrupted publication or lost reply may leave a valid intent without a verifiable job. Return attention with its reserved ID and do not send again.
5. Other operations have no external side effect after the immutable event is committed. Publish failures leave the prior state or an identical committed receipt. If acknowledgement is lost, inspect the slot and preserve any committed event. Reads must not write, launch, send or dismiss. An unused frozen blob after a losing race is harmless.

The item store only guarantees process-level crash/retry consistency on supported local filesystems. Same-volume hard-link failure is `storage_error` and cannot enable a launch. File and folder validation, fatal UTF-8 decoding, exact expected names and bounded reads preserve the existing damaged-record behavior.

## Lifecycle and authority

| Current state | Operation | Preconditions and next state |
| --- | --- | --- |
| `open` | Triage | Update triage metadata. Change title, criteria or role only if the current cycle has no attempt reservation. Keep state open. |
| `open` | Delegate | Available role, no attempt in the cycle and valid revision. Bind before launch. Keep state open and project worker status separately. |
| `open` | Start review | Current attempt has verified acknowledged completion and a saved result. Freeze evidence and move to `in_review`. |
| `in_review` | Note or attach formal evidence | Validate current review and evidence. Add a note or its one immutable formal-session link. Keep state `in_review`. |
| `in_review` | Close | Require explicit acceptance and the current evidence token. The current review must be eligible under its policy. Append an acceptance decision and move to `closed`. |
| `in_review` | Return for changes | Require explicit rework decision, current evidence token, responsible role and next action. Record the actual formal outcome if linked. Archive the cycle and begin an `open` cycle with no intent. |
| `closed` | Reopen | Require the exact current close decision and frozen snapshot digest, a reason, responsible role and next action. Reference the old decision and open a new cycle with no intent. |

One attempt per cycle. Completion alone never enters review or closes. A known failure or missing result remains visible with the existing recovery guidance. This increment does not reset an unsuccessful or ambiguous attempt. Rework and reopening start only from a frozen completed handoff or an explicit closure. Archiving a review or reopening does not alter the earlier vote, report, delivery or terminal. Once a formal review has been opened the formal requirement persists for later cycles. Failed or unverified evidence cannot authorize closure.
