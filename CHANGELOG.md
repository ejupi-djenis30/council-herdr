# Changelog

## 3.5.1

- Let agents open debate threads through CLI or MCP and display the creator and replies in Herdr Desktop.
- Show automated debate arguments and recommendations, synchronous workflow results, and incomplete runs.
- Surface runs and open decisions from projects in the current Herdr space, including work started from background terminals and subfolders. Keep pinned views scoped to their project.

## 3.5.0

- Enable structured debate, parallel assignments, and sequential pipelines in `convene`, with verified handoffs and saved advisory reports.
- Keep collecting an acknowledged delegation through Herdr input prompts. Show the pause and original deadline in Desktop, CLI, and MCP.
- Accept UTF-8 briefs with `start --task-file` and send large prompts to existing Herdr terminals over stdin.
- Require explicit formal votes and preserve existing ballots when a submission omits the decision.
- Verify and capture the exact delegated turn after its screen settles, within the original deadline.
- Launch bundled MCP from the plugin installation directory. Pass an absolute `project` to workspace tools when the connection has no default project. Use `doctor` to inspect versions, tools, and alignment.
- Lead with resumable delegation in the skill and include the assigned proposal digest in formal reviewer briefs.
- Show invitation deadlines and delivery outcomes in Desktop, add checks and retries for eligible targets, and improve keyboard navigation.
- Support background runs in all six modes, one-time and recurring schedules, linked voting rounds, and retallies for late direct ballots.
- Report stopped background workers while preserving the delivery record and terminal claims.

## 3.4.0

- Open a native Workspace view for active runs, decisions, declared plans, Team handoffs, and local Git changes.
- Record a delegation timeline and attach progress, blocker, and handoff notes from Desktop, CLI, or MCP.
- Read stable components and dependencies from PLAN.md and highlight observed Git paths beside their declared tasks.
- Keep Workspace scoped to the owning project when a terminal enters a subfolder, with exact folder pinning and a return path from run and decision details.
- Group plan components by dependency order, surface read issues, and make progress updates safe to retry.

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
