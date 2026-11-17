# Council Rules for AI Agents

When the Council plugin is active, you can delegate tasks, run peer reviews, conduct structured debates, and reach consensus by orchestrating a Council of AI agents (Claude Code, Codex, Antigravity, Junie) running inside Herdr.

## Principles of the Council

1. **Evidence-Based Deliberation**:
   - Competing perspectives strengthen solutions. Do not default to unexamined consensus.
   - Separate proposals from critiques and final synthesis.

2. **Roles in the Council**:
   - **Author / Implementer**: Produces the primary design or code implementation.
   - **Systematic Reviewer**: Checks correctness, test coverage, and specifications.
   - **Critical Skeptic**: Identifies edge cases, race conditions, failure modes, and unstated assumptions.
   - **Radical Simplifier (Lazy Genius)**: Eliminates speculative abstractions, over-engineering, and unnecessary machinery.
   - **Judge / Synthesizer**: Reconciles disagreements, weighs trade-offs, and provides an authoritative ruling.

3. **Herdr-Native Execution Rules**:
   - Agents run in real interactive terminals inside Herdr (`hc run --bg --name <n> --cwd <dir> -- <agent> "<task>"`).
   - Use `hc wait` or `council_wait` to wait for agent turns to finish. **Never poll or sleep in loops.**
   - Screen buffers and history can be inspected with `hc read` or `council_read`.
   - Clean up completed terminals with `hc kill` + `hc rm` or `council_dismiss` unless the user asks to inspect them.

4. **Safety & Permissions**:
   - Default to `permission: read` (plan / read-only mode) for reviews, debates, and architectural deliberations.
   - Use `permission: write` only when the user explicitly requests code modification or automated implementation.
