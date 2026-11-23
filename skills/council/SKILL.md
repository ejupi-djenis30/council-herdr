---
name: council
description: Select a Council workflow in Herdr, respond to a Council readiness check, or participate in an assigned review, poll, or discussion.
---

# Council through Herdr

## Choose the operation

The first word after the Council skill mention selects the workflow. Accept **delegate**, **review**, **council**, **debate**, **parallel**, **pipeline**, **schedule**, **round**, **retally**, **team**, **activity**, **status**, **result**, **doctor**, and **poll**. An explicit operation in plain language works too. Pass the mode explicitly when the tool accepts a mode field. If the invocation only names Council or leaves the intended workflow ambiguous, show the matching choices and ask which to run before launching agents. An explicit Council readiness notice or participation assignment follows the relevant instructions below.

| Invocation | Operation |
| --- | --- |
| `$council delegate codex "Inspect the parser"` | One specialist. Use the `council-delegate` skill for target and timing options. |
| `$council review "Check the parser proposal"` | Formal review with an author, reviewer and simplifier. Use the `council-review` skill. |
| `$council council "Decide the migration strategy"` | Convene an author, skeptic and simplifier with `council_convene` and `mode: council`. CLI: `council convene --mode council --task ...`. |
| `$council debate "Compare the proposals"`, `parallel` or `pipeline` | Use the corresponding mode in `council_convene` or `council_start`. Preserve each assignment or ordered stage. |
| `$council team call qa "Check the migration plan" --session qa-1` | Call the configured Team role `qa`. Use the `council-team` skill. |
| `$council status --session qa-1` / `$council result --session qa-1` | Inspect the existing job with `council_session_status` / `council_result`. CLI: `council status` / `council result` with the same session. |
| `$council activity` / `$council activity --session qa-1` | Read project or run activity through `council_activity` or the matching CLI command. Use `council_report_progress` for an explicit report. |
| `$council status` / `$council doctor` | Inspect Herdr terminals or the environment. Use `council_status` or the matching CLI command. |
| `$council poll show <id>` / `$council debate create --question "..."` | Inspect a poll or open a discussion thread. Use the matching tool or CLI command in the intended project. |

Preserve explicit task text, target, project, session ID, permission, timeout and terminal retention. Default to read access and keep the assignment bounded. If a supplied option conflicts with the selected workflow, explain the conflict before starting. Formal modes use three ordered roles. If the user supplies an incomplete roster, ask for the missing roles before launch. Use an explicit task with `debate` to convene the automated workflow. Use `debate create`, `debate show`, or `debate reply` for a Desktop thread.

1. Identify the intended project. Run the CLI from that directory. For project-scoped MCP tools, pass its absolute path as `project`, including on status, result and reconnect calls. A server configured to run in the project can use its working directory as the default. Read the installed `hc --skill`. Check the selected host and its authentication before launching an agent. `doctor` checks executable availability.
2. Prefer `council_start`, `council_session_status` and `council_result` for one specialist. Confirm the connection exposes these tools and `council_alignment`. If a required tool is missing or an older server cannot select the intended project, use a current Council CLI from that project. If neither path is available, report the setup gap and keep the task withheld.
3. To reuse a terminal, select its actual address using `hc ls` and confirm with `hc get <address>` that the intended agent is live in the right context and is `idle` or `done`. Verify `aligned` through `council_alignment` with `action: status` and `target`, or `council alignment status <address>`. If the agent still needs a receipt, follow **Check recipient readiness**. Launch a new agent only when the request calls for one or when a new agent is appropriate for the task.
4. Set a stable session ID and give one bounded assignment with the exact files or revision, expected result, and limits on edits and further delegation. Default to read permissions. An adopted terminal keeps its own permissions, so explicitly include the task's boundaries in the brief.
5. Keep the returned session ID and participant and worker addresses. Use status to monitor the job and result to retrieve saved output. Choose a timeout that covers readiness, work and collection. The default is 180 seconds.

## Start

