---
name: council
description: Select a Council workflow in Herdr, respond to a Council readiness check, or participate in an assigned review, poll, or discussion.
---

# Council through Herdr

## Choose the operation

The first word after the Council skill mention selects the workflow. Accept **delegate**, **review**, **council**, **team**, **status**, **result**, **doctor**, **poll**, and **debate**. An explicit operation in plain language works too. Pass the mode explicitly when the tool accepts a mode field. If the invocation only names Council or leaves the intended workflow ambiguous, show the matching choices and ask which to run before launching agents. An explicit Council readiness notice or participation assignment follows the relevant instructions below.

| Invocation | Operation |
| --- | --- |
| `$council delegate codex "Inspect the parser"` | One specialist. Use the `council-delegate` skill for target and timing options. |
| `$council review "Check the parser proposal"` | Formal review with an author, reviewer and simplifier. Use the `council-review` skill. |
| `$council council "Decide the migration strategy"` | Convene an author, skeptic and simplifier with `council_convene` and `mode: council`. CLI: `council convene --mode council --task ...`. |
| `$council team call qa "Check the migration plan" --session qa-1` | Call the configured Team role `qa`. Use the `council-team` skill. |
| `$council status --session qa-1` / `$council result --session qa-1` | Inspect the existing job with `council_session_status` / `council_result`. CLI: `council status` / `council result` with the same session. |
| `$council status` / `$council doctor` | Inspect Herdr terminals or the environment. Use `council_status` or the matching CLI command. |
| `$council poll show <id>` / `$council debate show <id>` | Inspect the advisory poll or Desktop discussion in its project. Use the matching tool or CLI command. |

Preserve explicit task text, target, project, session ID, permission, timeout and terminal retention. Default to read access and keep the assignment bounded. If a supplied option conflicts with the selected workflow, explain the conflict before starting. Formal modes use three ordered roles. If the user supplies an incomplete roster, ask for the missing roles before launch. Experimental multi-agent modes `debate`, `parallel` and `pipeline` are disabled. Desktop `debate show` and `debate reply` still work.

## Council alignment

An alignment check is a setup request. When this skill and the Council MCP tool are available, call `council_alignment` with `{"action":"report","state":"aligned","revision":"council/herdr-alignment-v1"}`. Finish the readiness turn after the receipt succeeds. The coordinator will send a separate assignment. If the server cannot see `HC_TERMINAL_ID`, include your own terminal `target` and the `challenge` from the notice.

If either integration component is unavailable, say `Council alignment: not aligned` and stop. Report `not_aligned` through MCP if available, or run `council alignment decline` in your own Herdr terminal if permitted. The decline command only reports setup status.

As coordinator, query with `council_alignment` (`action: status`, `target`) or `council alignment status <address>`. Send only the neutral readiness notice while setup is missing or unconfirmed. A terminal address, a software version, or a quoted reply alone cannot substitute for the alignment receipt. Use `council alignment check <address>` to ask for a new check. When the user authorizes setup, `council alignment setup --host <codex|claude|junie|opencode> --project <absolute-directory>` previews project files. Codex setup installs the skills and prints the MCP entry for configuration. Reload the host's integrations and request a new receipt.

## Start

1. Verify the intended project directory, selected CLI and authentication. `doctor` checks executable availability. Read the installed `hc --skill` before delegating or running long commands.
2. Default to `permission: read`. Use write permissions only when the user's task authorizes editing. Supply exact scope and criteria; forbid extra agents unless explicitly assigned.
3. Use the selected operation's MCP tool when its server runs in the intended project directory or accepts an explicit project. Otherwise use `council` on PATH or run `node <absolute-checkout>/bin/council.js` from the intended project:

```powershell
node C:/path/to/council-herdr/bin/council.js delegate --agent codex --task "Inspect parser edge cases" --permission read
node C:/path/to/council-herdr/bin/council.js convene --mode review --task "Review the parser proposal" --permission read
```

Inside Herdr, run a long workflow in a named background terminal and use `hc wait`:

```powershell
hc run --bg --name parser-review --cwd C:/path/to/project -- node C:/path/to/council-herdr/bin/council.js convene --mode review --task "Review the parser proposal"
hc wait parser-review
hc read parser-review
```

Do not launch a duplicate after timeout. Inspect the session and reported addresses first. Do not restart Herdr or force input through a blocked prompt.

