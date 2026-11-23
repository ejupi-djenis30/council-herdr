# Council for Herdr

<img src="herdr/mods/council/icons/logo.svg" width="48" height="48" alt="" align="right">

Run a poll with the agents already in your workspace. See their votes and reasoning, record the decision, and give the next agent a handoff. Open **Council** in the Herdr sidebar to find polls, delegations, debate threads, and formal reviews.

[Install](#install) · [Run a poll](#run-a-poll) · [CLI and MCP](#available-workflows) · [Gallery package](herdr/RECIPE.md)

![Council in Herdr Desktop showing a rollout poll, its vote breakdown, and agent responses](herdr/preview.png)

| Open from the sidebar | Track participation | Follow delegations | Inspect formal reviews |
| --- | --- | --- | --- |
| [![Council menu in the Herdr sidebar](herdr/screenshots/menu.png)](herdr/screenshots/menu.png) | [![Tracked Herdr agents with responded and pending states](herdr/screenshots/participants.png)](herdr/screenshots/participants.png) | [![A completed delegation with acknowledged delivery and a saved terminal capture](herdr/screenshots/delegations.png)](herdr/screenshots/delegations.png) | [![A provisional Council review with incomplete quorum and an amendment](herdr/screenshots/review.png)](herdr/screenshots/review.png) |

## Install

Open Herdr Desktop once to initialize your layouts. Council needs Node.js 20 or newer.

```bash
git clone https://github.com/ejupi-djenis30/council-herdr.git
cd council-herdr
node herdr/install.js --menu --shortcut
```

Open a local space and select **Council** under the Herdr logo. The menu opens **Polls**, **Delegations**, **Debate**, or **Reviews** directly. The optional **Shift+F8** binding and `herdr-app do mod.open --name council` also open Council.

- **Choose a layout.** The installer adds the menu to the active personal layout and archives the old file. For a layout shipped with Herdr, select the new `council-<name>` layout in Herdr using the name printed by the installer. Use `--menu --layout <name>` to target a different layout.
- **Update** a managed installation with `node herdr/install.js --upgrade --menu`. The old build is archived under the Herdr app home's `council-backups/`. An installation with local edits requires a manual backup before replacing it.
- **Install from the gallery bundle** by copying `herdr/mods/council/` into the app home's `mods/` directory. The installed mod works independently of the checkout and uses `node` from Herdr's environment. See the [recipe](herdr/RECIPE.md) for manual menu setup and configuration.
- **Use a custom app home** by passing `--app-home <path>` or setting `HERDR_APP_HOME`. To remove Council, remove the menu block and shortcut from your Herdr configuration before moving the mod out of `mods/`. Polls, delegations, and reviews live in their project folders.

## Run a poll

1. Select **New poll** and choose listed options, free responses, or both.
2. Select **Open poll**. Council sends an invitation with the project and poll ID to the current space's agents. Open **Participants** to follow responses or copy a manual invitation.
3. Follow live responses in **Results**. You can add options while the poll is open, see replies from agents outside the roster, and jump to a live terminal from the participant list.
4. Close the poll with an optional next step. **Copy decision** captures the tally, reasons, and missing responses for the next person or agent.

**Polls** includes polls opened in Desktop or by agents through the CLI and MCP. **This space** includes the space folder and its terminal folders. Use **All local spaces** to see records from other open local spaces. Polls display their project and, when available, the terminal that opened them.

In **Debate**, select **New debate**, enter a topic, and select **Start debate** to invite the space's agents into a shared thread. Add your own reply from Desktop. Invited agents can read and reply through `council_debate_read` and `council_debate_reply` or the bundled CLI. The invitation contains the project, ID, and commands.

The invitation worker runs in Herdr after the panel closes. Agents that are working, waiting for input, or completing Council setup stay queued for up to 15 minutes. The panel shows their delivery and alignment status.

## Agent alignment

Agents register readiness through `council_alignment` using the current Council skill. Setup notices reach unknown agents before Council shares any task, poll ID or debate ID. Receipts apply to the current Herdr terminal and expire after eight hours. A reported setup issue stays visible in the invitation. See [Council host setup](docs/alignment.md) for configuring and refreshing a specific agent.

**Debate** also shows saved Council and review proposals, replies, and submitted ballots in chronological order. The view labels terminal captures and drafts and links to the formal review. **Reviews** shows submitted direct ballots as they arrive and displays the saved tally and verdict when available.

### Open or respond to a poll from an agent

Use `council_poll_create`, `council_poll_read`, and `council_poll_vote` through MCP. Pass the same absolute `project` path for all three. To use the bundled poll CLI, run the installed `runtime/council.mjs` by absolute path from the target project directory. The repository CLI accepts the same commands.

```powershell
node C:/path/to/council-herdr/bin/council.js poll list
node C:/path/to/council-herdr/bin/council.js poll create --mode mixed --question "What should we review?" --option "Parser" --option "API"
node C:/path/to/council-herdr/bin/council.js poll show <poll-id>
node C:/path/to/council-herdr/bin/council.js poll vote <poll-id> --option option-1 --note "The diff identifies the exact revision"
node C:/path/to/council-herdr/bin/council.js poll help
```

Use `--answer "…"` for a free response when enabled. The CLI uses `HC_TERMINAL_ID` when available. Supply `--voter` (or MCP `voter`) for a stable ID when the process starts outside that terminal. Each ID can update its response until close. Advisory IDs are local labels. A read-only agent can return its recommendation in its current conversation.

Use `poll track <poll-id> --voter <id> --label "Reviewer"` and `poll untrack <poll-id> --voter <id>` to manage the roster from the CLI while a poll is open.

### Data and permissions

The panel reads Council records under `.agent_workspace/` in the local projects in scope. Poll actions write advisory events under `.agent_workspace/.polls/` in the poll's original project. Poll writes use hard links to publish complete records when multiple agents submit concurrently. The project filesystem must support hard links. The panel uses the local clipboard for invitations and handoffs.

## Available workflows

| Mode | Behavior |
| --- | --- |
| `delegate` | One specialist receives a bounded task. Use `start`, `status` and `result` to follow it through a saved session. `delegate` is the blocking equivalent. |
| `council` | An author produces a proposal; a skeptic and simplifier receive that exact proposal and its SHA-256 digest. |
| `review` | An author produces a proposal; a reviewer and simplifier inspect it before the voting tally. |
| `debate` | Two agents make independent cases. A third compares the saved arguments and gives an advisory recommendation. |
| `parallel` | Agents work on independent assignments. Supply `subtasks` to give each one a different brief. |
| `pipeline` | Stages run in order. Each receives the previous stage’s saved capture and digest. |

Use `convene --mode debate|parallel|pipeline` or the corresponding `mode` in `council_convene`. Pass `--subtasks` or `--stages` as a JSON array on the CLI. A stage requires `name` and accepts `task`, `agent`, and `role`. The report and execution record are saved under `validation/`. Use `start` for background execution.

## Background runs, schedules, and voting rounds

Use `start --mode <mode>` or `council_start` for any of the six workflows. Use the same project and job ID with `status` and `result`. For a formal workflow, the result links to a separate workflow session holding its proposal and ballots.

- **Schedules.** Use `council schedule create --id weekly-review --at 2030-01-07T09:00:00Z --every 604800 --mode review --task "Review recent changes"`. Omit `--every` for a one-time run, or set `--count` to limit a recurrence. Use `schedule list`, `schedule status <id>`, and `schedule cancel <id>` to manage future runs. MCP uses `council_schedule_create` and `council_schedules`. A scheduler that wakes late starts one occurrence and skips intervening slots.
- **Late ballots.** After the participant turns finish, CLI and MCP ballot submissions refresh the saved tally against the original digest. Use `council retally --session <id>` or `council_retally` to refresh manually. Prior reports remain in the session’s validation history.
- **New rounds.** Use `council round --session <id>` or `council_round` to start a linked background review with the previous proposal and digest in its brief. Each round collects its own direct ballots.

## Run it

Requirements: Node.js 20 or newer, `hc` on the parent process's PATH, and a selected agent CLI with working authentication. There are no production npm dependencies. Live checks here used Windows, Node.js 24.14.1 and `hc 0.1.21`; those checks do not verify other environments.

Run the CLI from the project directory the agents should inspect. Pass that directory's absolute path as `project` for MCP workflows, including status and result. A server configured to start in that project can use its working directory as the default. Check for `council_alignment` and the tools your workflow needs. Use the current CLI by absolute path if connected tools are missing or the server cannot select the project.

Read `hc --skill` before delegating inside Herdr. Run `node C:/path/to/council-herdr/bin/council.js doctor` to check executable availability, then verify authentication and integration readiness for the hosts you intend to use.

## Delegate in an existing Herdr terminal

Use `hc ls` and `hc get <address>` to choose a live, aligned agent in the intended context whose state is `idle` or `done`. Replace `t123` with its address and run these commands from the project directory.

```powershell
node C:/path/to/council-herdr/bin/council.js alignment status t123
node C:/path/to/council-herdr/bin/council.js start --adopt t123 --session parser-review --task "Inspect src/parser.js and report input edge cases with file and line references. Keep the work read-only." --timeout 180
node C:/path/to/council-herdr/bin/council.js status --session parser-review
node C:/path/to/council-herdr/bin/council.js result --session parser-review
```

If the terminal needs alignment, use `alignment check t123` and confirm it reports `aligned` before starting the task. If `start` requests a readiness check, it reports the notice's delivery status and what to do next. After preflight succeeds, `start` returns a session ID while a worker runs the task in Herdr. Check progress with `status`, inspect the terminal with `hc read t123`, and retrieve its saved output with `result`. A pending result has `ready: false`. The MCP equivalents are `council_start`, `council_session_status` and `council_result`.

For a new agent, replace `--adopt t123` with `--agent codex` or another configured host. Council gives the new agent an alignment turn before sending the assignment. If it fails that check, inspect the reported terminal before launching again.

Open **Delegations** in the Council panel to follow those same sessions in the active project. Filter by **Active**, **Needs attention**, or **Ready**, see delivery and deadline separately from the outcome, and open the participant's terminal when it is visible in that space. The result card shows saved terminal output and can copy an excerpt or the capture file path. The panel reads records without resending tasks.

Repeat the same `start` with the same session ID and task options from the same directory to reconnect. For an adopted terminal, Council reports the app observed by Herdr and sets `participant.permission` to `null`. The host controls the terminal's permissions and lifetime. Put any limits on edits or delegation in the task brief.

For a long CLI assignment, pass `--task-file <path>` with a UTF-8 brief in place of `--task`. Council saves the task text in the session, so edits to the source file do not change a job already underway. With MCP, pass the brief in `task`. Large prompts for existing terminals go through Herdr's stdin API to avoid command-line length limits.

Set `--timeout <seconds>` to cover the entire job, including worker startup and capture. The default is 180 seconds. For a longer bounded review, for example, use `--timeout 600` when starting the job.

When an acknowledged delegation pauses for input, `status` and `result` show `outcome: awaiting_input`, and Desktop shows **Waiting for input** with the remaining time. Resolve the prompt in the participant's Herdr terminal. Council follows that turn through completion and saves the result within the original deadline. This also works with repeated prompts. If the deadline expires or Council cannot verify the resumed turn, inspect the existing terminal with `hc get` and `hc read` for the agent's answer.

The `outcome` field and Desktop also distinguish `timed_out`, `blocked`, and `uncertain` jobs. A timed-out job may leave its agent working. A new job after uncertain delivery requires an explicit start after the original deadline and a fresh readiness check. If a worker stopped abruptly, inspect its retained claim before attempting recovery.

`status`, `result`, and the selected Desktop delegation show when Herdr confirms that a claimed worker stopped before saving a result. Inspect the recorded participant for the original task and its answer. When Herdr cannot verify the worker, its status is unavailable and Council keeps the saved delivery state.

### Convene a formal panel

Use `council_convene` or the blocking CLI when the task calls for a formal author and review panel. Specify the agent hosts that are configured for the target project. Use `--permission write` only for an authorized editing task. This example selects Claude, Codex and Junie. Replace those hosts with the ones you have verified.

```powershell
hc run --bg --name parser-panel --cwd C:/path/to/project -- node C:/path/to/council-herdr/bin/council.js convene --mode review --agents claude,codex,junie --task "Review the parser proposal" --permission read
hc wait parser-panel
hc read parser-panel
```

For `convene`, `--timeout` sets the per-turn budget and `--keep` retains completed owned terminals for inspection.

## Results and approvals

Sessions live under `.agent_workspace/<session-id>/` in the target project. Inputs, briefs, proposals, reviews, direct ballots and validation records are separate artifacts. Reviewers receive the author's proposal before starting.

- Only valid **direct ballots**, bound to the session, expected voter, round and exact proposal digest, contribute to authorizing quorum. The participant's turn must complete successfully.
- Screen output and vote markers are informational. A quoted vote cannot authorize approval on somebody else's behalf. Insufficient direct ballots leave the result provisional and unauthorized.
- Provisional reports, evidence and next actions belong under `validation/`. Approved reports are promoted to `reports/` only after validation.
- The tally and integrity checks are mechanical. An elected representative name is not an agent synthesis, signature or endorsement. SHA-256 verifies content consistency, not authorship.
- Blocked, timed out and incomplete participants are preserved for recovery. Managed terminals outlive a short-lived orchestrator. Cleanup targets completed, owned terminal addresses. Inspect a preserved terminal with `hc get <address>` and `hc read <address>` before steering it.

Read-only agents can return their final answer normally. A sandbox may lack `hc` or artifact-write access; it must not be weakened to submit a ballot. Screen evidence remains useful as a provisional report.

For an explicit vote, use the proposal digest supplied in the review brief:

```powershell
node C:/path/to/council-herdr/bin/council.js cast-ballot --session <session-id-or-path> --voter council-skeptic --role skeptic --agent codex --vote amend --score 7 --rationale "Add a bounded connection timeout" --amendments "Cap retries at three" --target-sha <proposal-sha256>
```

Submit from the same target project, or pass the explicit session directory. A ballot submitted after a completed formal turn refreshes that round’s tally. See [voting and validation](docs/voting-and-validation.md).

## MCP and host packaging

Start the stdio server with `node /absolute/path/to/council-herdr/bin/council.js mcp`. Pass an absolute `project` in project-scoped tool calls. When you configure the server to start in the target project directory, that directory can serve as the default.

Use `council_start`, `council_session_status` and `council_result` for asynchronous delegation. Blocking workflows use `council_convene` or `council_delegate`. Other tools include `council_cast_ballot`, `council_status`, `council_wait`, `council_read`, `council_send` and `council_dismiss`.

The repository includes host manifests/configuration examples for Claude Code, Codex and Antigravity, plus a reusable skill for Junie and other hosts. These files do not establish automatic discovery or live compatibility with every application. The verified live-agent check used Codex through Herdr; MCP protocol/error behavior is tested separately.

The Claude Code marketplace exposes `council@council`. Its MCP entry uses `${CLAUDE_PLUGIN_ROOT}` to find the bundled runner from outside the checkout. For Codex sessions outside a Council checkout, configure the stdio server with the absolute path to `bin/council.js` and the target project's working directory as described above.

## Verification

Run `npm test`, `node bin/council.js doctor`, and `herdr-app check herdr/mods/council`. The repository workflow runs the Node tests on Windows, macOS and Linux. Desktop visuals and the isolated gallery install were checked on Windows with Herdr Desktop 0.1.16. Screenshots use sample polls and terminal fixtures.

The independent suites cover proposal handoffs, direct ballots, provisional evidence, terminal ownership, delivery, reconnect and startup timing. Earlier live checks used terminal fixtures for asynchronous CLI and MCP reconnect. The reliability milestone also exercised a live read-only Codex task. [Owner acceptance](docs/owner-brief.md) · [Async delegation review](docs/next-increment-review.md) · [Reliability review](docs/independent-review.md)

## Gallery package

The `herdr/` directory contains the native mod, recipe, preview and optional shortcut snippet. To list a published build in Community, GitHub must serve that folder from a public repository with the `herdr-mod` topic. [Herdr Community Gallery instructions](https://herdr.dev/gallery/?type=mods)

[MIT License](LICENSE) · [Changelog](CHANGELOG.md)
