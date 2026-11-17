import readline from 'node:readline';
import { HerdrClient } from './herdr.js';
import { CouncilOrchestrator } from './modes.js';
import { SUPPORTED_AGENTS } from './recipes.js';

/**
 * Lightweight, zero-dependency MCP stdio server implementing Model Context Protocol 2024-11-05.
 */
export class CouncilMcpServer {
  constructor(options = {}) {
    this.herdr = new HerdrClient(options);
    this.orchestrator = new CouncilOrchestrator({ herdr: this.herdr, cwd: options.cwd || process.cwd() });
    this.cwd = options.cwd || process.cwd();
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
            version: '2.0.0'
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
        name: 'council_status',
        description: 'Check Herdr installation, hc version, available agent CLIs (Claude, Codex, Antigravity, Junie), and live terminals.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'council_convene',
        description: 'Convene a multi-agent council in Herdr. Executes collaborative workflows (council, review, debate, parallel, pipeline) across agents and returns synthesized reports.',
        inputSchema: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'The task, problem, or decision for the council to address.' },
            mode: {
              type: 'string',
              enum: ['council', 'review', 'debate', 'parallel', 'pipeline'],
              default: 'council',
              description: 'Collaboration mode: council (deliberate & synthesize), review (peer code review), debate (two viewpoints + judge), parallel (fan-out), pipeline (sequential).'
            },
            context: { type: 'string', description: 'Relevant code, files, or background context for the council.' },
            criteria: { type: 'string', description: 'Decision constraints or acceptance criteria.' },
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

        case 'council_convene': {
          const result = await this.orchestrator.runMode({
            mode: args.mode || 'council',
            task: args.task,
            context: args.context,
            criteria: args.criteria,
            agents: args.agents || ['claude', 'codex', 'antigravity'],
            permission: args.permission || 'read',
            timeoutSec: args.timeoutSec || 180,
            keepTerminals: Boolean(args.keepTerminals)
          });
          return this.sendResult(id, {
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
            content: [{
              type: 'text',
              text: result.output || JSON.stringify(result, null, 2)
            }]
          });
        }

        case 'council_wait': {
          const res = args.target === 'all'
            ? this.herdr.waitAllChildren({ timeoutSec: args.timeoutSec })
            : this.herdr.wait(args.target, { timeoutSec: args.timeoutSec });
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: res.output || (res.success ? 'Wait completed successfully.' : `Wait failed: ${res.error}`)
            }]
          });
        }

        case 'council_read': {
          const res = this.herdr.read(args.target, args.lines || 100);
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: res.content || (res.success ? '(Empty output)' : `Read failed: ${res.error}`)
            }]
          });
        }

        case 'council_send': {
          const res = this.herdr.send(args.target, args.message);
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: res.success ? `Message sent to ${args.target}.` : `Send failed: ${res.error}`
            }]
          });
        }

        case 'council_dismiss': {
          const res = this.herdr.dismiss(args.target);
          return this.sendResult(id, {
            content: [{
              type: 'text',
              text: res.success ? `Dismissed terminal ${args.target}.` : `Dismiss failed: ${res.killOutput || res.rmOutput}`
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
            text: '# Council Modes\n- council: Multi-agent debate and consensus.\n- review: Author drafts, reviewers inspect, simplifier trims.\n- debate: Two opposing views judged by referee.\n- parallel: Independent subtasks executed in parallel.\n- pipeline: Sequential handoffs.\n- delegate: Single task offloaded.'
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
