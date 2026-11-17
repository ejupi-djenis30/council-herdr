---
name: council
description: Coordinate Claude Code, Codex, Antigravity, and Junie with Council to solve complex engineering decisions, multi-agent peer reviews, debates, and parallel tasks via Herdr.
---

# Council: Multi-Agent Collaboration via Herdr

Council coordinates a team of AI coding agents (**Claude Code, Codex, Antigravity, Junie**) running inside **Herdr** (`hc`). It provides structured deliberation modes, role-based specialization, and automated synthesis.

## When to Convene the Council

- **Hard Architectural or Design Decisions**: When there are multiple viable approaches and trade-offs must be evaluated rigorously (`mode: council`).
- **Comprehensive Peer Review**: When an author drafts a solution and needs independent review plus ruthless simplification (`mode: review`).
- **Formal Debate**: When two competing paradigms or technologies clash and need an evidence-based verdict (`mode: debate`).
- **Sharded Work / Fan-Out**: When multiple independent investigations or refactorings can run in parallel (`mode: parallel`).
- **Sequential Staged Pipeline**: When tasks form a chain (e.g. Spec -> Implement -> Test -> Review) (`mode: pipeline`).
- **Targeted Delegation**: When a single specialized subtask is offloaded to another agent in Herdr (`mode: delegate`).

## How to Convene the Council

### Method 1: Using Council MCP Tools (Recommended)

When Council's MCP server is connected:

1. **Check Environment**:
   Call `council_status` to verify available agent CLIs and active Herdr terminals.

2. **Convene Collaboration**:
   Call `council_convene`:
   ```json
   {
     "mode": "council",
     "task": "Design a distributed caching strategy for the order service",
     "criteria": "Must support 50k RPS, tolerate node restarts, and minimize Redis memory footprint",
     "agents": ["claude", "codex", "antigravity"],
     "permission": "read"
   }
   ```

3. **Delegate a Subtask**:
   Call `council_delegate`:
   ```json
   {
     "agent": "codex",
     "task": "Implement unit tests for the token bucket rate limiter in src/limiter.js",
     "permission": "write"
   }
   ```

4. **Steer or Read Live Terminals**:
   - `council_read({ target: "council-author", lines: 50 })`
   - `council_send({ target: "council-author", message: "Focus on memory footprint first" })`
   - `council_wait({ target: "council-author" })`
   - `council_dismiss({ target: "council-author" })`

### Method 2: Using the Packaged CLI

If MCP tools are not active in the current host, use the bundled CLI:

```bash
# Check environment and agent CLIs
node bin/council.js doctor

# Convene a council
node bin/council.js convene --mode council --task "Architect database sharding schema"

# Run a peer review
node bin/council.js convene --mode review --task "Review commit diff for memory leaks"

# Delegate to Codex
node bin/council.js delegate --agent codex --task "Add edge case unit tests"

# Check status or dismiss terminals
node bin/council.js status
node bin/council.js dismiss council-author council-skeptic
```

## Council Roles

- **Author / Implementer** (`council-author`): Produces the initial design or code.
- **Systematic Reviewer** (`council-reviewer`): Checks correctness, test coverage, safety, and maintainability.
- **Critical Skeptic** (`council-skeptic`): Red-teams the solution, exposing failure modes, edge cases, and hidden pitfalls.
- **Radical Simplifier / Lazy Genius** (`council-simplifier`): Targets premature abstraction and accidental complexity, seeking the simplest complete alternative.
- **Judge / Synthesizer** (`council-judge`): Delivers balanced consensus, actionable next steps, and reconciles dissent.

## Herdr Execution Recipes (Under the Hood)

Council runs all agents under Herdr with safe Windows-tested recipes:

| Agent | Read-Only (Plan) | Write (Edit) |
|---|---|---|
| Claude Code | `claude --permission-mode plan` | `claude --permission-mode acceptEdits` |
| Codex | `codex --no-daemon -s read-only -a never` | `codex --no-daemon -s workspace-write -a never` |
| Antigravity | `agy --mode plan -i "<task>"` | `agy --mode accept-edits -i "<task>"` |
| Junie | `junie --plan "--prompt=<task>"` | `junie "--prompt=<task>"` |

Each agent appears in Herdr's window (`herdr-app`), remaining visible, interactive, and steerable by the user.