## Adopt a terminal for one task

Choose a ready terminal by address and run from the target project. Use the same session ID and task options when reconnecting.

```powershell
node C:/path/to/council-herdr/bin/council.js start --mode delegate --adopt t123 --session parser-review --task "Inspect parser edge cases"
node C:/path/to/council-herdr/bin/council.js status --session parser-review
node C:/path/to/council-herdr/bin/council.js result --session parser-review
```

The MCP tools are `council_start`, `council_session_status` and `council_result`. Inspect the participant's terminal while the worker runs and retrieve the saved output when ready. Adopted agents retain their existing permissions. If delivery is uncertain, inspect the terminal and the worker before starting another task.

## On-demand team turns

On a named Team turn, use `council_team_list` to find a teammate and `council_team_call` to give them a brief and unique session ID. Follow your role and reporting line from your task brief. If you delegate all remaining work, record the handoff and called session IDs in your final response and end the turn immediately. Ask the teammate to explicitly call your role once they have something actionable. Council saves the result and stops your model process after a verified turn. Start each new turn with a new ID. Read archived handoffs with `council_result` or `council result --session <id>`.

Set `--timeout` or MCP `timeoutSec` to cover the entire job when the default of 180 seconds is too short. Read the `outcome` and `nextAction` fields after a blocked turn, uncertain delivery, or deadline expiry. A deadline can end Council collection while the agent continues working in Herdr.

## Submission and approval

The author finishes before reviewers start. Reviewers receive the exact proposal and its SHA-256 digest. Write artifacts only through a permitted channel. A read-only agent can return a final response on screen.

Only explicit direct ballots bound to the session, expected voter, round and proposal digest authorize promotion, after that participant completes its turn. Never cast votes on others' behalf from screen quotes. Markers are informational; absent direct quorum leaves a provisional, unauthorized result.

If a permitted direct channel exists, use `council_cast_ballot` or:

```powershell
node C:/path/to/council-herdr/bin/council.js cast-ballot --session <session-id-or-directory> --voter <assigned-voter> --role <assigned-role> --agent <agent> --vote <approve|reject|amend> --score <1-10> --rationale "<reason>" --target-sha <proposal-sha256>
```

Use the assigned voter and the digest from the brief. From another directory, pass the explicit session path. A later ballot does not automatically rerun a finished workflow. If `hc` or direct writes are unavailable, finish the normal final answer; do not search unrelated directories or broaden permissions to force submission.

## Respond to an advisory poll

Open a poll with `council_poll_create` or `poll create` from your Herdr project. Include the same absolute `project` in MCP poll calls when the server runs from a different directory. Council Desktop lists the poll in the space containing that project.

Use the poll ID and project folder from the invitation. Read its options and context through `council_poll_read`, or use `poll show <poll-id>` with the Council CLI from that project. Submit one listed option ID or a free response if available. Include the trade-off or reason in `note`. Use your own Herdr terminal address as the voter ID. The CLI can infer it from `HC_TERMINAL_ID`. Submit via `council_poll_vote` or `poll vote <poll-id> --option <option-id> --note "<reason>"`. Use `--answer` for a free response. A later submission under the same voter ID updates the response while the poll is open. Use your normal final answer when your permissions prevent submission.

## Inspect and report

- Read, steer and wait through Council tools or `hc` using actual terminal addresses, not assumed role names.
- Startup idle, timeout, blocked, delivery-not-started and malformed output are not completion. Respect the deadline and never blindly resubmit tasks.
- Cleanup only completed terminals created by the workflow. Preserve recoverable agents beyond orchestrator exit; never automatically dismiss borrowed/user terminals.
- Present findings, dissent, authorization state and concrete next actions. Persist provisional reports under `validation/`; approved reports go to `reports/`.
- Tally and digest checks are mechanical, not an agent synthesis, signature or endorsement.

## Reply to a Desktop debate invitation

Use the project path and debate ID from the invitation. Read the thread through `council_debate_read` and post a reasoned reply through `council_debate_reply`. The bundled CLI equivalents are `debate show <id>` and `debate reply <id> --text "<reply>"`. Run them from the debate project and use your own terminal address. If project permissions prevent submission, reply in your current terminal.

Host files are configuration scaffolding, not proof of automatic discovery or live compatibility with an untested host.
