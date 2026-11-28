# Herdr Workspace contract

## Navigation and controls

Add **Work items** to Council → Workspace beside the existing perspectives. Follow the focused or pinned project and its machine, using the resolved project from Workspace activity. In aggregate space view, display work items for the resolved project shown in the header. Switch project through the existing Workspace selector. Opening a row or creating an item captures the current project and engine. Detail displays the original project even if terminal focus changes.

| Surface | Content and action |
| --- | --- |
| List | Title, responsible role ID, visible state label, next action. **New work item** opens the form. **Refresh** is a read. Empty text explains that this project has no work items. Render read issues separately from valid rows. |
| Create | Title, one criterion per line, responsible role chosen from the existing Team roster for this project. Preserve criterion order and internal blank lines as input errors. If there are no roles, explain that Team needs a role and link to Team in the same project. Save opens the persisted detail. |
| Detail | Title, ID, project, role, ordered criteria, state, next action and observed job evidence. **Delegate** appears when `canDelegate` is true. Use the default deadline in Desktop. **Refresh** rereads the item. **Back to work items** preserves the original list scope. |
| Linked job | Display the session ID, known delivery state and deadline. **Open delegation** uses the current Delegations navigation with the original project and machine when `job.linked` is true. With an unresolved link, show the reserved ID for inspection and render the attention message. |
| Result | Show the saved output in a bounded text region, with a clearly labeled scroll or expansion affordance. Label evidence **Direct artifact** or **Terminal screen capture** from `result.source`. Show the review next action. |

Map `draft` to **Draft**, `in_progress` to **In progress**, `needs_attention` to **Needs attention**, and `result_ready` to **Result ready**. The UI must use text labels and preserve the returned next action. A worker launch receipt alone is insufficient to display result-ready or completed. The UI must never use work-item state as criteria approval.

## Transport and concurrency

- Use the project-machine engine and the existing CLI execution path with argv tokens. Pass the immutable target as cwd. Use the existing Team roster read on that target. Parse the JSON envelope, including typed errors on nonzero exits. Surface missing/old engine errors with a path to refresh or update the project-machine installation.
- Keep the same generated ID and original content after a create transport failure until the mutation's outcome is reconciled. First issue a read-only show for the same ID on the original engine/project. Verify title, role and ordered criteria match before accepting a recovered create. If no item is found, the original request may be replayed explicitly with the same ID and content. Show a conflict if the ID points to different input.
- While a delegate request is running, disable its action. If its response is lost or invalid, read the same item with show. Treat existing intent/attention as authoritative. If show reports draft or fails, keep the current form read-only with a next action to refresh until reconciliation. An explicitly submitted delegate after a successful draft refresh remains protected by the same backend intent. Do not automatically retry delegate.
- Async responses may update only the scope and selection they were requested for. If the user switches project, machine or item, discard the stale response for the visible view. Mutations always finish against the original target. The team picker and job deep-link cannot reuse state from another project.
- Treat machine disconnection, missing engine, storage errors and partial list errors as actionable states. Keep scopes local to the project machine and respect existing Herdr input and keyboard behavior. Automatic calls, terminal cleanup, user-address inference, and periodic refresh are outside this contract.

The frontend can start against the response fixtures in [examples.json](examples.json). Its checks must include actual arguments to the project-machine engine, parsing, altered focus during an in-flight request, lost-reply recovery and the verified delegation deep-link. See [plan.md](../plan.md) for file ownership.
