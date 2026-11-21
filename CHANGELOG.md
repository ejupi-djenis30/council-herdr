# Changelog

## 3.3.0

- Add dedicated skills for single-agent delegation, formal review, and on-demand Team roles.
- Route explicit Council workflow and argument selections through the shared skill and Claude Code command.
- Preview and install all Council skills for a project, including Codex.

## 3.2.0

- Configure explicit project team roles, optional reporting lines and model selection in Desktop and the CLI.
- Call named team members through CLI or MCP. Save each completed handoff and stop the model process until the next explicit call.
- Show whether each formal ballot targets the recorded proposal in Reviews and Debate.
- Create linked polls from a debate and close discussions with a recorded decision, owner, and next step.

## 3.1.0

- Select which agents to invite when opening a Desktop poll or debate, with zero recipients selected by default.
- Persist invitation queues before dispatch and resume pending deliveries within the original deadline. Show uncertain sends for manual inspection.

## 3.0.0

- Require an agent to register its current Council skill through Council MCP before it receives a delegation, a review brief, or a poll or debate invitation. An agent can report missing setup, and Desktop shows which invitations are waiting for alignment.
- Discover agent-created polls and formal reviews from projects in the active Herdr space. Open the Debate tab to follow a conversation, reply in a group-chat view, and see proposals and ballots from formal Council sessions.
- Invite active agents in the space automatically when you create a poll or debate in Desktop. Withheld invitations can go out after an agent registers within the delivery window.
- Preview and install project-scoped Council skill and MCP settings for Claude Code, Junie, and OpenCode with `council alignment setup`.

Upgrade the Council skill and plugin or MCP connection on existing agents, then reload those integrations and request alignment. See the [host setup guide](https://github.com/ejupi-djenis30/council-herdr/blob/v3.0.0/docs/alignment.md).

## 2.0.1

- Distinguish expired deadlines, blocked agents, and uncertain delivery in the CLI, MCP, and Herdr Desktop. Show how to inspect the existing terminal and delivery record.
- Keep waiting for a borrowed agent when a Herdr message interrupts the wait, within the original deadline.
- Resolve borrowed terminal names to their canonical address for delivery and completion checks.
- Record the app reported by Herdr for borrowed terminals and show it with saved delegations.
- Reject completion records without an acknowledged delivery in the CLI and MCP, matching Desktop.

## 2.0.0

- Add a native Council sidebar menu, an original mark, and consistent icons for navigation, vote results, and collaboration actions.
- Follow async delegation delivery, deadlines, errors, and terminal captures in a native Delegations tab.
- Ship Council as a self-contained Herdr Desktop mod with a gallery recipe and native screenshots.
- Add polls with listed options or free responses, agent participation tracking, and a copyable decision handoff.
- Show saved formal review verdicts alongside advisory poll results.
- Bundle the poll runtime with the installed mod and share its storage with the repository CLI and MCP server.
- Add managed updates with archived builds, installation regression tests, and a cross-platform Node test workflow.
