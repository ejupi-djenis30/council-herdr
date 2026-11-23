# Council project instructions

Council adds briefs, proposal handoffs, independent review and durable results to Herdr. Herdr owns execution and terminal visibility.

Read [docs/owner-brief.md](docs/owner-brief.md) for acceptance criteria and file ownership. Use `convene` for council, review, delegate, debate, parallel, and pipeline. Debate, parallel, and pipeline save advisory evidence.

- Follow the installed `hc --skill` when launching, waiting on or steering terminals. Keep tasks interactive, bounded and visible. No extra agents without an explicit assignment.
- A command exit code of zero is not task completion. Interpret delivery, status, turn and wait reason; preserve incomplete agents and respect deadlines.
- Track launched terminal addresses. Cleanup only completed terminals owned by the workflow. Never automatically dismiss borrowed/user terminals.
- Complete the author proposal before reviewer launch. Preserve exact bytes and digest; prefer direct artifacts and label screen fallbacks honestly.
- Only valid direct ballots from completed participants authorize approval. Screen markers are informational. Missing votes stay missing; invalid ballots or rejection cannot become approval.
- Mechanical validation is not an agent signature or endorsement. Persist provisional evidence and next actions under `validation/`; approved deliverables belong under `reports/` after checks pass.
- Stay within the user's editing authorization. A read-only sandbox may lack `hc` or artifact-write access; collect its final answer without bypassing permissions.

Use `npm test` and `node bin/council.js doctor`. Inside Herdr, run long commands under `hc run --bg` and wait with `hc wait`. Distinguish mocked regressions, live transport checks and real-agent checks in review claims.

For asynchronous delegation, use `start`, `status --session` and `result --session` or the corresponding MCP tools. Treat the job's deadline and delivery record as durable. Reconnecting to an existing job must preserve worker progress and avoid sending the task again.