1. Verify the intended project directory, selected CLI and authentication. `doctor` checks executable availability. Read the installed `hc --skill` before delegating or running long commands.
2. Default to `permission: read`. Use write permissions only when the user's task authorizes editing. Supply exact scope and criteria; forbid extra agents unless explicitly assigned.
3. Use the selected operation's MCP tool when its server runs in the intended project directory or accepts an explicit project. Otherwise use `council` on PATH or run `node <absolute-checkout>/bin/council.js` from the intended project:

```powershell
node C:/path/to/council-herdr/bin/council.js alignment status t123
node C:/path/to/council-herdr/bin/council.js start --adopt t123 --session parser-review --permission read --task "Review src/parser.js for input edge cases. Report file and line references. Keep the work read-only."
node C:/path/to/council-herdr/bin/council.js status --session parser-review
node C:/path/to/council-herdr/bin/council.js result --session parser-review
```

For a new agent, replace `--adopt t123` with `--agent <host>`. Council starts it with an alignment notice and delivers the task after the agent registers and becomes ready. If setup fails, inspect the reported address and fix its integration before considering another launch.

`start` acknowledges the job. Use its saved result to confirm completion. On timeout, a blocked turn or uncertain delivery, inspect `outcome` and `nextAction`, then check the participant and worker with `hc get` or `hc read`. The agent may still be working. To reconnect, reuse the project, session ID and identical task options. Preserve borrowed and incomplete terminals, and leave blocked prompts to their owner.

## On-demand team turns

On a named Team turn, use `council_team_list` to find a teammate and `council_team_call` to give them a brief and unique session ID. Follow your role and reporting line from your task brief. If you delegate all remaining work, record the handoff and called session IDs in your final response and end the turn immediately. Ask the teammate to explicitly call your role once they have something actionable. Council saves the result and stops your model process after a verified turn. Start each new turn with a new ID. Read archived handoffs with `council_result` or `council result --session <id>`.

Set `--timeout` or MCP `timeoutSec` to cover the entire job when the default of 180 seconds is too short. Read the `outcome` and `nextAction` fields after a blocked turn, uncertain delivery, or deadline expiry. A deadline can end Council collection while the agent continues working in Herdr.

## Check recipient readiness

Use `council alignment check <address>` to request a neutral readiness turn. `state` shows the status of the receipt and `request.status` shows what happened to the notice. For `deferred_busy`, wait for `idle` or `done` and check again. For `sent`, read the receipt status after the readiness turn. For `uncertain`, inspect the terminal before sending another notice. For `failed` or `unavailable`, inspect the error and verify the target session. Keep task details and poll or debate IDs withheld until `aligned` is recorded.

For authorized project setup, preview `council alignment setup --host <codex|claude|junie|opencode|antigravity> --project <absolute-directory>` and add `--apply` to install. For other hosts, use their plugin or MCP setup with the matching Council skill. Reload the host integration and request a receipt from that terminal. See `docs/alignment.md` in the Council installation for host details.

## Respond to an alignment check

When you have this skill and the Council tool, call `council_alignment` with `{"action":"report","state":"aligned","revision":"council/herdr-alignment-v1"}`. If the server lacks `HC_TERMINAL_ID`, include your terminal address as `target` and the `challenge` from the notice. After the receipt, finish the readiness turn and wait for a separate assignment.

If the skill or integration is unavailable, report `not_aligned` through MCP if possible, or use the notice's `alignment decline` command from your own terminal if permitted. Say `Council alignment: not aligned` and end the turn.

## Convene a formal review

Use `council_convene` or `convene --mode council|review` when the task calls for a formal author and review panel. Name the hosts you have verified for the project. The author finishes first, and reviewers receive the exact proposal and its SHA-256 digest. Run long CLI workflows in a named Herdr background terminal with `hc run --bg --name <name> --cwd <project> -- <command>` and follow them with `hc wait` and `hc read`. Desktop debates use the poll and debate tools below. For an automated debate, parallel assignments, or a sequential pipeline, use `council_convene` with the corresponding mode. See the README for subtasks and stages.

Only explicit direct ballots bound to the session, assigned voter, round and proposal digest authorize promotion, after that participant completes its turn. Keep screen evidence and quotes as provisional findings. Submit only your own ballot through a permitted channel.

If a permitted direct channel exists, use `council_cast_ballot` or:

