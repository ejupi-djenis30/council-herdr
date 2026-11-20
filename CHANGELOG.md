# Changelog

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
