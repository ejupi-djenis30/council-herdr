import { SUPPORTED_MODES } from './modes.js';
import { ScheduleManager } from './schedules.js';
import { nextFormalRound, retallyFormalRound } from './formal-rounds.js';

export const multiAgentJobProperties = {
  agents: { type: 'array', items: { type: 'string' } },
  subtasks: { type: 'array', items: { type: 'string' } },
  stages: { type: 'array', items: { type: 'object', required: ['name'], properties: {
    name: { type: 'string' }, task: { type: 'string' }, agent: { type: 'string' }, role: { type: 'string', enum: ['author', 'reviewer'] }
  } } },
  context: { type: 'string' }, criteria: { type: 'string' }, representative: { type: 'string' }
};

export function publicJobOptions(values) {
  const keys = ['mode', 'task', 'agent', 'adopt', 'sessionId', 'permission', 'timeoutSec', 'keepTerminals', ...Object.keys(multiAgentJobProperties)];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
}

const project = { type: 'string', description: 'Absolute local project path.' };
const sessionId = { type: 'string', description: 'Existing formal session ID or absolute session directory.' };
const id = { type: 'string' };
const task = { type: 'string' };
const execution = {
  permission: { type: 'string', enum: ['read', 'write'] }, timeoutSec: { type: 'number' }, keepTerminals: { type: 'boolean' }
};

export const workflowTools = [
  { name: 'council_schedule_create', description: 'Schedule one or more background workflows in Herdr.',
    inputSchema: { type: 'object', required: ['job'], properties: {
      project, id, at: { type: 'string', description: 'First run time as an ISO timestamp. Defaults to now.' },
      everySec: { type: 'number', minimum: 1 }, count: { type: 'integer', minimum: 1 },
      job: { type: 'object', required: ['task'], properties: {
        task, mode: { type: 'string', enum: SUPPORTED_MODES }, agent: { type: 'string' }, adopt: { type: 'string' },
        ...execution, ...multiAgentJobProperties
      } }
    } } },
  { name: 'council_schedules', description: 'List scheduled workflows, inspect a schedule, or cancel its future runs.',
    inputSchema: { type: 'object', required: ['action'], properties: { project, id, action: { type: 'string', enum: ['list', 'status', 'cancel'] } } } },
  { name: 'council_round', description: 'Start a new, independently voted round linked to a completed council or review session.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: {
      project, sessionId, newSessionId: { type: 'string' }, task, ...execution, ...multiAgentJobProperties
    } } },
  { name: 'council_retally', description: 'Recompute a completed round from its direct ballots and original proposal digest.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { project, sessionId } } }
];

export function handleWorkflowRequest(name, { project, jobManager }, args) {
  if (name === 'council_round') {
    return jobManager.startJob(nextFormalRound(jobManager.workspace, args.sessionId, { ...args, sessionId: args.newSessionId }));
  }
  if (name === 'council_retally') return retallyFormalRound(jobManager.workspace, args.sessionId);
  const schedules = new ScheduleManager({ cwd: project, herdr: jobManager.herdr });
  if (name === 'council_schedule_create') return schedules.create({ ...args, job: publicJobOptions(args.job ?? {}) });
  if (args.action === 'list') return schedules.list();
  if (args.action === 'status') return schedules.status(args.id);
  if (args.action === 'cancel') return schedules.cancel(args.id);
  throw new Error('Choose list, status, or cancel.');
}
