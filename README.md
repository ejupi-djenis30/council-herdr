# Council for Herdr

<img src="herdr/mods/council/icons/logo.svg" width="48" height="48" alt="" align="right">

Run a poll with the agents already in your workspace. See their votes and reasoning, record the decision, and give the next agent a handoff. Open **Council** in the Herdr sidebar to jump to polls, delegations, or formal reviews.

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

Open a local space and select **Council** under the Herdr logo. The menu opens **Polls**, **Delegations**, or **Reviews** directly. The optional **Shift+F8** binding and `herdr-app do mod.open --name council` also open Council.

- **Choose a layout.** The installer adds the menu to the active personal layout and archives the old file. For a layout shipped with Herdr, select the new `council-<name>` layout in Herdr using the name printed by the installer. Use `--menu --layout <name>` to target a different layout.
- **Update** a managed installation with `node herdr/install.js --upgrade --menu`. The old build is archived under the Herdr app home's `council-backups/`. An installation with local edits requires a manual backup before replacing it.
- **Install from the gallery bundle** by copying `herdr/mods/council/` into the app home's `mods/` directory. The installed mod works independently of the checkout and uses `node` from Herdr's environment. See the [recipe](herdr/RECIPE.md) for manual menu setup and configuration.
- **Use a custom app home** by passing `--app-home <path>` or setting `HERDR_APP_HOME`. To remove Council, remove the menu block and shortcut from your Herdr configuration before moving the mod out of `mods/`. Polls, delegations, and reviews live in their project folders.

## Run a poll

1. Select **New poll** and choose listed options, free responses, or both.
2. Open **Participants** to track agents in the active space. **Copy invite** contains instructions for the selected agent. Paste it into their conversation.
3. Follow live responses in **Results**. You can add options while the poll is open, see replies from agents outside the roster, and jump to a live terminal from the participant list.
4. Close the poll with an optional next step. **Copy decision** captures the tally, reasons, and missing responses for the next person or agent.

Use the search field and open or closed filters to find earlier polls. The **Reviews** tab projects saved formal Council verdicts, quorum, missing or invalid ballots, and dissent. Advisory polls are separate from the formal approval workflow.

### Respond from an agent

