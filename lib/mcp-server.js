import readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { workItemOperation } from './work-items.js';
import { isAbsolute, join, resolve } from 'node:path';
import { HerdrClient } from './herdr.js';
import { CouncilOrchestrator } from './modes.js';
import { councilToolDefinitions } from './mcp-tool-definitions.js';
import { JobManager } from './jobs.js';
import { handleWorkflowRequest, publicJobOptions } from './workflow-tools.js';
import { resolveVotingSession, retallyAfterBallot } from './formal-rounds.js';
import { reportProgress } from '../herdr/mods/council/runtime/activity.mjs';
import { alignmentDetails, reportAlignment, skillRevision } from '../herdr/mods/council/runtime/alignment.mjs';
import { closeThread, inspectPoll, inspectThread, listThreads, openPoll, openThread, replyToThread } from '../herdr/mods/council/runtime/agent-discussion.mjs';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { PollStore } from '../herdr/mods/council/runtime/polls.mjs';
import { councilVersion, diagnoseCouncilHost, inspectHostTools } from './diagnostics.js';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { callTeamMember } from './team.js';

function projectDirectory(project, defaultDirectory) {
  if (project === undefined && defaultDirectory === undefined) throw new Error('Pass the absolute project path as project. This plugin connection has no default project.');
  if (project !== undefined && (typeof project !== 'string' || !isAbsolute(project))) {
    throw new Error('Use an absolute local project path.');
  }
  return resolve(project ?? defaultDirectory);
}

/**
 * Lightweight, zero-dependency MCP stdio server implementing Model Context Protocol 2024-11-05.
 */
export class CouncilMcpServer {
  constructor(options = {}) {
    const configuredProject = options.cwd || process.env.COUNCIL_MCP_PROJECT;
    const requireProject = options.requireProject ?? (!configuredProject && process.env.COUNCIL_MCP_REQUIRE_PROJECT === '1');
    this.cwd = resolve(configuredProject || process.cwd());
    this.defaultProject = requireProject ? undefined : this.cwd;
    this.herdr = new HerdrClient({ ...options, cwd: this.cwd });
    this.orchestrator = new CouncilOrchestrator({ herdr: this.herdr, cwd: this.cwd });
    this.workspace = this.orchestrator.workspace;
    this.polls = new PollStore(this.cwd);
    this.jobManager = new JobManager({ herdr: this.herdr, workspace: this.workspace, cwd: this.cwd });
  }

  workspaceContext(project) {
    const cwd = projectDirectory(project, this.defaultProject);
    if (cwd === this.cwd) return { project: cwd, orchestrator: this.orchestrator, jobManager: this.jobManager };
    const orchestrator = new CouncilOrchestrator({ herdr: this.herdr, cwd });
    return { project: cwd, orchestrator, jobManager: new JobManager({ herdr: this.herdr, workspace: orchestrator.workspace, cwd }) };
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
            version: councilVersion
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
    return councilToolDefinitions();
  }

  async handleToolCall(id, params) {
    const { name, arguments: args = {} } = params;

    try {
      if (name === 'council_cast_ballot' && !this.defaultProject && (typeof args.sessionId !== 'string' || !isAbsolute(args.sessionId))) {
        throw new Error('Use the absolute session directory from the Council assignment as sessionId. This plugin connection has no default project.');
      }
      switch (name) {
        case 'council_work_item_create':
        case 'council_work_item_list':
        case 'council_work_item_show':
        case 'council_work_item_delegate':
        case 'council_work_item_triage':
        case 'council_work_item_review':
        case 'council_work_item_close':
        case 'council_work_item_reopen':
        case 'council_work_item_history': {
          const operation=name.slice('council_work_item_'.length);
          let result;
          try {
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error('Work-item arguments must be an object.');
            }
            const { project: requestedProject, ...input } = args;
            const project = projectDirectory(requestedProject, this.defaultProject);
            let canonical;
            try { canonical = realpathSync.native(project); } catch { /* The coordinator reports storage errors. */ }
            const manager = canonical === this.jobManager.cwd ? this.jobManager
              : canonical ? new JobManager({ cwd: canonical, herdr: this.herdr }) : undefined;
            result=await workItemOperation(operation,input,{project,manager});
          } catch(e) { result={success:false,project:null,error:{code:'invalid_input',message:e.message}}; }
          return this.sendResult(id,{isError:!result.success,content:[{type:'text',text:JSON.stringify(result)}]});
        }
        case 'council_schedule_create':
        case 'council_schedules':
        case 'council_round':
        case 'council_retally': {
          const result = await handleWorkflowRequest(name, this.workspaceContext(args.project), args);
          return this.sendResult(id, { isError: result.success === false, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }
        case 'council_alignment': {
          let result;
          if (args.action === 'report') {
            const hostInventory = args.state === 'aligned' ? inspectHostTools(args.hostTools) : undefined;
            result = reportAlignment(this.herdr, args, { viaMcp: true, hostInventory });
          } else if (args.action === 'status') {
            const target = args.target ?? this.herdr.terminalId;
            if (!target) throw new Error('A Herdr terminal address is required.');
            const terminal = this.herdr.get(target);
            if (!terminal.success) throw new Error(terminal.error);
            result = { address: terminal.details.address, ...alignmentDetails(terminal.details) };
          } else throw new Error('Use report or status.');
          return this.sendResult(id, { isError: args.action === 'report' && args.state !== result.state,
            content: [{ type: 'text', text: JSON.stringify(result) }] });
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
          const { project, jobManager } = this.workspaceContext(args.project);
          const res = await jobManager.startJob({
            ...publicJobOptions(args), mode: args.mode || 'delegate'
          });
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: JSON.stringify({ ...res, project }, null, 2)
            }]
          });
        }

