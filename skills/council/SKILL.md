---
name: council
description: Coordinate bounded work and reviews through Council in Herdr, respond to readiness checks, and participate in Council polls and Desktop debates.
---

# Council through Herdr

Use Council when a bounded specialist task or independent review improves the work. Herdr runs the terminals and Council records delivery, results and decision evidence. If you received a setup notice, go to **Respond to an alignment check**.

## Start and follow one task

1. Identify the intended project. Run the CLI from that directory. For project-scoped MCP tools, pass its absolute path as `project`, including on status, result and reconnect calls. A server configured to run in the project can use its working directory as the default. Read the installed `hc --skill`. Check the selected host and its authentication before launching an agent. `doctor` checks executable availability.
2. Prefer `council_start`, `council_session_status` and `council_result` for one specialist. Confirm the connection exposes these tools and `council_alignment`. If a required tool is missing or an older server cannot select the intended project, use a current Council CLI from that project. If neither path is available, report the setup gap and keep the task withheld.
3. To reuse a terminal, select its actual address using `hc ls` and confirm with `hc get <address>` that the intended agent is live in the right context and is `idle` or `done`. Verify `aligned` through `council_alignment` with `action: status` and `target`, or `council alignment status <address>`. If the agent still needs a receipt, follow **Check recipient readiness**. Launch a new agent only when the request calls for one or when a new agent is appropriate for the task.
4. Set a stable session ID and give one bounded assignment with the exact files or revision, expected result, and limits on edits and further delegation. Default to read permissions. An adopted terminal keeps its own permissions, so explicitly include the task's boundaries in the brief.
5. Keep the returned session ID and participant and worker addresses. Use status to monitor the job and result to retrieve saved output. Choose a timeout that covers readiness, work and collection. The default is 180 seconds.

For example, run the current CLI by absolute path from the target project:

```powershell
node C:/path/to/council-herdr/bin/council.js alignment status t123
node C:/path/to/council-herdr/bin/council.js start --adopt t123 --session parser-review --permission read --task "Review src/parser.js for input edge cases. Report file and line references. Keep the work read-only."
node C:/path/to/council-herdr/bin/council.js status --session parser-review
node C:/path/to/council-herdr/bin/council.js result --session parser-review
```

For a new agent, replace `--adopt t123` with `--agent <host>`. Council starts it with an alignment notice and delivers the task after the agent registers and becomes ready. If setup fails, inspect the reported address and fix its integration before considering another launch.

`start` acknowledges the job. Use its saved result to confirm completion. On timeout, a blocked turn or uncertain delivery, inspect `outcome` and `nextAction`, then check the participant and worker with `hc get` or `hc read`. The agent may still be working. To reconnect, reuse the project, session ID and identical task options. Preserve borrowed and incomplete terminals, and leave blocked prompts to their owner.

## Check recipient readiness

Use `council alignment check <address>` to request a neutral readiness turn. `state` shows the status of the receipt and `request.status` shows what happened to the notice. For `deferred_busy`, wait for `idle` or `done` and check again. For `sent`, read the receipt status after the readiness turn. For `uncertain`, inspect the terminal before sending another notice. For `failed` or `unavailable`, inspect the error and verify the target session. Keep task details and poll or debate IDs withheld until `aligned` is recorded.

For authorized project setup, preview `council alignment setup --host <claude|junie|opencode|antigravity> --project <absolute-directory>` and add `--apply` to install. For other hosts, use their plugin or MCP setup with the matching Council skill. Reload the host integration and request a receipt from that terminal. See `docs/alignment.md` in the Council installation for host details.

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

Use the assigned values from the brief. For MCP, pass the absolute session directory as `sessionId`. That directory also works as `--session` when running the CLI from elsewhere. Late ballots remain in the original session. Start a separate review if another decision is needed. If direct submission is unavailable, return your evidence and recommendation in your final answer. Report dissent and the authorization state. Persist provisional reports under `validation/` and approved reports under `reports/`. Council's tally records mechanical validation.

## Respond to an advisory poll

Open a poll with `council_poll_create` or `poll create` from your Herdr project. Use the same absolute `project` in MCP poll calls. Council Desktop lists the poll in the space containing that project.

Use the poll ID and project folder from the invitation. Read its options and context through `council_poll_read`, or use `poll show <poll-id>` with the Council CLI from that project. Submit one listed option ID or a free response if available. Include the trade-off or reason in `note`. Use your own Herdr terminal address as the voter ID. The CLI can infer it from `HC_TERMINAL_ID`. Submit via `council_poll_vote` or `poll vote <poll-id> --option <option-id> --note "<reason>"`. Use `--answer` for a free response. A later submission under the same voter ID updates the response while the poll is open. Use your normal final answer when your permissions prevent submission.

## Reply to a Desktop debate invitation

Use the project path and debate ID from the invitation. Pass the project path to `council_debate_read` and `council_debate_reply`. The bundled CLI equivalents are `debate show <id>` and `debate reply <id> --text "<reply>"`. Run them from the debate project and use your own terminal address. If project permissions prevent submission, reply in your current terminal.

## Background workflows and voting rounds

Pass the desired mode to `council_start` to run any workflow in the background. Follow it with `council_session_status` and `council_result` in the same project. Use `council_schedule_create` for a one-time or recurring workflow and `council_schedules` to inspect or cancel future runs. Use `council_retally` to refresh a completed formal round and `council_round` to start a linked round with new direct ballots. See the README for CLI equivalents.