With Council MCP configured for the same project, use `council_poll_read` and `council_poll_vote`. To use the [bundled poll CLI](herdr/RECIPE.md#built-from), run the installed `runtime/council.mjs` by absolute path from the target project directory. The repository CLI accepts the same commands:

```powershell
node C:/path/to/council-herdr/bin/council.js poll list
node C:/path/to/council-herdr/bin/council.js poll show <poll-id>
node C:/path/to/council-herdr/bin/council.js poll vote <poll-id> --option option-1 --note "The diff identifies the exact revision"
node C:/path/to/council-herdr/bin/council.js poll help
```

Use `--answer "…"` for a free response when enabled. The CLI uses `HC_TERMINAL_ID` when available. Supply `--voter` (or MCP `voter`) for a stable ID when the process starts outside that terminal. Each ID can update its response until close. Advisory IDs are local labels. A read-only agent can return its recommendation in its current conversation.

Use `poll track <poll-id> --voter <id> --label "Reviewer"` and `poll untrack <poll-id> --voter <id>` to manage the roster from the CLI while a poll is open.

### Data and permissions

The panel runs the bundled Node helper from the local Herdr space's folder. It reads Council records under `.agent_workspace/` and writes advisory events under `.agent_workspace/.polls/`. Poll writes use hard links to publish complete records when multiple agents submit concurrently. The project filesystem must support hard links. The panel uses no network services. Invites and handoffs use the local clipboard.

## Available workflows

| Mode | Behavior |
| --- | --- |
| `delegate` | One specialist receives a bounded task. Run it synchronously with `delegate` or inspect it while it runs with `start`, `status` and `result`. |
| `council` | An author produces a proposal; a skeptic and simplifier receive that exact proposal and its SHA-256 digest. |
| `review` | An author produces a proposal; a reviewer and simplifier inspect it before the voting tally. |

`debate`, `parallel` and `pipeline` are experimental and disabled. Asynchronous jobs support one participant in `delegate` mode.

## Run it

Requirements: Node.js 20 or newer, `hc` on the parent process's PATH, and a selected agent CLI with working authentication. There are no production npm dependencies. Live checks here used Windows, Node.js 24.14.1 and `hc 0.1.21`; those checks do not verify other environments.

Run from the project directory the agents should inspect. Replace the executable path with the absolute path to this checkout:

```powershell
node C:/path/to/council-herdr/bin/council.js doctor
node C:/path/to/council-herdr/bin/council.js delegate --agent codex --task "Inspect src/parser.js and report concrete edge cases" --permission read
node C:/path/to/council-herdr/bin/council.js convene --mode review --task "Review the parser proposal" --permission read
```

Inside Herdr, read `hc --skill` and run long commands in named background terminals:

```powershell
hc run --bg --name parser-review --cwd C:/path/to/project -- node C:/path/to/council-herdr/bin/council.js convene --mode review --task "Review the parser proposal"
hc wait parser-review
hc read parser-review
```

`doctor` checks executable availability, not authentication or every host integration. Default agents are Claude, Codex and Antigravity; `--agents codex,junie,antigravity` selects another panel. Use `--permission write` only for an authorized editing task. `--timeout` is the turn budget in seconds; `--keep` retains completed participants for inspection.

## Delegate in an existing Herdr terminal

Pick a ready agent from `hc ls` and replace `t123` with its address. Run these commands from the project directory.

```powershell
node C:/path/to/council-herdr/bin/council.js start --mode delegate --adopt t123 --session parser-review --task "Inspect src/parser.js and report concrete edge cases" --timeout 180
node C:/path/to/council-herdr/bin/council.js status --session parser-review
node C:/path/to/council-herdr/bin/council.js result --session parser-review
```

`start` returns a session ID while a worker runs the task in Herdr. Check progress with `status`, inspect the terminal with `hc read t123`, and retrieve its saved output with `result`. A pending result has `ready: false`. To launch a new agent for the job, replace `--adopt t123` with `--agent codex`.

Open **Delegations** in the Council panel to follow those same sessions in the active project. Filter by **Active**, **Needs attention**, or **Ready**, see delivery and deadline separately from the outcome, and open the participant's terminal when it is visible in that space. The result card shows saved terminal output and can copy an excerpt or the capture file path. The panel reads records without resending tasks.

Repeat the same `start` with the same session ID and task options from the same directory to reconnect. An adopted terminal keeps its permissions and stays available in Herdr. Council leaves its lifetime and settings under its original owner's control.

Set `--timeout <seconds>` to cover the entire job, including worker startup and capture. The default is 180 seconds. For a longer bounded review, for example, use `--timeout 600` when starting the job.

The CLI and MCP `status` and `result` responses distinguish `timed_out`, `blocked`, and `uncertain` in the `outcome` field. The Desktop Delegations tab shows the same outcomes and recovery guidance. A timed-out job may leave its agent working. Inspect the participant and worker addresses from `status` with `hc get` and `hc read` before starting another job. A new job after uncertain delivery requires an explicit start after the original deadline and a fresh readiness check. If a worker stopped abruptly, inspect its retained claim before attempting recovery.

For an adopted terminal, `participant.reportedApp` records the app Herdr reported at adoption when available. Use that field to identify the app for a borrowed job. `participant.agent` records the launch-agent setting.

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

Submit from the same target project, or pass the explicit session directory. A ballot written after a workflow returns does not automatically rerun or promote it. See [voting and validation](docs/voting-and-validation.md).

## MCP and host packaging

Start the stdio server with `node /absolute/path/to/council-herdr/bin/council.js mcp`. Configure the host to launch it in the intended project directory; the server's working directory determines the target project and session location.

Use `council_start`, `council_session_status` and `council_result` for asynchronous delegation. Blocking workflows use `council_convene` or `council_delegate`. Other tools include `council_cast_ballot`, `council_status`, `council_wait`, `council_read`, `council_send` and `council_dismiss`.

The repository includes host manifests/configuration examples for Claude Code, Codex and Antigravity, plus a reusable skill for Junie and other hosts. These files do not establish automatic discovery or live compatibility with every application. The verified live-agent check used Codex through Herdr; MCP protocol/error behavior is tested separately.

The Claude Code marketplace exposes `council@council`. Its MCP entry uses `${CLAUDE_PLUGIN_ROOT}` to find the bundled runner from outside the checkout. For Codex sessions outside a Council checkout, configure the stdio server with the absolute path to `bin/council.js` and the target project's working directory as described above.

## Verification

Run `npm test`, `node bin/council.js doctor`, and `herdr-app check herdr/mods/council`. The repository workflow runs the Node tests on Windows, macOS and Linux. Desktop visuals and the isolated gallery install were checked on Windows with Herdr Desktop 0.1.16. Screenshots use sample polls and terminal fixtures.

The independent suites cover proposal handoffs, direct ballots, provisional evidence, terminal ownership, delivery, reconnect and startup timing. Earlier live checks used terminal fixtures for asynchronous CLI and MCP reconnect. The reliability milestone also exercised a live read-only Codex task. [Owner acceptance](docs/owner-brief.md) · [Async delegation review](docs/next-increment-review.md) · [Reliability review](docs/independent-review.md)

## Gallery package

The `herdr/` directory contains the native mod, recipe, preview and optional shortcut snippet. To list a published build in Community, GitHub must serve that folder from a public repository with the `herdr-mod` topic. [Herdr Community Gallery instructions](https://herdr.dev/gallery/?type=mods)

[MIT License](LICENSE) · [Changelog](CHANGELOG.md)
