# Herdr Workspace lifecycle contract

Continue using Council → Workspace → Work items on the resolved project machine. Add the lifecycle controls beside the existing delegation evidence. Preserve the independent [COU-2 delivery view](../../001-work-items/contracts/workspace.md), including terminal provenance. Use [published wire examples](examples.json) for frontend development and [CLI/MCP](interfaces.md) for field constraints.

## Queue, detail and changes

| Surface | Required behavior |
| --- | --- |
| Queue | Show title, responsible role, priority, lifecycle label, blockers or attention and the next action. Add filters for role, lifecycle state and Needs attention. Provide a clear-filters action. Sort the queue by priority using the shared list contract. Partial read issues stay visible. |
| Item detail | Show ordered criteria, current work revision and cycle, lead-authored next action when present, current guidance, delivery and action availability. Triage edits priority and linked blockers. Permit title, criteria and role edits only before the current attempt is reserved. Link blockers using the current project's items and show unavailable or unresolved links without auto-dispatch. |
| Start review | Show candidate handoff source and current attempt/session. Choose the review owner from Team and show the operator or required formal policy. When frozen, show exact item criteria, session, snapshot digest, and verified capture. Provide a clearly labeled scroll or expansion affordance for output. |
| Review | Show findings and dissent and let the lead record notes. For formal policy show a copyable binding line, existing review session and round controls, verdict and evidence issues. Use **Open formal review** through the existing Reviews navigation for a verified link. Preserve a rejected or provisional result as such. |
| Close | Only a qualifying current review exposes the accepting action. Confirm the review, current role, actor name, decision reason and next action. Send the frozen review ID and token. Worker status and advisory records do not enable this button. |
| Return or reopen | Show prior review or close evidence first. Prompt for explicit reason, accountable Team role and next action. Returning a review for changes and reopening a closed item are distinct labels. Reopening shows the new cycle and work revision. Starting an attempt is a separate action. |
| History | Page the journal with prior cycles, execution links, operator notes and decisions, and exact reviewed evidence. Show an evidence problem without deleting history. Reopen the original review and capture by its ID. Keep previous verdicts visible and distinct from today's execution. |

Lifecycle text is **Open**, **In review** or **Closed**. In open detail show the existing execution text separately. Formal status is labeled separately, including **Provisional**, **Rejected**, **Approved** and **Unverified**. Operator acceptance is named explicitly. Pair status with text. Preserve the returned recovery guidance. Provide accessible names for fields/actions and visible keyboard focus through the existing controls.

## Review policy compatibility

When starting a review, offer **Operator acceptance** only when the current verified detail explicitly reports `formalRequired: false`. When the field is true, show **Formal Council review** as required and submit formal policy only. When an earlier lifecycle detail omits the field, offer formal policy only, and show that refreshing or updating Council is needed to verify whether operator acceptance is available. Existing pre-lifecycle responses continue to use the read-only update-required view.

Apply this rule from the current detail before opening and submitting Start review. A change in the available policy invalidates an existing incompatible confirmation. A null historical `decision.formal` is expected when a formal review returned before attaching a round. The durable policy still governs the new cycle. The backend revalidates it on the write. See `formalRequiredAfterReturn` and `reviewPolicyCases` in the [wire examples](examples.json).

## Scope and recovery

- Execute CLI on the selected project engine with argv tokens and frozen cwd. Keep the same project/machine for Team roles, linked blockers, delegation and formal reviews. A pending read from an obsolete scope or selection cannot update the visible state. Restoring a view upholds existing return navigation.
- Capture `ifRevision` and a stable `requestId` before every mutation. Delegate uses v2 fields. A compatible old engine can show an update-required state when the new lifecycle contract is unavailable. Never fall back from a failed v2 mutation to unversioned delegate or another engine.
- Disable pending writes for that form. For an ambiguous mutation reply, use History by request ID and show on the original target. If committed, show the saved receipt and state. If absent or still uncertain, keep the original draft and let the lead refresh. Explicit resubmission may replay the same request. If revision or evidence changed, show latest values and require a new explicit confirmation and request ID. Do not silently move a draft onto a new review.
- Keep intent recovery read-only. A reserved session without proof stays Needs attention. A verified link can open existing Delegations and its terminal when present. A refreshed read cannot create or cancel jobs.
- On a machine disconnection, old install, malformed data, partial read or integrity issue, show the affected project and action to refresh or update. Keep unaffected items/history available. No periodic refresh or cross-machine transfer is introduced.

Frontend ownership and acceptance are in [tasks.md](../tasks.md) and [test-plan.md](../test-plan.md).
