import readline from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { HerdrClient } from './herdr.js';
import { CouncilOrchestrator, SUPPORTED_MODES } from './modes.js';
import { SUPPORTED_AGENTS } from './recipes.js';
import { JobManager } from './jobs.js';
import { reportProgress } from '../herdr/mods/council/runtime/activity.mjs';
import { alignmentOf, reportAlignment } from '../herdr/mods/council/runtime/alignment.mjs';
import { readDebate, replyToDebate } from '../herdr/mods/council/runtime/debate-room.mjs';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { PollStore } from '../herdr/mods/council/runtime/polls.mjs';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { callTeamMember } from './team.js';

function projectDirectory(project, defaultDirectory) {
  if (project !== undefined && (typeof project !== 'string' || !isAbsolute(project))) {
    throw new Error('Use an absolute local project path.');
  }
  return project ?? defaultDirectory;
}

/**
 * Lightweight, zero-dependency MCP stdio server implementing Model Context Protocol 2024-11-05.
 */
export class CouncilMcpServer {
  constructor(options = {}) {
    this.herdr = new HerdrClient(options);
    this.orchestrator = new CouncilOrchestrator({ herdr: this.herdr, cwd: options.cwd || process.cwd() });
    this.workspace = this.orchestrator.workspace;
    this.cwd = options.cwd || process.cwd();
    this.polls = new PollStore(this.cwd);
    this.jobManager = new JobManager({ herdr: this.herdr, workspace: this.workspace, cwd: this.cwd });
  }

