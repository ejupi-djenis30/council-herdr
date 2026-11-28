# CLI and MCP contract

Build on the [COU-2 envelope and scope rules](../../001-work-items/contracts/interfaces.md) and [COU-8 revisions](../../002-work-item-review/contracts/interfaces.md). Use additive commands. Ordinary reads operate strictly on the active canonical Council project and installation. No operation accepts raw endpoints, credentials or protected paths.

## Ordinary and Workspace-facing operations

`council work-item plane show --id <itemId> [--project <absolute-folder>] [--operation-id <ref>]` and MCP `council_work_item_plane_show {id, project?, operationId?}` inspect metadata from the local read projection. Resolve a specific operation only inside the supplied item and scope. Missing feature fields on older engines mean unavailable; old items on a current engine return `link: null` and no operations. Do not add a publisher, candidate mutation, link mutation, diagnostics with raw provider bodies or credential operation to MCP.

`council work-item plane open --id <itemId> [--project <absolute-folder>] [--operation-id <ref>]` is the installed metadata handoff only. It returns whether the enrolled operator surface can be reached and the safe local reference to locate the item there. The optional operation ID restricts the handoff to an existing operation in that scope. The installed reader resolves the local reference from its enrolled scope plus item and operation identities, including when the item is unlinked. A regular machine cannot authenticate on the operator's behalf. Where session isolation does not support launching from Workspace, show the non-secret reference and fixed entry point instructions for the operator's authenticated session. Do not accept a shell fragment, tool path, URL, user-supplied target scope/profile, authorization flag or token. It never changes private state or sends a comment. Its success envelope is `planeHandoff: {disposition, localRef, operationId}`. `disposition` is `operator_console`, `manual_operator_session` or `unavailable`; `localRef` is a bounded opaque identifier or null on unavailable; `operationId` echoes an authorized scoped lookup or null. The renderer owns the fixed localized instruction. It must never execute a response-provided command or path.

Public input schemas accept exact objects/flags, validate all fields and follow existing errors/exits. Unknown fields, malformed scope, wrong operation ID, invalid values and arrays fail closed. CLI stdout is one existing-format JSON envelope. MCP returns its JSON text and error flag in the established style; no diagnostic contains a body/header, credential, source path or transcript. The existing base envelope's local project identifier stays local; use opaque refs in the handoff and publication projection.

## Trusted operator surface

The fixed installed operator command opens an authenticated interactive console and supports the following actions inside it. Automated flag/stdin input cannot answer confirmation. The console reads its own enrolled scope and current item. Its visible status/terminal text is metadata-only.

| Action | Fields / semantics |
| --- | --- |
| Resolve link | `localRef, profileId, itemRef`. Verify scoped project and exact Plane item. Return an ephemeral immutable candidate with a generated `candidateId`, target details and base link revision 0. |
| Confirm link | Interactive affirmative action for the displayed `candidateId`, expiring after 5 minutes. Reverify target and local item, compare base revision, persist locally with compare-and-set. A valid same-target concurrent/retried confirm yields the existing link. I/O or remote failure gives no false receipt. |
| Prepare preview | `localRef, evidenceUrl`. Read current COU-8 state/revision and immutable link, verify providers, prepare/dedup the exact projection and persist it for 5 minutes. Do not send. An existing published or uncertain operation is returned; inspect prior outcome first. New preview after supersession requires a separate explicit action. |
| Confirm publication | Interactive affirmative action for displayed operation ID and preview digest. Default cancel. Bound to the original local scope, revision, Plane scope, expected author and payload. Freshly verify all gates and expiry. Persist approval, then commit Start under the same live invocation before a single POST. Replaying against a started operation performs receipt lookup or shows the current unresolved state. |
| Inspect / reconcile | `localRef, operationId`. Inspect is local; reconcile reads the original Plane target only. Reconcile never advances a prepared/approved record to Start. Cancel only an unstarted preview, retaining its history. |

Reject expired prompts, time rollback detected relative to persisted trusted time and changed local revisions, link pins, authorization, verified URL identity or display bytes before Start. Work item snapshots may advance after the last fresh read without changing approved bytes; report their historical version. All actions operate on durable operation/revision records, never on mutable renderer selection. Expose a blocked historical receipt if present rather than retrying it.

## Projections

The success envelope adds `plane: {availability, freshness, link, operation}`, with `availability: "disabled" | "read_only" | "operator_available"`, `freshness: "current" | "cached" | "unavailable"`, and nullable link and operation. When disabled/unavailable, retain any verified local receipt metadata and report its freshness. No remote request is implied by `show`.

- `link` includes `linkRevision, instanceId, instanceLabel, workspaceSlug, workspaceId, projectKey, projectId, itemIdentifier, itemId`. The origin can be displayed in the protected console. The generic projection excludes secret/provider diagnostics and source paths.
- `operation` includes `operationId, itemRevision, linkRevision, status, evidenceUrl, visibility, state, reason, receipt`. States are `prepared, approved_unsent, expired, cancelled, conflict, offline, delivery_uncertain, published`. A blocked earlier started operation is always the active barrier until positively reconciled. An explicit operation query can return an earlier receipt.
- `receipt` when non-null includes `commentId, operationId, verifiedAt, source` with source `response` or `reconciliation`. Trusted local journal retains stronger pins and digest. Only the display-safe verified URL may be clickable. A receipt absence never means unsent after Start.
- `reason` is null or an error code below, or `receipt_not_proven` for uncertainty. Failed commands use existing error envelope and additional codes as needed `plane_disabled, operator_required, offline, authorization_denied, stale_preview, scope_conflict, evidence_unverified, storage_error, integrity_error`. A readable unresolved status is an honest positive inspection result, not a successful publication. Report primary blockers as typed codes, never raw provider output.

Use [synthetic contract and fault vectors](examples.json) for conformance.
