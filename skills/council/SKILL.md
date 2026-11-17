---
name: council
description: Delegate bounded tasks and review concrete proposals through visible Herdr agents, preserving evidence and honest completion states.
---

# Council through Herdr

Use Council when a bounded specialist task or independent review improves the work. Herdr runs terminals; Council adds briefs, handoffs and session artifacts.

Supported modes: `delegate`, `council`, `review`. `debate`, `parallel` and `pipeline` are disabled experimental modes. Existing-terminal adoption and nonblocking start/status/result are not implemented yet.

## Start

1. Verify the intended project directory, selected CLI and authentication. `doctor` checks executable availability. Read the installed `hc --skill` before delegating or running long commands.
2. Default to `permission: read`. Use write permissions only when the user's task authorizes editing. Supply exact scope and criteria; forbid extra agents unless explicitly assigned.
3. If connected, use `council_convene` for council/review or `council_delegate` for one specialist. The MCP server must run in the intended project directory.
4. Otherwise invoke the bundled CLI by absolute path from that project:

```powershell
node C:/path/to/Council/bin/council.js delegate --agent codex --task "Inspect parser edge cases" --permission read
node C:/path/to/Council/bin/council.js convene --mode review --task "Review the parser proposal" --permission read
```

Inside Herdr, run a long workflow in a named background terminal and use `hc wait`:

```powershell
hc run --bg --name parser-review --cwd C:/path/to/project -- node C:/path/to/Council/bin/council.js convene --mode review --task "Review the parser proposal"
hc wait parser-review
hc read parser-review
```

Do not launch a duplicate after timeout. Inspect the session and reported addresses first. Do not restart Herdr or force input through a blocked prompt.

## Submission and approval

The author finishes before reviewers start. Reviewers receive the exact proposal and its SHA-256 digest. Write artifacts only through a permitted channel. A read-only agent can return a final response on screen.

Only explicit direct ballots bound to the session, expected voter, round and proposal digest authorize promotion, after that participant completes its turn. Never cast votes on others' behalf from screen quotes. Markers are informational; absent direct quorum leaves a provisional, unauthorized result.

If a permitted direct channel exists, use `council_cast_ballot` or:

```powershell
node C:/path/to/Council/bin/council.js cast-ballot --session <session-id-or-directory> --voter <assigned-voter> --role <assigned-role> --agent <agent> --vote <approve|reject|amend> --score <1-10> --rationale "<reason>" --target-sha <proposal-sha256>
```

Use the assigned voter and the digest from the brief. From another directory, pass the explicit session path. A later ballot does not automatically rerun a finished workflow. If `hc` or direct writes are unavailable, finish the normal final answer; do not search unrelated directories or broaden permissions to force submission.

## Inspect and report

- Read, steer and wait through Council tools or `hc` using actual terminal addresses, not assumed role names.
- Startup idle, timeout, blocked, delivery-not-started and malformed output are not completion. Respect the deadline and never blindly resubmit tasks.
- Cleanup only completed terminals created by the workflow. Preserve recoverable agents beyond orchestrator exit; never automatically dismiss borrowed/user terminals.
- Present findings, dissent, authorization state and concrete next actions. Persist provisional reports under `validation/`; approved reports go to `reports/`.
- Tally and digest checks are mechanical, not an agent synthesis, signature or endorsement.

Host files are configuration scaffolding, not proof of automatic discovery or live compatibility with an untested host.
