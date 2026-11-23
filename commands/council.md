---
description: Choose an explicit Council operation in Herdr and pass its arguments.
argument-hint: "[delegate|review|council|team|activity|status|result|doctor|poll|debate|parallel|pipeline|schedule|round|retally] [arguments]"
---

# Council

User arguments: $ARGUMENTS

Use the first argument as the operation and preserve the remaining arguments. Follow the `council` skill and the selected workflow's skill.

- `delegate <agent> <task>`: use `council-delegate` for one specialist. Accept `--adopt <address>`, `--async`, and `--session <id>`.
- `review <task>`: use `council-review` with `mode: review`.
- `council <task>`: run `council_convene` with `mode: council`.
- `team list|call|set`: use `council-team` and preserve the configured member ID.
- `debate <task>`, `parallel`, `pipeline`: convene the named mode. Keep explicit assignments or ordered stages. `debate show` and `debate reply` use the Desktop discussion tools.
- `schedule`, `round` and `retally`: manage future runs and formal voting in the requested project.
- `activity`, `status`, `result`, `doctor` and `poll`: use the selected operation in the requested project.

If no arguments were supplied, show this list. If the operation is missing, ambiguous, or unsupported, explain the valid choices before launching any agent. Keep explicit options and targets. Default to read access.
