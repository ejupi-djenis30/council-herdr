# council-herdr

Council adds bounded delegation, proposal handoffs, independent review and durable results to Herdr. Herdr runs the visible, interactive terminals; Council organizes their work.

Asynchronous delegation passed local verification and independent review on implementation commit `4f35661`. The 146 tests include the 81 reliability tests accepted on `c31bc90`. Live Herdr checks covered CLI and MCP reconnect, worker lifetime, and repeated use of an existing terminal. [Acceptance and priorities](docs/owner-brief.md) · [Independent async delegation review](docs/next-increment-review.md)

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

Repeat the same `start` with the same session ID and task options from the same directory to reconnect. An adopted terminal keeps its permissions and stays available in Herdr. Council leaves its lifetime and settings under its original owner's control.

If delivery is uncertain, inspect the participant address and worker address from `status` with `hc get` and `hc read`. A new job on the same terminal requires an explicit start after the deadline and a fresh readiness check. If a worker stopped abruptly, inspect its retained claim before attempting recovery.

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

## Verification

Run `npm test`. The independent suites cover proposal handoffs, direct ballots, provisional evidence, terminal ownership, delivery, reconnect and startup timing. The async CLI and MCP smoke tests used a plain Node program in a real Herdr terminal. The earlier reliability milestone also exercised a live read-only Codex task. [Async delegation review](docs/next-increment-review.md) · [Reliability review](docs/independent-review.md)

MIT - Ejupi-Labs.