        case 'council_poll_create':
        case 'council_poll_read':
        case 'council_poll_manage':
        case 'council_poll_vote': {
          const directory = projectDirectory(args.project, this.defaultProject);
          const store = directory === this.cwd ? this.polls : new PollStore(directory);
          let result;
          if (name === 'council_poll_manage') {
            switch (args.action) {
              case 'add-option': result = store.addOption(args.pollId, args.label); break;
              case 'track': result = store.track(args.pollId, args); break;
              case 'untrack': result = store.untrack(args.pollId, args.voter); break;
              case 'close': result = store.close(args.pollId, args.outcome); break;
              default: throw new Error('Choose add-option, track, untrack, or close.');
            }
          } else if (name === 'council_poll_create') result = await openPoll(directory, args);
          else if (name === 'council_poll_vote') result = store.vote(args.pollId, { ...args, voter: args.voter ?? process.env.HC_TERMINAL_ID });
          else result = args.pollId === undefined ? store.list() : inspectPoll(directory, args.pollId);
          return this.sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }

        case 'council_debate_create':
        case 'council_debate_read':
        case 'council_debate_close':
        case 'council_debate_reply': {
          const directory = projectDirectory(args.project, this.defaultProject);
          let result;
          switch (name) {
            case 'council_debate_create': result = await openThread(directory, args); break;
            case 'council_debate_read': result = args.debateId === undefined ? listThreads(directory) : inspectThread(directory, args.debateId); break;
            case 'council_debate_close': result = await closeThread(directory, args.debateId, args); break;
            case 'council_debate_reply': result = await replyToThread(directory, args.debateId, args); break;
          }
          return this.sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }

        case 'council_session_status': {
          const { project, jobManager } = this.workspaceContext(args.project);
          const res = await jobManager.getStatus(args.sessionId);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: JSON.stringify({ ...res, project }, null, 2)
            }]
          });
        }

        case 'council_result': {
          const { project, jobManager } = this.workspaceContext(args.project);
          const res = await jobManager.getResult(args.sessionId);
          return this.sendResult(id, {
            isError: !res.success,
            content: [{
              type: 'text',
              text: JSON.stringify({ ...res, project }, null, 2)
            }]
          });
        }

        case 'council_status': {
          const doctor = this.herdr.doctor();
          const listRes = this.herdr.list();
          const project = args.project !== undefined || args.host ? projectDirectory(args.project, this.defaultProject) : this.defaultProject;
          const liveServer = {
            version: councilVersion,
            skillRevision,
            tools: this.getToolsList().map(tool => tool.name),
            defaultProject: this.defaultProject ?? null
          };
          const integration = diagnoseCouncilHost({ host: args.host, project, target: args.target,
            herdr: this.herdr, liveServer, hostTools: args.hostTools });
          let status = integration.hostInventory.state === 'complete' ? 'ok' : 'unverified';
          if (!doctor.herdrInstalled || !listRes.success || integration.issues.length) status = 'degraded';
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status,
                integration,
                environment: doctor,
                activeTerminals: listRes.success ? listRes.terminals : listRes.error
              }, null, 2)
            }]
          });
        }

        case 'council_cast_ballot': {
          const sDir = resolveVotingSession(this.workspace, args.sessionId);
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
                ballot: res.ballot,
                retally: retallyAfterBallot(this.workspace, sDir, args.round || 1)
              }, null, 2)
            }]
          });
        }

        case 'council_convene': {
          const { orchestrator } = this.workspaceContext(args.project);
          const result = await orchestrator.runMode({
            mode: args.mode || 'council',
            sessionId: args.sessionId || null,
            representative: args.representative || null,
            task: args.task,
            context: args.context,
            criteria: args.criteria,
            subtasks: args.subtasks,
            stages: args.stages,
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
          const { orchestrator } = this.workspaceContext(args.project);
          const result = await orchestrator.runMode({
            mode: 'delegate',
            agents: [args.agent],
            sessionId: args.sessionId,
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
              text: result.output || (result.error ? `Delegation failed (${result.sessionId}): ${result.error}` : JSON.stringify(result, null, 2))
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
            text: '# Council Modes\n- council: Author proposal, then skeptic and simplifier reviews.\n- review: Author proposal, then reviewer and simplifier reviews.\n- delegate: One bounded specialist task.\n\nDebate compares two cases with a judge. Parallel gathers independent assignments. Pipeline passes a saved capture to the next stage. Validation is mechanical; screen-only evidence is provisional, not an agent endorsement.'
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
