---
name: council
description: Delegate bounded work or review a concrete proposal through visible Herdr agents.
---

# /council

- `/council <task>`: author proposal followed by skeptic and simplifier reviews.
- `/council review <task>`: author proposal followed by reviewer and simplifier reviews.
- `/council delegate <agent> <task>`: one specialist task.
- `/council status` or `/council doctor`: inspect parent-environment availability and Herdr terminals.

For one specialist, prefer `council_start`, `council_session_status` and `council_result` or the equivalent CLI commands `start`, `status` and `result`. Use the intended project directory for the CLI and carry its absolute path as `project` in project-scoped MCP calls. Specify the terminal address to reuse after verifying it is aligned and idle or done. Keep the session ID and identical task options for reconnecting.

Use `council_convene` for formal council or review. Check that the MCP connection exposes the tools required for the workflow, including `council_alignment`. Use the current CLI by absolute path if the connection is missing tools or cannot select the project. Read the installed `hc --skill` and run long blocking CLI commands under `hc run --bg`.

Default to read permissions. Present verified findings, dissent, authorization state and next actions. Screen-only results are provisional. Only explicit, valid direct ballots from completed participants authorize promotion.

On timeout, a blocked turn or uncertain delivery, inspect the session and terminal addresses before attempting recovery. Preserve borrowed and incomplete terminals. See `skills/council/SKILL.md`.
