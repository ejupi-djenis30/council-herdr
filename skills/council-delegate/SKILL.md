---
name: council-delegate
description: Delegate one bounded task to a specific agent in Herdr, or adopt one existing terminal. Use when the user asks for Council delegate mode.
---

# Council Delegate

Use exactly one specialist. Keep the task and constraints the user supplied. A request for one delegate authorizes one bounded assignment. Leave further delegation and review to explicit requests.

```text
$council-delegate codex "Find edge cases in src/parser.js" --permission read --timeout 120
$council-delegate --adopt t123 "Inspect the failing test" --session parser-check
$council-delegate claude "Draft the migration plan" --async --session migration-plan
```

- Accept the agent as the first positional argument or as `--agent`. Use `--adopt <address>` to borrow exactly that terminal. If the user omits a target, use Codex for a new delegate. If they name a person or a configured Team role, ask for the intended agent or use the explicitly requested Team operation.
- Use `council_delegate` for a new agent and return the result. Pass `agent`, `task`, and any supplied `context`, `permission`, `timeoutSec`, and `keepTerminals`. The CLI equivalent is `council delegate --agent <agent> --task <task>`.
- Use `council_start` with `mode: delegate` when the user requests `--async`, `--session`, or `--adopt`. Pass either the selected agent or the borrowed address. Map `--session` to `sessionId`, `--timeout` to `timeoutSec`, and `--keep` to `keepTerminals`. Include context in the task when the async tool has no separate context field. The CLI equivalent is `council start --mode delegate` with the same options. Reject requests that combine `--adopt` and `--agent`, or ask to change a borrowed terminal's permissions.
- For async calls, return the session ID and recorded state. Inspect the same session with `council_session_status` / `council_result` or `council status --session` / `council result --session`. Reuse the original session and options when reconnecting.

Default to read access. Use write only for an authorized editing task. Keep an explicit project selection. Use a Council MCP server configured for that project or run the CLI from it. Read the installed `hc --skill` before steering or launching Herdr terminals. Run long CLI commands in a named background Herdr terminal and inspect the wait outcome. Use the Council alignment check when a requested terminal is unconfirmed. Preserve borrowed or incomplete terminals. On timeout or uncertain delivery, inspect the existing job and address before considering another dispatch.
