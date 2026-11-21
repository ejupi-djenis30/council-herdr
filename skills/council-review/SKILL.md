---
name: council-review
description: Run Council's formal review in Herdr with an author and independent reviewers when the user selects review mode.
---

# Council Review

```text
$council-review "Review the parser change for backward compatibility" --agents claude,codex,junie --permission read
```

Use `council_convene` with `mode: review`. The CLI equivalent is `council convene --mode review --task <task>`. Pass the requested task, project, context, criteria, session, timeout, permissions, and terminal retention. Default to read access and use the Council server for the selected project or run the CLI from it.

Review runs three ordered roles: author, reviewer, simplifier. When the user supplies `--agents`, use their three agents in that order. Ask for missing or conflicting assignments before starting. With an unspecified roster, use Council's defaults. A request for one specialist uses delegation when the user selects that operation.

Read `hc --skill` before launching or steering terminals. Run a long CLI command in a named Herdr background terminal and inspect its wait outcome. The author must complete the proposal before reviewers start. Follow Council's exact artifact and digest handoff. Only valid direct ballots from completed participants can authorize a result. Report the recorded authorization, evidence, dissent, missing votes, and next step. Preserve incomplete terminals and inspect the recorded session before retrying.