  start() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async line => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        await this.handleMessage(message);
      } catch (err) {
        this.sendError(null, -32700, `Parse error: ${err.message}`);
      }
    });

    // Notify stderr that server is alive
    process.stderr.write('Council MCP Server running on stdio.\n');
  }

  send(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  sendResult(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id, code, message, data = null) {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data ? { data } : {}) }
    });
  }

  async handleMessage(msg) {
    const { id, method, params } = msg;

    // Handle notifications (no id)
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        // Client confirmed initialization
        return;
      }
      return;
    }

    switch (method) {
      case 'initialize':
        return this.sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          serverInfo: {
            name: 'council-herdr',
            version: '3.4.0'
          }
        });

      case 'tools/list':
        return this.sendResult(id, { tools: this.getToolsList() });

      case 'tools/call':
        return await this.handleToolCall(id, params);

      case 'resources/list':
        return this.sendResult(id, { resources: this.getResourcesList() });

      case 'resources/read':
        return this.handleResourceRead(id, params);

      case 'prompts/list':
        return this.sendResult(id, { prompts: this.getPromptsList() });

      case 'prompts/get':
        return this.handlePromptGet(id, params);

      default:
        return this.sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  getToolsList() {
    return [
      {
        name: 'council_alignment',
        description: 'Report your own Council setup from the current Herdr terminal, or query another terminal. For a readiness report, follow the installed Council skill and supply its revision.',
        inputSchema: {
          type: 'object', required: ['action'],
          properties: {
            action: { type: 'string', enum: ['report', 'status'] },
            state: { type: 'string', enum: ['aligned', 'not_aligned'] },
            revision: { type: 'string' },
            target: { type: 'string', description: 'Terminal for a status query or your own terminal when replying with a live challenge.' },
            challenge: { type: 'string', description: 'Challenge from the setup notice when your MCP server cannot see the Herdr terminal address.' }
          }
        }
      },
      {
        name: 'council_activity',
        description: 'Read the project workspace overview or inspect one delegation. Includes Council records, optional declared PLAN.md and observed local Git metadata.',
        inputSchema: {
          type: 'object', properties: {
            project: { type: 'string', description: 'Absolute local project path. Defaults to this workspace.' },
            sessionId: { type: 'string', description: 'Delegation session ID to inspect instead of listing workspace activity.' }
          }
        }
      },
      {
        name: 'council_report_progress',
        description: 'Attach a short reported update to an existing delegation. Leaves execution, results and approvals unchanged.',
        inputSchema: {
          type: 'object', properties: {
            project: { type: 'string', description: 'Absolute local project path. Defaults to this workspace.' },
            sessionId: { type: 'string', description: 'The delegation session you are reporting on.' },
            text: { type: 'string', description: 'Up to 1200 characters of progress, a blocker, or a handoff.', maxLength: 1200 },
            state: { type: 'string', enum: ['working', 'blocked', 'handoff'], default: 'working' },
            component: { type: 'string', description: 'Optional component ID from the project’s PLAN.md.' },
            requestId: { type: 'string', maxLength: 96, description: 'Optional stable key to repeat the same update safely.' }
          }, required: ['sessionId', 'text']
        }
      },
      {
        name: 'council_team_list',
        description: 'Read the project team, its explicit roles, reporting lines and last known process states.',
        inputSchema: {
          type: 'object', properties: { project: { type: 'string', description: 'Absolute local project path. Defaults to this workspace.' } }
        }
      },
      {
        name: 'council_team_call',
        description: 'Call a configured team role for a new bounded turn. The managed model exits after handing off its result. Use a fresh session ID for each new turn and reuse it only to reconnect. If you have delegated your remaining work, complete your own turn immediately.',
        inputSchema: {
          type: 'object',
          properties: {
            member: { type: 'string', description: 'Configured team member ID.' },
            task: { type: 'string', description: 'Actionable task and handoff context.' },
            sessionId: { type: 'string', description: 'Stable unique ID for this turn.' },
            timeoutSec: { type: 'number', description: 'Deadline budget in seconds, including any wait for a prior turn. Defaults to 180.' },
            project: { type: 'string', description: 'Absolute local project path. Defaults to this workspace.' }
          },
          required: ['member', 'task', 'sessionId']
        }
      },
      {
        name: 'council_start',
        description: 'Start an asynchronous single-task delegation job in Herdr and return durable session details immediately.',
        inputSchema: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'Task instruction for the delegate.' },
            mode: { type: 'string', enum: ['delegate'], default: 'delegate', description: 'Mode: delegate only.' },
            agent: { type: 'string', default: 'codex', description: 'Agent CLI: claude, codex, antigravity, junie.' },
            adopt: { type: 'string', description: 'Terminal address to adopt instead of spawning a new agent.' },
            sessionId: { type: 'string', description: 'Deterministic session ID under .agent_workspace/.' },
            permission: { type: 'string', enum: ['read', 'write'], default: 'read', description: 'Permission: read or write.' },
            timeoutSec: { type: 'number', default: 180, description: 'Timeout in seconds.' },
            keepTerminals: { type: 'boolean', default: false, description: 'Keep spawned terminals after completion.' }
          }
        }
      },
      {
        name: 'council_poll_create',
        description: 'Open an advisory poll visible in Council Desktop. Use the same local project for subsequent calls.',
        inputSchema: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string' },
            context: { type: 'string' },
            mode: { type: 'string', enum: ['choice', 'mixed', 'open'] },
            options: { type: 'array', items: { type: 'string' } },
            project: { type: 'string', description: 'Absolute path to the local Herdr project. Defaults to the MCP working directory.' }
          }
        }
      },
      {
        name: 'council_poll_read',
        description: 'List advisory polls in this project, or read one poll with options, responses and results.',
        inputSchema: {
          type: 'object',
          properties: {
            pollId: { type: 'string', description: 'Omit to list project polls.' },
            project: { type: 'string', description: 'Absolute path to the poll project.' }
          }
        }
      },
      {
        name: 'council_poll_vote',
        description: 'Record or update one advisory response under your voter ID. Use a listed option ID or a free response when the poll allows it.',
        inputSchema: {
          type: 'object',
          required: ['pollId'],
          properties: {
            pollId: { type: 'string' },
            project: { type: 'string', description: 'Absolute path to the poll project.' },
            voter: { type: 'string', description: 'Your Herdr terminal address or a stable ID. Defaults to HC_TERMINAL_ID when available.' },
            optionId: { type: 'string' },
            answer: { type: 'string' },
            note: { type: 'string', description: 'Optional rationale.' }
          },
          oneOf: [{ required: ['optionId'] }, { required: ['answer'] }]
        }
      },
      {
        name: 'council_debate_read',
        description: 'Read a Council Desktop debate topic and its conversation.',
        inputSchema: {
          type: 'object', required: ['debateId'],
          properties: { debateId: { type: 'string' }, project: { type: 'string', description: 'Absolute path from the debate invitation.' } }
        }
      },
      {
        name: 'council_debate_reply',
        description: 'Post a reply to a Council Desktop debate.',
        inputSchema: {
          type: 'object', required: ['debateId', 'text'],
          properties: {
            debateId: { type: 'string' }, text: { type: 'string' },
            project: { type: 'string', description: 'Absolute path from the debate invitation.' },
            author: { type: 'string', description: 'Your terminal address when HC_TERMINAL_ID is unavailable.' }
          }
        }
      },
      {
        name: 'council_session_status',
        description: 'Query non-blocking snapshot status of an asynchronous Council job.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', description: 'Session ID to inspect.' }
          }
        }
      },
      {
        name: 'council_result',
        description: 'Retrieve the final result and persisted deliverables of an asynchronous Council job without side effects.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', description: 'Session ID to retrieve result for.' }
          }
        }
      },
      {
        name: 'council_status',
        description: 'Check Herdr installation, hc version, available agent CLIs (Claude, Codex, Antigravity, Junie), and live terminals.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'council_cast_ballot',
        description: 'Cast a formal, direct voting ballot (council.ballot/v1) for an active Council session.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'voter', 'role', 'agent', 'vote', 'rationale'],
          properties: {
            sessionId: { type: 'string', description: 'Target session ID in .agent_workspace/' },
            round: { type: 'number', default: 1, description: 'Voting round number' },
            voter: { type: 'string', description: 'Voter identifier (e.g. council-skeptic)' },
            role: { type: 'string', description: 'Role of the voter (author, reviewer, skeptic, simplifier, judge)' },
            agent: { type: 'string', description: 'Agent CLI name (claude, codex, antigravity, junie)' },
            vote: { type: 'string', enum: ['approve', 'reject', 'amend'], description: 'Vote decision' },
            score: { type: 'number', minimum: 1, maximum: 10, default: 8, description: 'Numerical rating (1-10)' },
            rationale: { type: 'string', description: 'Justification for the vote' },
            amendments: { type: 'array', items: { type: 'string' }, description: 'Requested amendments (for amend vote)' },
            targetArtifactSha256: { type: 'string', description: 'Target artifact SHA-256 digest being voted on' }
          }
        }
      },
      {
        name: 'council_convene',
        description: 'Run a bounded council, review or delegation in Herdr and return collected evidence with its authorization state. Screen-only evidence remains provisional.',
        inputSchema: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'The task, problem, or decision for the council to address.' },
            mode: {
              type: 'string',
              enum: SUPPORTED_MODES,
              default: 'council',
              description: 'Supported: council (proposal, skeptic, simplifier), review (proposal and peer reviews), delegate (one specialist). Debate, parallel and pipeline are disabled experimental modes.'
            },
            context: { type: 'string', description: 'Relevant code, files, or background context for the council.' },
            criteria: { type: 'string', description: 'Decision constraints or acceptance criteria.' },
            representative: { type: 'string', description: 'Nominee recorded for the mechanical validation; this does not execute an agent synthesis or endorsement.' },
            sessionId: { type: 'string', description: 'Deterministic session ID under .agent_workspace/ (auto-generated if omitted).' },
            agents: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of agent CLIs to use (e.g. ["claude", "codex", "antigravity", "junie"]).'
            },
            permission: {
              type: 'string',
              enum: ['read', 'write'],
              default: 'read',
              description: 'Whether participants may edit workspace files or stay in plan/read-only mode.'
            },
            timeoutSec: { type: 'number', default: 180, description: 'Timeout in seconds per agent turn.' },
            keepTerminals: { type: 'boolean', default: false, description: 'Keep Herdr terminals open after completion for interactive inspection.' }
          }
        }
      },
      {
        name: 'council_delegate',
        description: 'Delegate a single subtask to a specific agent (Claude, Codex, Antigravity, Junie) running in a background Herdr terminal.',
        inputSchema: {
          type: 'object',
          required: ['agent', 'task'],
          properties: {
            agent: { type: 'string', description: 'Agent to delegate to (claude, codex, antigravity, junie).' },
            task: { type: 'string', description: 'Task instruction for the agent.' },
            permission: { type: 'string', enum: ['read', 'write'], default: 'read' },
            context: { type: 'string', description: 'Optional context.' },
            timeoutSec: { type: 'number', default: 180 },
            keepTerminals: { type: 'boolean', default: false }
          }
        }
      },
      {
        name: 'council_wait',
        description: 'Wait for a running Herdr terminal turn to complete (uses `hc wait`).',
        inputSchema: {
          type: 'object',
          required: ['target'],
          properties: {
            target: { type: 'string', description: 'Terminal name (e.g. "council-author") or "all" for all child terminals.' },
            timeoutSec: { type: 'number', default: 180 }
          }
        }
      },
      {
        name: 'council_read',
        description: 'Read the screen buffer and output history from a Herdr terminal (`hc read`).',
        inputSchema: {
          type: 'object',
          required: ['target'],
          properties: {
            target: { type: 'string', description: 'Terminal name or ID.' },
            lines: { type: 'number', default: 100, description: 'Number of lines of screen history to fetch.' }
          }
        }
      },
      {
        name: 'council_send',
        description: 'Send a message or directive to an active agent running in Herdr (`hc send`).',
        inputSchema: {
          type: 'object',
          required: ['target', 'message'],
          properties: {
            target: { type: 'string', description: 'Terminal name or ID.' },
            message: { type: 'string', description: 'Message or steering instruction.' }
          }
        }
      },
      {
        name: 'council_dismiss',
        description: 'Terminate and remove a council terminal in Herdr (`hc kill` + `hc rm`).',
        inputSchema: {
          type: 'object',
          required: ['target'],
          properties: {
            target: { type: 'string', description: 'Terminal name or ID to clean up.' }
          }
        }
      }
    ];
  }

  async handleToolCall(id, params) {
    const { name, arguments: args = {} } = params;

    try {
      switch (name) {
        case 'council_alignment': {
          let result;
          if (args.action === 'report') {
            result = reportAlignment(this.herdr, args, { viaMcp: true });
          } else if (args.action === 'status') {
            const target = args.target ?? this.herdr.terminalId;
            if (!target) throw new Error('A Herdr terminal address is required.');
            const terminal = this.herdr.get(target);
            if (!terminal.success) throw new Error(terminal.error);
            result = { address: terminal.details.address, state: alignmentOf(terminal.details) };
          } else throw new Error('Use report or status.');
          return this.sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
        }
        case 'council_activity':
        case 'council_report_progress': {
          const project = projectDirectory(args.project, this.cwd);
          const result = name === 'council_activity'
            ? desktopRequest(project, 'activity', { id: args.sessionId })
            : reportProgress(project, args, this.herdr.terminalId);
          if (name === 'council_activity' && args.sessionId != null && !result.delegation) throw new Error('Delegation not found in this project.');
          return this.sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }

        case 'council_team_list':
        case 'council_team_call': {
          const project = projectDirectory(args.project, this.cwd);
          const manager = args.project === undefined ? this.jobManager : new JobManager({ cwd: project });
          const result = name === 'council_team_list' ? new TeamStore(project).list() : await callTeamMember(manager, args);
          return this.sendResult(id, { isError: result.success === false, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }

        case 'council_start': {
          const res = await this.jobManager.startJob({
            mode: args.mode || 'delegate',
            task: args.task,
            agent: args.agent,
            adopt: args.adopt,
            sessionId: args.sessionId,
            permission: args.permission,
            timeoutSec: args.timeoutSec,
            keepTerminals: args.keepTerminals
          });
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: JSON.stringify(res, null, 2)
            }]
          });
        }

        case 'council_poll_create':
        case 'council_poll_read':
        case 'council_poll_vote': {
          const directory = projectDirectory(args.project, this.cwd);
          const store = directory === this.cwd ? this.polls : new PollStore(directory);
          let result;
          if (name === 'council_poll_create') result = store.create({ ...args, createdBy: process.env.HC_TERMINAL_ID });
          else if (name === 'council_poll_vote') result = store.vote(args.pollId, { ...args, voter: args.voter ?? process.env.HC_TERMINAL_ID });
          else result = args.pollId === undefined ? store.list() : store.show(args.pollId);
          return this.sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }

        case 'council_debate_read':
        case 'council_debate_reply': {
          const directory = projectDirectory(args.project, this.cwd);
          const result = name === 'council_debate_read' ? readDebate(directory, args.debateId)
            : replyToDebate(directory, args.debateId, { author: process.env.HC_TERMINAL_ID ?? args.author, body: args.text });
          return this.sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }

        case 'council_session_status': {
          const res = await this.jobManager.getStatus(args.sessionId);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: JSON.stringify(res, null, 2)
            }]
          });
        }

        case 'council_result': {
          const res = await this.jobManager.getResult(args.sessionId);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: JSON.stringify(res, null, 2)
            }]
          });
        }

        case 'council_status': {
          const doctor = this.herdr.doctor();
          const listRes = this.herdr.list();
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                environment: doctor,
                activeTerminals: listRes.success ? listRes.terminals : listRes.error
              }, null, 2)
            }]
          });
        }

        case 'council_cast_ballot': {
          const sDir = this.workspace.resolveSessionDir(args.sessionId);
          const res = this.workspace.castBallot(sDir, {
            round: args.round || 1,
            voter: args.voter,
            role: args.role,
            agent: args.agent,
            vote: args.vote,
            score: args.score || 8,
            rationale: args.rationale,
            amendments: args.amendments || [],
            targetArtifactSha256: args.targetArtifactSha256 || ''
          });
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                message: `Ballot recorded for ${args.voter} in round ${args.round || 1}.`,
                ballotPath: res.ballotPath,
                ballot: res.ballot
              }, null, 2)
            }]
          });
        }

        case 'council_convene': {
          const result = await this.orchestrator.runMode({
            mode: args.mode || 'council',
            sessionId: args.sessionId || null,
            representative: args.representative || null,
            task: args.task,
            context: args.context,
            criteria: args.criteria,
            agents: args.agents || ['claude', 'codex', 'antigravity'],
            permission: args.permission || 'read',
            timeoutSec: args.timeoutSec || 180,
            keepTerminals: Boolean(args.keepTerminals)
          });
          return this.sendResult(id, {
            isError: !result.success,
            content: [{
              type: 'text',
              text: result.report || JSON.stringify(result, null, 2)
            }]
          });
        }

        case 'council_delegate': {
          const result = await this.orchestrator.runDelegate({
            agent: args.agent,
            task: args.task,
            context: args.context,
            permission: args.permission || 'read',
            timeoutSec: args.timeoutSec || 180,
            keepTerminals: Boolean(args.keepTerminals)
          });
          return this.sendResult(id, {
            isError: !result.success,
            content: [{
              type: 'text',
              text: result.output || (result.error ? `Error: ${result.error}` : JSON.stringify(result, null, 2))
            }]
          });
        }

        case 'council_wait': {
          const res = args.target === 'all'
            ? this.herdr.waitAllChildren({ timeoutSec: args.timeoutSec })
            : this.herdr.wait(args.target, { timeoutSec: args.timeoutSec });
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: res.output || (res.success ? 'Wait completed successfully.' : `Wait failed: ${res.error}`)
            }]
          });
        }

        case 'council_read': {
          const res = this.herdr.read(args.target, args.lines || 100);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: res.content || (res.success ? '(Empty output)' : `Read failed: ${res.error}`)
            }]
          });
        }

        case 'council_send': {
          const res = this.herdr.send(args.target, args.message);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: res.success ? `Message sent to ${args.target}.` : `Send failed: ${res.error}`
            }]
          });
        }

        case 'council_dismiss': {
          const res = this.herdr.dismiss(args.target);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: res.success ? `Dismissed terminal ${args.target}.` : `Dismiss failed: ${res.killOutput || res.rmOutput || res.error || 'Unknown error'}`
            }]
          });
        }

        default:
          return this.sendError(id, -32601, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return this.sendResult(id, {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${err.message}` }]
      });
    }
  }

  getResourcesList() {
    return [
      {
        uri: 'council://status',
        name: 'Council Status & Herdr Health',
        mimeType: 'application/json'
      },
      {
        uri: 'council://modes',
        name: 'Collaboration Modes Reference',
        mimeType: 'text/markdown'
      },
      {
        uri: 'council://recipes',
        name: 'Agent Herdr Launch Recipes',
        mimeType: 'text/markdown'
      }
    ];
  }

  handleResourceRead(id, params) {
    const { uri } = params;
    switch (uri) {
      case 'council://status': {
        const doc = this.herdr.doctor();
        return this.sendResult(id, {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(doc, null, 2)
          }]
        });
      }
      case 'council://modes': {
        return this.sendResult(id, {
          contents: [{
            uri,
            mimeType: 'text/markdown',
            text: '# Council Modes\n- council: Author proposal, then skeptic and simplifier reviews.\n- review: Author proposal, then reviewer and simplifier reviews.\n- delegate: One bounded specialist task.\n\nDebate, parallel and pipeline are disabled experimental modes. Validation is mechanical; screen-only evidence is provisional, not an agent endorsement.'
          }]
        });
      }
      case 'council://recipes': {
        return this.sendResult(id, {
          contents: [{
            uri,
            mimeType: 'text/markdown',
            text: '# Agent Recipes under Herdr\n- Claude: `claude --permission-mode plan|acceptEdits`\n- Codex: `codex --no-daemon -s read-only|workspace-write -a never`\n- Antigravity: `agy --mode plan|accept-edits -i "<task>"`\n- Junie: `junie [--plan] --prompt=<task>`'
          }]
        });
      }
      default:
        return this.sendError(id, -32602, `Unknown resource URI: ${uri}`);
    }
  }

  getPromptsList() {
    return [
      {
        name: 'convene_council',
        description: 'Start a full multi-perspective council for an architecture or design decision.',
        arguments: [
          { name: 'task', description: 'The decision to deliberate on', required: true }
        ]
      },
      {
        name: 'code_review',
        description: 'Perform a rigorous multi-agent code review (author, reviewer, simplifier).',
        arguments: [
          { name: 'task', description: 'Code review objective or commit diff', required: true }
        ]
      }
    ];
  }

  handlePromptGet(id, params) {
    const { name, arguments: args = {} } = params;
    if (name === 'convene_council') {
      return this.sendResult(id, {
        description: 'Convene Council prompt',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Please convene a Council on: ${args.task}. Use the council_convene tool with mode="council".`
          }
        }]
      });
    }
    if (name === 'code_review') {
      return this.sendResult(id, {
        description: 'Code review prompt',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Please run a peer review on: ${args.task}. Use the council_convene tool with mode="review".`
          }
        }]
      });
    }
    return this.sendError(id, -32602, `Unknown prompt: ${name}`);
  }
}
