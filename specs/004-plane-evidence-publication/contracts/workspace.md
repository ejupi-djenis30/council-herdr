# Workspace contract

## Entry and target

Add a Plane section to selected Work item detail and keep the underlying lifecycle actions usable when this feature is unavailable, offline or blocked. Use the work item's canonical scope key and installation identity for selection, async callbacks and tooling; labels, display names and cwd are insufficient. When switching local project, machine or item, discard old interactive controls and re-read the exact selected scope. Show late receipts only under their originating work item and use the operation ID to recover. Never lose an already received positive original-scope receipt solely due to a selection change, offline query or unavailable detail.

For an unlinked item, “Link Plane item” opens or refers the operator to the installed trusted console. The console selects a configured profile and accepts a scoped human ID or UUID. Before displaying an affirmative local-link action show distinct instance/origin, workspace slug and UUID, project key and UUID, item identifier and UUID. After confirmation, Workspace reflects the durable read projection. Show authorized instance label, workspace slug, project key and item identifier and a way to inspect the UUIDs. Project and item labels can be displayed as contextual text only. Avoid generating arbitrary Plane deep links; the initial UI can use the verified identity text.

## Installation identity and delayed replies

Use only the top-level `installationId` from the engine as the verified installation identity. Scope the Plane cache and requests by machine, canonical project, work-item ID and the verified UUID. Record the current selection and a request generation on every query or handoff. Discard replies from obsolete generations, selection changes and mismatched scopes before changing controls, receipts or focus. A handoff response must match the UUID from the current `show` and the captured scope and generation before using its reference. A fresh handoff response with a changed UUID is a replacement signal. Discard its reference and verify the new installation through a fresh `show`.

When a current response reveals a different UUID for the same path and item, clear the selected Plane projection and disable its references. Advance the request generation and issue a fresh `show` before enabling references under the new UUID. Never auto-open or replay an old handoff. Preserve older receipts only under the old scoped cache key. Null, absent or malformed identity leaves the selected item's Plane section unavailable, including through handoff. Keep the normal work item usable. When the same verified UUID returns on a fresh response, its original cached receipts can become available again with their original freshness. Never choose a previously cached installation by path alone.

## Preview and action

Workspace labels the action “Prepare Plane update” and opens the trusted console, or describes how to open it in the authenticated session using the opaque local reference. This handoff carries metadata only. Map `planeHandoff.disposition` to localized fixed instructions. On offline or unavailable handoff leave the original link and any verified status visible. A single Workspace click never approves the preview or starts the sender. The console operator enters a URL and sees the engine-derived status, canonical URL, INTERNAL visibility, original exact target, work-item revision, correlation reference and literal rendered three paragraphs. Keep status read-only. Explicit confirmation is distinct from link confirmation and URL entry. Default cancel, keyboard reachable, with an unambiguous “Publish this update to Plane” accessible action. If current verification is offline, stale, disabled or denied, show the state and require a fresh operator action when eligible. Never label a worker's result, formal vote, UI fixture or code check as Plane approval.

## Follow-up and accessibility

| Engine value | Workspace treatment |
| --- | --- |
| `prepared` / `approved_unsent` | Preview prepared / approval recorded, update unsent. Trusted console requires fresh affirmative action before any fresh Start. |
| `offline` / `conflict` / `expired` / `cancelled` | Distinguish why no send occurred. Preserve previously verified link/receipts as cached and do not queue a write. |
| `delivery_uncertain` | “Delivery unverified” and “Check delivery”. Open the trusted console with the original scope and operation ref, then use read-only reconcile. No publish/retry action on that work item. |
| `published` | Show receipt ref, status, exact evidence URL and source. Mark an older approved snapshot if the work item now has a newer revision. |
| Missing/unavailable engine data | Explain capability or connection status, keep the last known scoped receipt with its freshness, and leave derived publish controls unavailable. |

Scope identity and backend operation ID keep the confirmation and receipt bound across re-render/async completion. Label controls and values, preserve tab focus when availability changes, support both keyboard directions and visible focus, announce results through the platform's supported accessibility interface, and test that Workspace cannot synthesize approval in a replacement/stale console. Track accessibility and actual installed behavior separately from fixture render assertions.
