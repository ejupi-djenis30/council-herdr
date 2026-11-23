import { SUPPORTED_MODES } from './modes.js';
import { multiAgentJobProperties, workflowTools } from './workflow-tools.js';

const projectArgument = { type: 'string', description: 'Absolute local project path. Pass it when this MCP connection has no default project.' };
const hostTools = { type: 'array', items: { type: 'string' },
  description: 'Council tool names discovered in this agent session, including deferred tools. Supply this inventory for a readiness check. The server catalog describes advertised tools only.' };
const invitationRecipients = { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^t[0-9a-z]+$' },
  description: 'Explicit Herdr terminal addresses to invite. All recipients must belong to the same local space.' };

export function councilToolDefinitions() {
  return [
    ...workflowTools,
    {
      name: 'council_alignment',
      description: 'Report your own Council setup from the current Herdr terminal, or query another terminal. A positive report requires the installed skill revision and the current host tool inventory.',
      inputSchema: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['report', 'status'] },
          state: { type: 'string', enum: ['aligned', 'not_aligned'] },
          revision: { type: 'string' },
          hostTools,
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
      description: 'Start any Council workflow in Herdr and return durable background job details immediately.',
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', description: 'Task instruction for the workflow.' },
          mode: { type: 'string', enum: SUPPORTED_MODES, default: 'delegate' },
          ...multiAgentJobProperties,
          agent: { type: 'string', default: 'codex', description: 'Agent CLI: claude, codex, antigravity, junie.' },
          adopt: { type: 'string', description: 'Terminal address to adopt instead of spawning a new agent.' },
          project: projectArgument,
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
          recipients: invitationRecipients,
          sourceDebateId: { type: 'string', description: 'Link this poll to a discussion in the same project.' },
          project: projectArgument
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
      name: 'council_poll_manage',
      description: 'Add an option, track or untrack a participant, or close an advisory poll with its outcome.',
      inputSchema: {
        type: 'object', required: ['action', 'pollId'],
        properties: { action: { type: 'string', enum: ['add-option', 'track', 'untrack', 'close'] },
          pollId: { type: 'string' }, project: projectArgument, voter: { type: 'string' },
          label: { type: 'string' }, outcome: { type: 'string' } },
        oneOf: [
          { properties: { action: { const: 'add-option' } }, required: ['label'] },
          { properties: { action: { enum: ['track', 'untrack'] } }, required: ['voter'] },
          { properties: { action: { const: 'close' } } }
        ]
      }
    },
    {
      name: 'council_debate_create',
      description: 'Open a discussion thread visible in Council Desktop. Share the returned sessionId and project with participants.',
      inputSchema: {
        type: 'object', required: ['question'],
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 240 },
          context: { type: 'string', maxLength: 2000 },
          recipients: invitationRecipients,
          project: projectArgument,
          author: { type: 'string', description: 'Your terminal address when HC_TERMINAL_ID is unavailable.' }
        }
      }
    },
    {
      name: 'council_debate_read',
      description: 'List discussion threads in the project, or read a debate topic, decision and conversation by ID.',
      inputSchema: {
        type: 'object', properties: { debateId: { type: 'string', description: 'Omit to list project threads.' }, project: projectArgument }
      }
    },
    {
      name: 'council_debate_close',
      description: 'Close a discussion and record its decision, owner and next step in Council Desktop.',
      inputSchema: { type: 'object', required: ['debateId', 'decision', 'owner', 'nextStep'], properties: {
        debateId: { type: 'string' }, project: projectArgument, decision: { type: 'string' },
        owner: { type: 'string' }, nextStep: { type: 'string' }, author: { type: 'string', description: 'Your identity when HC_TERMINAL_ID is unavailable.' }
      } }
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
          sessionId: { type: 'string', description: 'Session ID to inspect.' },
          project: projectArgument
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
          sessionId: { type: 'string', description: 'Session ID to retrieve result for.' },
          project: projectArgument
        }
      }
    },
    {
      name: 'council_status',
      description: 'Inspect the live Council server catalog, project binding and Herdr health. Supply hostTools to check which tools this agent can use. Optionally diagnose project setup and terminal alignment.',
      inputSchema: {
        type: 'object',
        properties: {
          project: projectArgument,
          host: { type: 'string', enum: ['codex', 'antigravity', 'claude', 'junie', 'opencode'], description: 'Inspect this host’s project-scoped Council configuration.' },
          hostTools,
          target: { type: 'string', description: 'Check the Council readiness receipt for this terminal.' }
        }
      }
    },
    {
      name: 'council_cast_ballot',
      description: 'Cast a formal, direct voting ballot (council.ballot/v1) for an active Council session.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'voter', 'role', 'agent', 'vote', 'rationale'],
        properties: {
          sessionId: { type: 'string', description: 'Session ID or absolute session directory. Use the absolute directory on a plugin connection with no default project.' },
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
      description: 'Run a bounded workflow in Herdr and return collected evidence. Council and review can authorize proposals through direct ballots. Debate, parallel, and pipeline return advisory results.',
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', description: 'The task, problem, or decision for the council to address.' },
          project: projectArgument,
          mode: {
            type: 'string',
            enum: SUPPORTED_MODES,
            default: 'council',
            description: 'Choose council, review, delegate, debate, parallel, or pipeline.'
          },
          context: { type: 'string', description: 'Relevant code, files, or background context for the council.' },
          criteria: { type: 'string', description: 'Decision constraints or acceptance criteria.' },
          subtasks: { type: 'array', items: { type: 'string' }, description: 'Independent assignments for parallel mode.' },
          stages: { type: 'array', description: 'Ordered pipeline stages.', items: { type: 'object', required: ['name'], properties: {
            name: { type: 'string' }, task: { type: 'string' }, agent: { type: 'string' }, role: { type: 'string', enum: ['author', 'reviewer'] }
          } } },
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
      description: 'Delegate one task in a visible Herdr terminal and wait for its result. Use council_start to return immediately.',
      inputSchema: {
        type: 'object',
        required: ['agent', 'task'],
        properties: {
          agent: { type: 'string', description: 'Agent to delegate to (claude, codex, antigravity, junie).' },
          sessionId: { type: 'string', description: 'Optional session ID for this delegation.' },
          task: { type: 'string', description: 'Task instruction for the agent.' },
          project: projectArgument,
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
