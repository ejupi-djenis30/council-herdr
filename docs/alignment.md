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

Call `council_status` from the agent host to see the version and tools its MCP server advertises. To check which tools the host actually exposes to the agent, pass those comma-separated tool names to `doctor --live-tools`. Add `--live-version` to compare the observed version as well. Doctor checks the entire Council tool list for that release and names every missing tool, including when the versions match. Check the host's enabled tools and reload its MCP connection after changing them.

For a stale configuration, update the runner path. For a skill mismatch, refresh the skill. A current setup without a terminal receipt needs an alignment check.

## Confirm readiness

1. Verify the target host lists `council_alignment` among its tools and can load the Council skill.
2. Request a check using `council alignment check <address>` from the coordinator. The check includes a short-lived challenge for MCP hosts running outside the terminal environment.
3. The target calls `council_alignment` following the installed skill. The running MCP server stamps a positive receipt with its own Council release. Council verifies that release, the skill revision, the terminal's live app and process, and the receipt's expiry before delivering work. The skill revision is an agent assertion about the instructions it loaded.
4. Run `council alignment status <address>`. An `aligned` receipt permits handoff. For `needs_reload`, reload the MCP connection in the agent running in that terminal, then request a fresh check there. This state includes receipts from older servers that omitted their version. An explicit decline shows `not_aligned`. A missing or expired receipt shows `unconfirmed`.

The invite worker waits for alignment before it sends a poll or debate invitation. When a borrowed delegation is held, start the job after readiness is registered. A newly launched specialist receives a setup check before Council sends the work brief.
