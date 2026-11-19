# Council

Council is a native decision panel for an active Herdr workspace. Ask the agents already working there a question, see their responses and reasoning, and copy the result as a handoff. A second tab shows formal Council reviews saved for that project.

![Council in Herdr Desktop showing vote totals and agent responses](preview.png)

## What you see

The 760×710 floating window follows Herdr's current theme. It uses the chrome color around the edges, surface cards, a three-bar mark in the accent color, and 14-pixel spacing around the header and content. The header shows Council, the current space, and Polls and Reviews. The body scrolls. Lists have a search field, and the poll list has All, Open, and Closed filters. A poll opens with its question and actions above a breakdown and a response list. At widths of 670 pixels or greater, the breakdown sits beside the responses. At smaller widths the cards stack. A recorded decision appears under the poll question. The Participants view shows live Herdr status in subdued colors and marks which addresses have responded.

## How it behaves

Open Council with Shift+F8 after merging the optional binding, or run the Herdr mod-open command. Drag the header to move the window. In Polls, create a poll with listed options, free responses, or both. Search by question or poll ID. Options can be added while the poll is open, and the same voter can revise a response. Closing freezes the options, responses and roster and can record the next step. Copy results or the decision to use in a handoff.

In Participants, track an agent, copy an invitation scoped to its voter ID, or open its terminal. Live terminal labels are Idle, Working, Done, and Needs you. They use Herdr's idle, working, done, and blocked colors. A missing live terminal shows Terminal unavailable. Response states are Pending, Responded, and No response after closing. The poll still counts responses from outside the roster. Reviews shows saved verdicts, formal quorum, invalid or missing ballots, and dissent.

## Built from

`mods/council/mod.json` registers a floating window with placement `none`. The GPUI view in `main.js` uses theme colors, native inputs, and a root size listener for responsive cards. `poll-view.js` renders the tally and roster. `poll-text.js` formats invitations and summaries. Herdr supplies the current folder from `spaces()`, the live roster from `agents()`, and navigation through `agent.focus`. Copy actions use the local clipboard and post a brief Herdr toast.

The window runs `runtime/council.mjs desktop <action>` through `herdr.exec` in the active local project directory and reads JSON from stdout. The Node helper reads Council session records and writes advisory events only under `.agent_workspace/.polls/`. The repository CLI and MCP import the same store. The bundled polling CLI also works when invoked directly from the target project directory:

```bash
node /path/to/herdr-app/mods/council/runtime/council.mjs poll help
```

For a manual installation, copy the complete `mods/council/` directory, including `runtime/`, into the Herdr app home's `mods/`. Merge `keys.json` if Shift+F8 is free. Open it with `herdr-app do mod.open --name council`. When installed from the repository, `node herdr/install.js --shortcut` copies the same files and records the Node executable.

## Watch out

- Use Herdr Desktop with Node.js 20 or newer. The bundled runtime works independently of the checkout. For a manual copy, Node must be on Herdr's PATH or named in the installed mod's optional `config.json` as `{"node":"/absolute/path/to/node"}`.
- The active space must be local. Refresh runs every five seconds. The project filesystem must support hard links. Linked storage directories are rejected.
- The mod uses the filesystem, local Node process, and clipboard. It uses no network and invites are pasted manually. Poll participation uses local voter IDs and project write access. A read-only agent can reply in its conversation. Formal reviews use Council's separate rules.
- The editor supports up to 20 options and 32 tracked agents. The installed mod identifier is `council`. If that name is occupied, preserve it and update the new folder name, the runtime path in `main.js), and the optional binding together.

## Done when

- `herdr-app check mods/council` passes and the manually copied bundle opens in a local space with Node on PATH.
- A mixed poll shows a listed vote and a free response from the CLI. A response saved in the panel appears in the CLI.
- Tracking an existing agent shows it as pending until a response arrives under its terminal address. Untracking keeps its response in the results.
- An added option appears in results. A closed poll shows its decision and refuses further changes.
- A saved provisional review is labeled provisional and its missing direct votes remain missing.
