# Council evidence publication to an existing Plane item

- **Feature** 004-plane-evidence-publication
- **Tracking** COU-9
- **Baseline** COU-8 merge `58ae01470347a04d59008308f8f0f953485360d3`
- **Status** Frozen implementation contract, release gated by the evidence in [Acceptance](test-plan.md)

[Product decision](../../docs/herdr-project-product-brief.md) · [Implementation plan](plan.md) · [Interfaces](contracts/interfaces.md) · [Workspace](contracts/workspace.md) · [Provider protocol](contracts/providers.md)

## User stories

### US1 · Link work to an existing planning item (P1)

An operator starts from a Council work item in Workspace. They select a configured Plane target and supply the existing work-item identifier or UUID. Council verifies the scope and shows the actual destination. The operator confirms the local link, and finds it again after refresh, restart and temporary loss of connectivity.

**Independent acceptance** — Given two same-named local projects and two same-named remote projects, resolve and confirm only the selected pair. A mismatched or non-active remote item leaves the local link absent. A concurrent confirmation for that same target returns its existing link; a different target reports a conflict. Normal lifecycle work stays available offline.

### US2 · Publish the approved status and evidence URL (P1)

The operator selects a GitHub PR or commit URL. The publisher verifies the URL and the linked Plane identity online and shows the precise typed Council status, canonical evidence URL, visibility and publication reference. An explicit confirmation in the trusted operator surface authorizes one submission of that exact preview. Plane shows one internal comment, and the local work item shows a durable receipt.

**Independent acceptance** — Accepting a preview with a verified URL produces the specified fields on the exact issue. Cancel, stale local revision, expired or conflicting preview, failed verification and missing permission produce zero POSTs. A worker result, CLI exit code, ballot, link creation or pre-existing preview cannot authorize a publication.

### US3 · Recover from a lost reply (P1)

When the operator returns after an interruption, Workspace explains whether the publication was never started, is unresolved, or has a verified receipt. Reconcile performs bounded reads of the original item and makes the receipt visible if it can prove it. Any unresolved case remains visible across restarts and blocks another publication for the linked work item.

**Independent acceptance** — With a committed comment and lost reply, a restarted publisher recovers the original comment once. If the original attempt may have committed but a receipt cannot be proven, repeated reconcile performs zero POSTs.

## Requirements

| ID | Requirement |
| --- | --- |
| FR-01 | Pin the Council canonical project/machine installation and item ID, plus configured Plane instance ID and origin, workspace slug and UUID, project UUID and key, item UUID and sequence. Labels are display-only. Link one existing active item per Council item using guarded local confirmation. |
| FR-02 | Council owns its lifecycle, decisions and evidence. Plane owns planning fields and permissions. Permit only the [fixed internal comment](contracts/providers.md#write-and-receipt). No remote creation, planning-field updates, delete, edit, relink, cross-installation replication, arbitrary routes or inbound sync in this increment. |
| FR-03 | Use the current validated COU-8 lifecycle `open\|in_review\|closed` and verify one public allowlisted GitHub PR or full-commit URL. An integrity error disables new publication. Formal review remains governed by COU-8. |
| FR-04 | The trusted operator surface presents the immutable exact preview and requires explicit confirmation. Bind approval to the operation, canonical scope, approved bytes and revision. Gate sender access independently of the Workspace, agent CLI and MCP. |
| FR-05 | Verify the expected Plane principal and target authorization configuration before starting. Hold a dedicated integration key only in the trusted publisher context. The COU-6 synthetic vault is a separate project. |
| FR-06 | Commit local intent, approval, and a single durable Start fence before sending. Disable every implicit retry. A non-proven outcome after Start is uncertain. A missing receipt, expired request or fresh process cannot make a second send safe. |
| FR-07 | Recover only through the original target and a unique validated internal comment by the expected author. Preserve unresolved and conflicting evidence visibly, with no alternative posting or resolution by assertion. |
| FR-08 | Keep links, intentions and receipts inspectable offline and in the origin scope. Local Council editing, review and next actions remain usable. Offline before Start gives an explicit unsent state and no eventual background submission. |
| FR-09 | Treat parallel link, confirmation, supersession and recovery as guarded writes. Settle stale actions against original opaque references first. Different scopes with the same name cannot share selection, local requests, authorization or receipts. |
| FR-10 | Reject prompt text, transcript, local paths, repository/query secrets, arbitrary fields and destination overrides at the outbound boundary. Record only the specified metadata. Disable remote writes by default until the installed trust and local Plane gates pass. |

## Success criteria

- SC-01 Across ten scripted publication repetitions including lost replies, restarts and offline cases, each work item keeps one link and each approved logical publication has no extra comment. All remote planning fields remain unchanged.
- SC-02 Every successful publication exposes one positive scoped receipt. Every unproven delivery remains visible and blocks another send. Stale approvals, wrong identities and adversarial refs have zero sends.
- SC-03 The installed Workspace walkthrough demonstrates resolve → trusted confirmation → published receipt and safe recovery on an approved dedicated Plane test item. Report installed platform and identity boundaries, fixture coverage and live provider proof separately.
- SC-04 Outbound capture contains only the fixed route, required auth header and approved body fields. The key appears only in transport to the pinned Plane origin. Error paths, receipts, UI and diagnostic outputs contain no forbidden source content.

Release evidence and test ownership are defined in the [acceptance matrix](test-plan.md).
