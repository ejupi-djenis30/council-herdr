#!/usr/bin/env node
import { HerdrClient } from '../lib/herdr.js';
import { CouncilOrchestrator } from '../lib/modes.js';
import { CouncilMcpServer } from '../lib/mcp-server.js';
import { JobManager } from '../lib/jobs.js';
import { runPollCommand } from '../herdr/mods/council/runtime/poll-command.mjs';

function printHelp() {
  console.log(`
Council CLI - Herdr-native Multi-Agent Collaboration Engine (v2.0.1)

USAGE:
  council <command> [options]

COMMANDS:
  mcp                           Start Council MCP stdio server for AI agent hosts
  doctor                        Check environment health (Herdr, hc, agent CLIs)
  status [--session <id>]        List live terminals or inspect an async job
  start [options]                Start one asynchronous delegate job
  result --session <id>          Read the saved result or pending state
  convene [options]             Run a multi-agent collaboration workflow
  delegate [options]            Delegate a single subtask to an agent in Herdr
  wait <target>                 Wait for a terminal turn to finish (or 'all')
  read <target> [--lines <n>]   Read screen history from a terminal
  send <target> <message>       Send input/instruction to a terminal
  dismiss <targets...>          Kill and remove terminal(s) from Herdr
  cast-ballot [options]         Cast a formal voting ballot (council.ballot/v1)
  poll help                     Manage advisory project polls and submit responses

CONVENE OPTIONS:
  --mode <name>                 Mode: council (default), review, delegate
                                debate, parallel, pipeline are experimental and disabled
  --task <string>               The task or question to deliberate on
  --context <string>            Background context or file content
  --criteria <string>           Acceptance or decision criteria
  --agents <a,b,c>              Comma-separated agent names (default: claude,codex,antigravity)
  --permission <read|write>     File permissions: read (default, plan mode) or write
  --timeout <sec>               Timeout in seconds per agent turn (default: 180)
  --keep                        Keep Herdr terminals open after completion

CAST-BALLOT OPTIONS:
  --session <id>                Session ID or directory in .agent_workspace/
  --voter <name>                Voter identifier (e.g. council-skeptic)
  --vote <approve|reject|amend> Ballot vote decision (default: approve)
  --score <1-10>                Score between 1 and 10 (default: 8)
  --rationale <text>            Explanation or risk justification for the vote
  --role <role>                 Role: author, reviewer, skeptic, simplifier, judge (default: reviewer)
  --agent <agent>               Agent CLI: claude, codex, antigravity, junie (default: codex)
  --round <n>                   Voting round number (default: 1)
  --amendments <a,b...>         Comma-separated requested amendments
  --target-sha <sha256>         Target artifact SHA-256 digest being voted on

DELEGATE OPTIONS:
  --agent <name>                Target agent: claude, codex, antigravity, junie
  --task <string>               Instruction for the agent
  --permission <read|write>     File permissions (default: read)

ASYNC START OPTIONS:
  --task <string>               Instruction for the agent
  --mode delegate               Workflow mode (default: delegate)
  --agent <name>                Agent for a new terminal (default: codex)
  --adopt <address>              Use a ready existing Herdr terminal
  --session <id>                Use a stable ID to reconnect with the same options
  --timeout <sec>               Job deadline in seconds (default: 180)
  --permission <read|write>     New agent permissions (default: read)
  --keep                        Retain a newly launched terminal after completion

EXAMPLES:
  council doctor
  council convene --mode council --task "Design a resilient telemetry pipeline"
  council convene --mode review --task "Review src/auth.js" --permission read
  council delegate --agent codex --task "Write unit tests for parser"
  council start --adopt t123 --session parser-review --task "Inspect parser edge cases"
  council result --session parser-review
  council cast-ballot --session council-123 --voter council-skeptic --vote amend --score 7 --rationale "Needs retry backoff"
  council mcp
`);
}

