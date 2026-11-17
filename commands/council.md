---
name: council
description: Convene an AI Council or run multi-agent collaboration (council, review, debate, parallel, pipeline) via Herdr.
---

# /council

Convene a multi-agent Council of AI agents (Claude Code, Codex, Antigravity, Junie) running inside Herdr.

## Usage

- `/council <task>`: Convene a standard 3-agent Council (Author, Skeptic, Simplifier) to deliberate on an architectural or implementation choice.
- `/council review <task>`: Run a multi-perspective peer review on the current diff or files.
- `/council debate <option-a> vs <option-b>`: Launch a formal debate between two viewpoints, judged by a referee agent.
- `/council status`: Check the status of active Herdr terminals.
- `/council doctor`: Check availability of Herdr and installed agent CLIs.

## Command Execution

When invoked by the user:
1. If MCP tools are available, call `council_convene` with the specified mode and task.
2. If executing via terminal, run `node bin/council.js convene --task "<task>"`.
3. Present the resulting Council synthesis report clearly to the user.