```powershell
node C:/path/to/council-herdr/bin/council.js cast-ballot --session <session-id-or-directory> --round <round> --voter <assigned-voter> --role <assigned-role> --agent <agent> --vote <approve|reject|amend> --score <1-10> --rationale "<reason>" --target-sha <proposal-sha256>
```

Use the assigned values from the brief. For MCP, pass the absolute session directory as `sessionId`. That directory also works as `--session` when running the CLI from elsewhere. Late ballots refresh the saved tally in the original session. Start a linked round if the proposal needs a new decision. If direct submission is unavailable, return your evidence and recommendation in your final answer. Report dissent and the authorization state. Persist provisional reports under `validation/` and approved reports under `reports/`. Council's tally records mechanical validation.

## Respond to an advisory poll

Open a poll with `council_poll_create` or `poll create` from your Herdr project. Use the same absolute `project` in subsequent calls. Supply `sourceDebateId` or `--debate <id>` to link it to a discussion. Use `council_poll_manage` to add options, manage the roster, or record the closing outcome.

Use the poll ID and project folder from the invitation. Read its options and context through `council_poll_read`, or use `poll show <poll-id>` with the Council CLI from that project. Submit one listed option ID or a free response if available. Include the trade-off or reason in `note`. Use your own Herdr terminal address as the voter ID. The CLI can infer it from `HC_TERMINAL_ID`. Submit via `council_poll_vote` or `poll vote <poll-id> --option <option-id> --note "<reason>"`. Use `--answer` for a free response. A later submission under the same voter ID updates the response while the poll is open. Use your normal final answer when your permissions prevent submission.

## Inspect and report

- Read, steer and wait through Council tools or `hc` using actual terminal addresses, not assumed role names.
- Startup idle, timeout, blocked, delivery-not-started and malformed output are not completion. Respect the deadline and never blindly resubmit tasks.
- Cleanup only completed terminals created by the workflow. Preserve recoverable agents beyond orchestrator exit; never automatically dismiss borrowed/user terminals.
- Present findings, dissent, authorization state and concrete next actions. Persist provisional reports under `validation/`; approved reports go to `reports/`.
- Tally and digest checks are mechanical, not an agent synthesis, signature or endorsement.
- In an assigned delegation, a short handoff or blocker can go in `council_report_progress` with the session ID. Include a real `PLAN.md` component ID when applicable. Treat notes as reported context and rely on the recorded outcome for completion.

## Open or reply to a Desktop debate

Herdr Desktop shows the project's saved CLI and MCP threads under **Debate**. For a thread, report the returned `sessionId` and project so the operator can find it. For an automated workflow, report the job ID and the project. On a paired machine, use the terminal addresses reported by that project's own Herdr core.

Open a thread with `council_debate_create` or `debate create --question "<topic>" --context "<opening message>"`. Pass the intended absolute project to MCP or run the CLI in that project. When asked to invite specific participants to a debate or poll, pass their live terminal addresses as `recipients` or repeat `--invite <address>`. Use the saved ID to check invitation delivery. If the worker acknowledgement is missing, inspect the original queue in Desktop. Omit recipients when opening a discussion without invitations.

Find threads using `debate list` or `council_debate_read` without a debate ID. Record the agreed decision, owner and next step through `council_debate_close` or `debate close <id> --decision "..." --owner "..." --next-step "..."`. Use your own terminal identity.

Use the project path and debate ID from the invitation. Pass the project path to `council_debate_read` and `council_debate_reply`. The bundled CLI equivalents are `debate show <id>` and `debate reply <id> --text "<reply>"`. Run them from the debate project and use your own terminal address. If project permissions prevent submission, reply in your current terminal.

## Background workflows and voting rounds

Pass the desired mode to `council_start` to run any workflow in the background. Follow it with `council_session_status` and `council_result` in the same project. Use `council_schedule_create` for a one-time or recurring workflow. Inspect a schedule with `council_schedules` and `action: status`. Use `resume` when the worker is verified stopped, or `cancel` to stop future runs. Use `council_retally` to refresh a completed formal round and `council_round` to start a linked round with new direct ballots.
