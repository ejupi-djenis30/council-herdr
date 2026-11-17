# Council: Herdr-Native Multi-Agent Collaboration Engine

Welcome to the **Council** repository. This project is a universal collaboration plugin designed to orchestrate AI agents (**Claude Code, Codex, Antigravity, Junie**, and other AI coding assistants) using the **Herdr** terminal multiplexer (`hc`).

## Key Capabilities

1. **Herdr-Native Execution**:
   - Launches interactive background terminals in Herdr (`hc run --bg --name <n> --cwd <dir> -- <agent> "<task>"`).
   - Keeps agents visible, steerable, and alive in `herdr-app`.
   - Uses `hc wait` for non-blocking coordination and `hc read` for screen inspection.

2. **6 Deliberation Modes**:
   - `council`: Author, Skeptic, and Simplifier deliberate; Judge produces a synthesized verdict.
   - `review`: Author drafts; Reviewer and Simplifier (Lazy Genius) inspect and trim.
   - `debate`: Two agents advocate competing viewpoints; Judge rules.
   - `parallel`: Sharded fan-out of independent tasks across multiple agents.
   - `pipeline`: Sequential handoffs passing intermediate artifacts down the chain.
   - `delegate`: Single task delegated to a specialist agent in Herdr.

3. **Multi-Host Compatibility**:
   - **Antigravity**: Discovered via `plugin.json`, `mcp_config.json`, `skills/council/SKILL.md`, and `rules/AGENTS.md`.
   - **Claude Code**: Discovered via `.claude-plugin/plugin.json`, slash command `/council`, and `.mcp.json`.
   - **Codex**: Discovered via `.codex-plugin/plugin.json` and skills.
   - **Junie**: Discovered via `skills/council/SKILL.md`.
   - **Universal**: Standard Model Context Protocol (MCP) stdio server (`bin/council.js mcp`).

## CLI Quick Reference

```bash
# Verify environment and agent availability
node bin/council.js doctor

# Check live Herdr terminals
node bin/council.js status

# Convene a Council session
node bin/council.js convene --mode council --task "Architect authentication service"

# Run a peer review
node bin/council.js convene --mode review --task "Inspect src/parser.js for edge cases"

# Delegate a task to an agent
node bin/council.js delegate --agent codex --task "Write property-based tests for serializer"

# Start the MCP stdio server
node bin/council.js mcp
```
