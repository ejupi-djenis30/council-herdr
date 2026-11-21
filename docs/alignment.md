# Council host setup

Install the Council skills from `skills/` and connect the agent to the matching Council MCP server. Use the host's project scope when available. Start Herdr agents in the intended project and use Node.js 20 or newer.

## Configure a project

The installer previews project-scoped files for Codex, Claude Code, Junie and OpenCode. Apply the preview to install the skills in the target project.

```powershell
node C:/path/to/council-herdr/bin/council.js alignment setup --host opencode --project C:/path/to/project
node C:/path/to/council-herdr/bin/council.js alignment setup --host opencode --project C:/path/to/project --apply
```

Use `--host claude` or `--host junie` for those agents. The installer merges the Council server with existing JSON settings. A commented JSONC file needs a host-native merge using the preview. Use `--replace` after reviewing existing Council entries that need refreshing. [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Junie MCP setup](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html) · [OpenCode MCP setup](https://opencode.ai/docs/mcp-servers)

For Codex, use `--host codex` to install all four skills into the project's `.agents/skills/`. The preview prints the Council MCP command, arguments and project working directory. Add that entry to the host's MCP configuration or use an existing Council plugin connection for the same project. Codex setup writes skill files only. Start a fresh session in the target project and select `$council-delegate`, `$council-review`, `$council-team` or the general `$council` skill. When the picker shows a prefix from the Council plugin manifest, select the prefixed skill, such as `$council:council-delegate`. [Codex MCP](https://developers.openai.com/codex/mcp) · [Codex skills](https://developers.openai.com/codex/skills)

For another host, install the Council plugin or copy the four skill folders into the host's skill directory. Configure a local stdio server using the absolute Council entry path and arguments `["<Council checkout>/bin/council.js", "mcp"]`. Set its working directory to the target project.

## Confirm readiness

1. Verify the target host lists `council_alignment` among its tools and can load the Council skill.
2. Request a check using `council alignment check <address>` from the coordinator. The check includes a short-lived challenge for MCP hosts running outside the terminal environment.
3. The target calls `council_alignment` following the installed skill. `council alignment status <address>` shows `aligned`, `not_aligned`, or `unconfirmed`. Council associates the receipt with the terminal's live app and process, and with the current skill revision. The skill revision is an agent assertion about the instructions it loaded.

The invite worker waits for alignment before it sends a poll or debate invitation. When a borrowed delegation is held, start the job after readiness is registered. A newly launched specialist receives a setup check before Council sends the work brief.
