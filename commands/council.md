---
description: Choose an explicit Council operation in Herdr and pass its arguments.
argument-hint: "[delegate|review|council|team|status|result|doctor|poll|debate] [arguments]"
---

# Council

User arguments: $ARGUMENTS

Use the first argument as the operation and preserve the remaining arguments. Follow the `council` skill and the selected workflow's skill.

- `delegate <agent> <task>`: use `council-delegate` for one specialist. Accept `--adopt <address>`, `--async`, and `--session <id>`.
- `review <task>`: use `council-review` with `mode: review`.
- `council <task>`: run `council_convene` with `mode: council`.
- `team list|call|set`: use `council-team` and preserve the configured member ID.
- `status`, `result`, `doctor`, `poll`, `debate`: use the selected operation in the requested project.

If no arguments were supplied, show this list. If the operation is missing, ambiguous, or unsupported, explain the valid choices before launching any agent. Keep explicit options and targets. Default to read access.