function parseArgs(args) {
  const parsed = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        parsed[key] = args[i + 1];
        i++;
      } else {
        parsed[key] = true;
      }
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0] || 'help';
  if (command.toLowerCase() === 'poll') {
    const result = runPollCommand(rawArgs.slice(1));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return;
  }
  const flags = parseArgs(rawArgs.slice(1));

  const herdr = new HerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr });
  const jobManager = new JobManager({ herdr, cwd: process.cwd() });

  switch (command.toLowerCase()) {
    case 'start': {
      const mode = flags.mode || 'delegate';
      const task = flags.task || flags._.join(' ');
      if (!task) {
        console.error('Error: --task is required for start.');
        process.exit(1);
      }
      const res = await jobManager.startJob({
        mode,
        task,
        agent: flags.agent || 'codex',
        adopt: flags.adopt || null,
        sessionId: flags.session || null,
        permission: flags.permission || 'read',
        timeoutSec: flags.timeout ? Number(flags.timeout) : 180,
        keepTerminals: Boolean(flags.keep)
      });
      if (!res.success) {
        console.error(`Start failed: ${res.error}`);
        process.exit(1);
      }
      console.log(JSON.stringify(res, null, 2));
      break;
    }

    case 'result': {
      const sessionId = flags.session || flags._[0];
      if (!sessionId) {
        console.error('Error: --session <id> is required for result.');
        process.exit(1);
      }
      const res = await jobManager.getResult(sessionId);
      console.log(JSON.stringify(res, null, 2));
      if (!res.success) {
        process.exit(1);
      }
      break;
    }

    case 'mcp': {
      const server = new CouncilMcpServer();
      server.start();
      break;
    }

    case 'doctor': {
      console.log('--- Council Environment Health Check ---');
      const doc = herdr.doctor();
      console.log(`Herdr Core CLI (hc): ${doc.herdrInstalled ? `Available (${doc.hcVersion})` : 'NOT FOUND (Install herdr-core)'}`);
      console.log(`Current Session:     ${doc.inHerdr ? `Inside Herdr terminal (${doc.terminalId})` : 'Outside Herdr (standalone)'}`);
      console.log('\nSupported Agent CLIs:');
      for (const [name, info] of Object.entries(doc.agents)) {
        console.log(`  - ${name.padEnd(12)}: ${info.available ? `Ready (${info.path})` : 'Not on PATH'}`);
      }
      break;
    }

    case 'status': {
      if (flags.session) {
        const res = await jobManager.getStatus(flags.session);
        if (!res.success) {
          console.error(`Status error: ${res.error}`);
          process.exit(1);
        }
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      const res = herdr.list();
      if (!res.success) {
        console.error(`Error querying Herdr: ${res.error}`);
        process.exit(1);
      }
      console.log('Active Herdr Terminals:');
      console.log(typeof res.terminals === 'string' ? res.terminals : JSON.stringify(res.terminals, null, 2));
      break;
    }

    case 'convene': {
      const task = flags.task || flags._.join(' ');
      if (!task) {
        console.error('Error: --task is required for convene.');
        process.exit(1);
      }
      const agents = flags.agents ? flags.agents.split(',').map(s => s.trim()) : ['claude', 'codex', 'antigravity'];
      const mode = flags.mode || 'council';
      const representative = flags.representative || null;
      const sessionId = flags.session || null;
      const permission = flags.permission || 'read';
      const timeoutSec = flags.timeout ? Number(flags.timeout) : 180;
      const keepTerminals = Boolean(flags.keep);

      console.log(`[Council] Convening in ${mode.toUpperCase()} mode with agents: ${agents.join(', ')}...`);
      const result = await orchestrator.runMode({
        mode,
        sessionId,
        representative,
        task,
        context: flags.context || '',
        criteria: flags.criteria || '',
        agents,
        permission,
        timeoutSec,
        keepTerminals,
        onProgress: ev => {
          if (ev.stage === 'workspace_initialized') console.log(`  -> Workspace: ${ev.sessionDir}`);
          if (ev.stage === 'launch') console.log(`  -> Spawning ${ev.name} (${ev.agent})...`);
          if (ev.stage === 'waiting_initial') console.log(`  -> Waiting for deliberations...`);
          if (ev.stage === 'voting_round') console.log(`  -> Formal voting round ${ev.round} in progress...`);
          if (ev.stage === 'representative_validation') console.log(`  -> Representative validation (${ev.representative})...`);
          if (ev.stage === 'cleanup') console.log(`  -> Cleaning up terminals...`);
        }
      });

      console.log('\n' + result.report);
      if (!result.success) {
        process.exit(1);
      }
      break;
    }

    case 'delegate': {
      const task = flags.task || flags._.join(' ');
      const agent = flags.agent || 'claude';
      if (!task) {
        console.error('Error: --task is required for delegate.');
        process.exit(1);
      }

      console.log(`[Council] Delegating to ${agent}...`);
      const result = await orchestrator.runDelegate({
        agent,
        task,
        context: flags.context || '',
        permission: flags.permission || 'read',
        timeoutSec: flags.timeout ? Number(flags.timeout) : 180,
        keepTerminals: Boolean(flags.keep)
      });

      if (!result.success) {
        console.error(`\nDelegation failed: ${result.error}`);
        process.exit(1);
      }

      console.log('\n--- Output from ' + agent + ' ---');
      console.log(result.output);
      break;
    }

    case 'wait': {
      const target = flags._[0] || 'all';
      console.log(`Waiting on ${target}...`);
      const res = target === 'all' ? herdr.waitAllChildren() : herdr.wait(target);
      if (res.success) {
        console.log('Turn completed.');
        if (res.output) console.log(res.output);
      } else {
        console.error(`Wait failed: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case 'read': {
      const target = flags._[0];
      if (!target) {
        console.error('Error: Terminal target name required.');
        process.exit(1);
      }
      const lines = flags.lines ? Number(flags.lines) : 100;
      const res = herdr.read(target, lines);
      if (res.success) {
        console.log(res.content);
      } else {
        console.error(`Read failed: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case 'send': {
      const target = flags._[0];
      const message = flags._.slice(1).join(' ') || flags.message;
      if (!target || !message) {
        console.error('Usage: council send <target> <message>');
        process.exit(1);
      }
      const res = herdr.send(target, message);
      if (res.success) {
        console.log(`Message delivered to ${target}.`);
      } else {
        console.error(`Send failed: ${res.error}`);
        process.exit(1);
      }
      break;
    }

    case 'dismiss': {
      const targets = flags._;
      if (targets.length === 0) {
        console.error('Usage: council dismiss <target1> [target2...]');
        process.exit(1);
      }
      for (const t of targets) {
        const res = herdr.dismiss(t);
        console.log(`Dismissed ${t}: ${res.success ? 'OK' : 'Failed'}`);
      }
      break;
    }

    case 'cast-ballot':
    case 'ballot': {
      const sessionId = flags.session || flags._[0];
      const voter = flags.voter || flags._[1];
      const vote = flags.vote || flags._[2] || 'approve';
      const score = flags.score !== undefined ? Number(flags.score) : 8;
      const rationale = flags.rationale || flags.reason || (flags._.length > 3 ? flags._.slice(3).join(' ') : '');
      const role = flags.role || 'reviewer';
      const agent = flags.agent || 'codex';
      const round = flags.round ? Number(flags.round) : 1;
      const amendments = flags.amendments ? flags.amendments.split(',').map(s => s.trim()) : [];
      const targetArtifactSha256 = flags['target-sha'] || flags.targetSha || '';

      if (!sessionId || !voter || !rationale) {
        console.error('Error: --session, --voter, and --rationale are required for cast-ballot.');
        console.error('Usage: council cast-ballot --session <id> --voter <name> --vote <approve|reject|amend> --score <1-10> --rationale "<text>"');
        process.exit(1);
      }

      const sDir = orchestrator.workspace.resolveSessionDir(sessionId);
      const res = orchestrator.workspace.castBallot(sDir, {
        round,
        voter,
        role,
        agent,
        vote,
        score,
        rationale,
        amendments,
        targetArtifactSha256
      });

      console.log(`Ballot recorded for ${voter} (round ${round}) at ${res.ballotPath}`);
      console.log(JSON.stringify(res.ballot, null, 2));
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
      break;
  }
}

main().catch(err => {
  console.error(`Fatal Council Error: ${err.message}`);
  process.exit(1);
});
