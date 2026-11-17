---
name: council
description: Delegate bounded work or review a concrete proposal through visible Herdr agents.
---

# /council

- `/council <task>`: author proposal followed by skeptic and simplifier reviews.
- `/council review <task>`: author proposal followed by reviewer and simplifier reviews.
- `/council delegate <agent> <task>`: one specialist task.
- `/council status` or `/council doctor`: inspect parent-environment availability and Herdr terminals.

`debate`, `parallel` and `pipeline` are disabled experimental modes. Existing terminals are not adopted automatically.

Use connected `council_convene` or `council_delegate` tools, or the bundled CLI by absolute path from the intended project directory. Follow the installed `hc --skill` and run long commands under `hc run --bg`.

Default to read permissions. Present real findings, dissent, authorization state and next actions. Screen-only results are provisional. Only valid direct ballots from completed participants authorize promotion; a mechanical tally is not an agent signature or synthesis.

On timeout or blocked/delivery failure, inspect the session and reported addresses. Preserve recoverable agents, do not blindly relaunch tasks, and never automatically dismiss user terminals. See `skills/council/SKILL.md`.
