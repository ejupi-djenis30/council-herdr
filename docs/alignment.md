# Council host setup

Install the Council skills from `skills/` and connect the agent to the matching Council MCP server. Use the host's project scope when available. Start Herdr agents in the intended project and use Node.js 20 or newer.

In an existing Junie CLI conversation, open `/mcp` and select Council. For an active connection that still reports an earlier release, disable Council and enable it again. A failed or inactive connection offers **Reconnect**. Then request a new alignment check in the same Herdr terminal. [Junie MCP connection management](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html)

## Configure a project

The installer previews project-scoped files for Codex, Antigravity, Claude Code, Junie and OpenCode. Apply the preview to install the skills in the target project.

```powershell
node C:/path/to/council-herdr/bin/council.js alignment setup --host opencode --project C:/path/to/project
node C:/path/to/council-herdr/bin/council.js alignment setup --host opencode --project C:/path/to/project --apply
```

Use `--host antigravity`, `--host claude`, or `--host junie` for those agents. The installer merges the Council server with existing JSON settings and binds it to the project. A commented JSONC file needs a host-native merge using the preview. Use `--replace` after reviewing existing Council entries that need refreshing. [Antigravity MCP](https://antigravity.google/docs/ide-mcp) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Junie MCP setup](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html) · [OpenCode MCP setup](https://opencode.ai/docs/mcp-servers)

The Codex, Claude Code and Antigravity plugin manifests resolve the stdio runner from their installation. When an MCP connection has no default project, pass an absolute `project` for job, poll, debate, council, and review calls, and use the assigned absolute session directory for formal ballots. Reuse the same `project` with job status and result calls. For a manual stdio configuration, use the absolute entry path in `["<Council installation>/bin/council.js", "mcp"]` and set the environment variable `COUNCIL_MCP_PROJECT` to the absolute project path to bind the connection explicitly. Reload the host integration after changing its configuration. [Codex plugin working directory](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs#L1410-L1425) · [Antigravity plugin MCP](https://antigravity.google/docs/build-plugins/)

## Diagnose an upgrade

Use `council doctor --host opencode --project <absolute-project> --target <terminal> --json` to inspect the configured Council version, skill revision and fingerprint, and terminal receipt. Leave out `--target` to inspect files only. This command reads configuration without executing the configured runner.

Discover the Council tools exposed to the agent in its current session, including deferred tools. Pass the observed names as `hostTools` to `council_status`, or as a comma-separated list to `council doctor --live-tools`. Add `--live-version` to the CLI command to compare the observed server version as well. The status response shows the server's advertisement in `integration.liveServer.tools` and the host comparison in `integration.hostInventory`. With no inventory, tool exposure is `unverified`. An empty list means the host exposes zero tools. An incomplete list reports each missing name. Check the host's enabled tools and reload its MCP connection after changing them.

In Codex with `functions.exec`, use the Council names from `ALL_TOOLS`. OpenCode supports native names such as `council_council_status` and Code Mode names such as `tools.council.council_status`. Inspect the tool catalog available to the current agent. OpenCode's `/mcps` shows connection state. For a project-scoped OpenCode v2 configuration, doctor reads `mcp.servers.council` in JSON or JSONC and reports a disabled connection. Codex manages the project MCP connection separately from Council's project skill installer. [OpenCode MCP names and permissions](https://opencode.ai/docs/mcp-servers/#names)

For a stale configuration, update the runner path. For a skill mismatch, refresh the skill. A current setup without a terminal receipt needs an alignment check.

## Confirm readiness

1. Verify the target host can load the current Council skill and discover its Council tools.
2. Request a check using `council alignment check <address>` from the coordinator. The check includes a short-lived challenge for MCP hosts running outside the terminal environment.
3. The target sends the names discovered in that session to `council_status`. A matching server version and a complete host inventory allow it to report `aligned` using the same `hostTools` in `council_alignment`. The server checks every required name and stamps its own release on the receipt. A positive request with absent or incomplete evidence records `not_aligned`. The skill revision and observed tool inventory are assertions from the target agent. Council checks the release, revision, terminal identity and receipt expiry before delivering work.
4. Run `council alignment status <address>`. An `aligned` receipt permits handoff. For `needs_reload`, reload the MCP connection in the agent running in that terminal, then request a fresh check there. This state includes receipts from older servers that omitted their version. An explicit decline shows `not_aligned`. A missing or expired receipt shows `unconfirmed`.

The invite worker waits for alignment before it sends a poll or debate invitation. When a borrowed delegation is held, start the job after readiness is registered. A newly launched specialist receives a setup check before Council sends the work brief.
