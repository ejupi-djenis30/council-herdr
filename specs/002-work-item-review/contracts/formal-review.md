# Frozen handoff and formal review contract

## Work definition and freeze

The definition digest is SHA-256 over Node JSON serialization of the UTF-8 tuple `[title, roleId, criteria]`. A stable item can have multiple work revisions and a distinct attempt for each dispatched cycle. For legacy evidence, freeze the unmodified legacy definition and the verified legacy job. For v2 jobs, require the matching session, managed role, item ID and work-item binding. Read the result through the existing job/result validation and preserve its outcome, acknowledgement, turn and source. A worker job establishes a handoff, never a formal vote or authorization.

Freeze exact UTF-8 bytes of the validated `result.output` string. When its existing artifact is supplied, verify its trusted contained file and agreement with the saved capture. An absent optional artifact path leaves a valid retained capture available. The snapshot has these fields in order, represented by its tuple:

```text
["council.work-item-review-snapshot/v2", itemId, cycle, workRevision,
 reviewId, reviewOwnerRoleId, policy, definitionSha256, sessionId,
 captureSha256, captureBytes, source, captureScope, turn, completedAt]
```

Hash the UTF-8 Node JSON serialization as `snapshotSha256`. Freeze preserves the definition snapshot and capture bytes as read. Use `screen` or `history` capture scope as recorded. A `terminal_screen` capture stays so even if written to a Council artifact file. Direct evidence requires an explicit direct source from the existing job. A missing, modified or mismatched freeze makes closure unavailable. Retained bytes are verified on detailed reads and immediately before an accepting mutation. List reads metadata only.

## Review policies

- `operator` enables an explicit lead decision after reviewing a verified freeze. Show notes and the authority label **Operator acceptance**. Do not display as an approved Council ballot or promote artifacts.
- `formal` requires a linked Council `review` or `council` round and preserved formal authority. A lead can choose this policy when starting review. Keep that requirement for all later cycles once selected. A formal outcome is shown separately from the lead decision.

Notes are explicit recorded observations with `kind: finding | dissent`, named actor, timestamp and review ID. Formal dissent includes the valid direct `reject` and `amend` votes and their rationale, with provenance. Valid direct votes and informational screen evidence remain distinguishable. Truncate displayed excerpts with the original source available through the verified session.

## Binding the existing formal workflow

To attach a formal result, take a validated direct session ID and round number in the same project. For a background formal job, obtain its underlying `workflowSessionId` from the existing status path. The Work items operation attaches evidence. Running the formal review still uses existing `convene` or asynchronous `start` with normal author handoff, safeguards and independent reviewers.

The proposal submitted by the author must have the following exact first line, using the snapshot digest shown by Workspace or CLI:

```text
Council-Work-Item-Review: sha256:<snapshotSha256>
```

Accept LF or CRLF as the line terminator. The rest of the proposal may contain the substance of the review. Ballots target the SHA-256 of all exact proposal bytes, including the binding line. The binding line alone authorizes nothing. Use the existing completed round and verified proposal readers to validate the session, mode, round, current roster, proposal metadata and bytes. Compare the exact first line after digest verification. Reject another item, work revision, project, mode, round, or proposal. An attached formal session/round is immutable for that review. Another attempt or review needs a new freeze and binding.

## Observations and acceptance

Use the existing completed-round and authoritative verdict paths. For a candidate approval require published report/validation evidence, matching proposal SHA, verified integrity, expected voters, a completed-round marker bound to the current session creation, a fresh direct tally against the completed roster and existing thresholds, and zero invalid votes. Require agreement with the authoritative approval fields. Use the existing tally/validation definitions, including any condition required by Council's formal authorization. The read must leave formal artifacts unchanged. Screen text, generic success, numbers in a report, missing approval or a corrupt record cannot create authority.

The public formal state uses `pending`, `provisional`, `rejected`, `approved` or `unverified`. Preserve the raw existing verdict in `verdict` when readable. Project new formal evidence on show while the review is open. Closed and historical reviews show the observation saved with the decision. On attach and decision, preserve the observed proposal, verdict, report and contributing direct ballot bytes as bounded hashed blobs, plus source roles and timestamps in the observation manifest. The manifest is an ordered, ASCII-key-sorted list of `[projectRelativeSource, sha256, byteCount]` for regular files used for the observation. A report can contain informational screen material. Only the dedicated direct ballot bytes participate in formal authorization.

An observation must be coherent. If files change during validation, the previous sources are missing, or the existing retally is in progress, make the formal status unverified or return `stale_evidence` for an acceptance. Read and compare the manifest again before committing a decision. The resulting event records the exact validated evidence observed at that point. Future retallies do not rewrite history. No work-item operation runs a retally or replaces the existing approval rules.

The `evidenceToken` is SHA-256 of the UTF-8 JSON tuple `[snapshotSha256, formalState, formalManifestSha256]`. Use `"operator"` and null manifest for operator policy, and `"pending"` and null manifest before a formal attachment. `formalManifestSha256` hashes the exact JSON tuple list above. Display the current token via the API. A decision echoes it, binds the review ID and uses the current item revision. If an accepted proposal or report later becomes unreadable, history preserves the decision and shows the evidence issue. It cannot authorize a future cycle.
