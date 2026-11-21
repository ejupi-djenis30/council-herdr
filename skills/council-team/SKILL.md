---
name: council-team
description: List Council Team roles, call a specific named member in Herdr, or set its role and reporting line when the user requests it.
---

# Council Team

```text
$council-team list
$council-team call qa "Review the rollout risks" --session rollout-qa-1 --timeout 240
$council-team set qa --agent claude --role "QA reviewer" --reports-to lead
```

- `list`: use `council_team_list` or `council team list` and show configured roles, reporting lines, and process states.
- `call <member>`: use `council_team_call` with `member`, `task`, and `sessionId`, or `council team call <member> --task <task> --session <id>`. Pass an explicit project or invoke the CLI from that project. Preserve any supplied timeout. Generate a fresh lowercase session ID if omitted and return it with the job state. Reconnect using the same ID and task. Check the roster if the member is unknown. The role's configuration controls the agent, model, and permissions.
- `set <member>`: use `council team set` in the selected project only when the user asks to configure the role. When editing, read the existing profile and carry forward its agent, role, model, access, responsibilities and manager unless the user asked to change them. The command saves a complete profile.

Read `hc --skill` before launching or steering terminals. A Team turn starts a managed process. If you are a Team member and have delegated all remaining work, include called session IDs and any unresolved work in a final handoff, then end the turn. Ask the teammate to explicitly call your role once they have something actionable. Council archives completed results and shuts down the process after verifying completion. Use the same project for status and result retrieval.
