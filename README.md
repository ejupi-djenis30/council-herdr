# Council

Council adds bounded delegation, proposal handoffs, independent review and durable results to Herdr. Herdr runs the visible, interactive terminals; Council organizes their work.

The reliability milestone passed local verification and independent review on commit `c31bc90`: 81/81 tests plus separate live Herdr/Codex evidence with its declared hash limits. See [acceptance and priorities](docs/owner-brief.md) and [the independent review](docs/independent-review.md).

## Available workflows

| Mode | Behavior |
| --- | --- |
| `delegate` | One specialist receives a bounded task; Council waits for its actual turn and collects the result. |
| `council` | An author produces a proposal; a skeptic and simplifier receive that exact proposal and its SHA-256 digest. |
| `review` | An author produces a proposal; a reviewer and simplifier inspect it before the voting tally. |

`debate`, `parallel` and `pipeline` are experimental and disabled. Council currently launches new participants. Reusing existing Herdr terminals and a nonblocking start/status/result API are the next priorities.

## Run it

Requirements: Node.js 20 or newer, `hc` on the parent process's PATH, and a selected agent CLI with working authentication. There are no production npm dependencies. Live checks here used Windows, Node.js 24.14.1 and `hc 0.1.21`; those checks do not verify other environments.

Run from the project directory the agents should inspect. Replace the executable path with the absolute path to this checkout:

```powershell
node C:/path/to/Council/bin/council.js doctor
node C:/path/to/Council/bin/council.js delegate --agent codex --task "Inspect src/parser.js and report concrete edge cases" --permission read
node C:/path/to/Council/bin/council.js convene --mode review --task "Review the parser proposal" --permission read
```

Inside Herdr, read `hc --skill` and run long commands in named background terminals:

```powershell
hc run --bg --name parser-review --cwd C:/path/to/project -- node C:/path/to/Council/bin/council.js convene --mode review --task "Review the parser proposal"
hc wait parser-review
hc read parser-review
```

`doctor` checks executable availability, not authentication or every host integration. Default agents are Claude, Codex and Antigravity; `--agents codex,junie,antigravity` selects another panel. Use `--permission write` only for an authorized editing task. `--timeout` is the turn budget in seconds; `--keep` retains completed participants for inspection.

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
node C:/path/to/Council/bin/council.js cast-ballot --session <session-id-or-path> --voter council-skeptic --role skeptic --agent codex --vote amend --score 7 --rationale "Add a bounded connection timeout" --amendments "Cap retries at three" --target-sha <proposal-sha256>
```

Submit from the same target project, or pass the explicit session directory. A ballot written after a workflow returns does not automatically rerun or promote it. See [voting and validation](docs/voting-and-validation.md).

## MCP and host packaging

Start the stdio server with `node /absolute/path/to/Council/bin/council.js mcp`. Configure the host to launch it in the intended project directory; the server's working directory determines the target project and session location.

Tools: `council_convene`, `council_delegate`, `council_cast_ballot`, `council_status`, `council_wait`, `council_read`, `council_send`, `council_dismiss`. Workflow calls wait for results; nonblocking sessions are not implemented yet. Herdr remains available for inspection and steering while a call runs.

The repository includes host manifests/configuration examples for Claude Code, Codex and Antigravity, plus a reusable skill for Junie and other hosts. These files do not establish automatic discovery or live compatibility with every application. The verified live-agent check used Codex through Herdr; MCP protocol/error behavior is tested separately.

## Verification

Run `npm test`. Independent regressions cover failed waits/reads, missing delivery and addresses, exact proposal handoffs, direct-only authorization, provisional evidence, owned cleanup and startup timing. Live Herdr checks and a bounded Codex read-only task are recorded in [the review](docs/independent-review.md); mocked tests are not live-agent proof.

MIT - Ejupi-Labs.
