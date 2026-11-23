export const taskAgents = ['codex', 'claude', 'antigravity', 'junie'];
export const workflowModes = [
  ['delegate', 'Delegate'], ['council', 'Formal council'], ['review', 'Formal review'],
  ['debate', 'Automated debate'], ['parallel', 'Parallel assignments'], ['pipeline', 'Ordered pipeline']
];
export const workflowRoles = {
  council: ['Author', 'Skeptic', 'Simplifier'],
  review: ['Author', 'Reviewer', 'Simplifier'],
  debate: ['Side A', 'Side B', 'Judge']
};

// Text fields become InputState instances in the native mod. Keep row identities stable when reordered.
export function taskFormDefaults(mode = 'delegate') {
  const fields = { task: '', timeout: '180', adoptAddress: '', context: '', criteria: '', assignment1: '', assignment2: '',
    stageName1: 'Research', stageName2: 'Implementation plan', stageName3: 'Verification',
    stageTask1: '', stageTask2: '', stageTask3: '' };
  const roleAgents = ['claude', 'codex', 'antigravity'];
  const assignments = [{ id: 1, agent: 'claude' }, { id: 2, agent: 'codex' }];
  const stages = roleAgents.map((agent, index) => ({ id: index + 1, agent, role: index === 2 ? 'reviewer' : 'author' }));
  return { fields, extra: { mode, target: 'new', agent: 'codex', permission: 'read', keepTerminals: false, roleAgents,
    representatives: { council: '', review: '' }, assignments, stages, nextRowId: 4 } };
}

export function taskFormValues(form) {
  const { agent, permission, keepTerminals, sessionId } = form;
  const mode = form.member ? 'delegate' : form.mode;
  const values = { mode, agent, permission, keepTerminals, sessionId, member: form.member?.id,
    task: form.task.value(), timeout: form.timeout.value() };
  if (mode === 'delegate') {
    if (!form.member && form.kind === 'task' && form.target === 'existing') values.adopt = form.adoptAddress.value().trim();
    return values;
  }
  values.context = form.context.value();
  values.criteria = form.criteria.value();
  if (mode === 'parallel') {
    values.agents = form.assignments.map(row => row.agent);
    values.subtasks = form.assignments.map(row => form['assignment' + row.id].value());
  } else if (mode === 'pipeline') {
    values.agents = form.stages.map(row => row.agent);
    values.stages = form.stages.map(({ id, agent, role }) => ({
      name: form['stageName' + id].value(), task: form['stageTask' + id].value(), agent, role
    }));
  } else {
    values.agents = [...form.roleAgents];
    values.representative = form.representatives[mode] || null;
  }
  return values;
}

// Inline a flag-like value so it survives the CLI parser byte for byte.
const textOption = (flag, text) => text.startsWith('--') ? [flag + '=' + text] : [flag, text];

export function prepareTask({ mode = 'delegate', sessionId, member, task, adopt, agent = 'codex', permission = 'read', timeout,
  agents, context = '', criteria = '', subtasks = [], stages = [], representative = null, keepTerminals = false }) {
  const brief = task.trim();
  if (!brief || brief.length > 12000) throw new Error('Enter a task of 1 to 12000 characters.');
  const seconds = Number(timeout);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(new Date(Date.now() + seconds * 1000).getTime())) {
    throw new Error('Enter a positive deadline in whole seconds.');
  }
  if (!workflowModes.some(([id]) => id === mode) || (member && mode !== 'delegate')) throw new Error('Choose a supported workflow.');
  const args = ['--timeout', String(seconds), ...textOption('--task', brief)];
  const receipt = { mode, member, sessionId, task: brief, agent: mode === 'delegate' ? agent : 'codex', permission,
    timeoutSec: seconds, keepTerminals: !member && keepTerminals };
  if (adopt !== undefined) {
    if (mode !== 'delegate' || member || !/^t[0-9a-z]+$/.test(adopt)) {
      throw new Error('Enter an existing terminal ID on this host, such as t123.');
    }
    args.push('--adopt', adopt);
    // Borrowed participants retain their current agent, permissions and terminal.
    return { args, receipt: { ...receipt, adopt, agent: 'codex', permission: 'read', keepTerminals: false } };
  }
  if (member) return { args, receipt };
  if (!['read', 'write'].includes(permission)) throw new Error('Choose read or write project access.');
  args.push('--mode', mode, '--permission', permission);
  if (keepTerminals) args.push('--keep');
  if (mode === 'delegate') {
    if (!taskAgents.includes(agent)) throw new Error('Choose an agent.');
    args.push('--agent', agent);
    return { args, receipt };
  }
  if (!Array.isArray(agents) || !agents.length || !agents.every(name => taskAgents.includes(name))) {
    throw new Error('Choose an agent for each participant.');
  }
  if (workflowRoles[mode] && agents.length !== 3) throw new Error('Choose an agent for each of the three roles.');
  args.push('--agents', agents.join(','));
  const workflow = { agents, subtasks: [], stages: [], round: 1, context: context.trim(),
    criteria: criteria.trim(), representative: null, previousSession: null };
  if (workflow.context) args.push(...textOption('--context', workflow.context));
  if (workflow.criteria) args.push(...textOption('--criteria', workflow.criteria));
  if (representative) {
    if (!['council', 'review'].includes(mode) ||
        !workflowRoles[mode].some(role => representative === mode + '-' + role.toLowerCase())) {
      throw new Error('Choose a representative from this workflow.');
    }
    workflow.representative = representative;
    args.push('--representative', representative);
  }
  if (mode === 'parallel') {
    if (subtasks.length !== agents.length || !subtasks.every(task => typeof task === 'string' && task.trim())) {
      throw new Error('Enter a task for each parallel assignment.');
    }
    workflow.subtasks = subtasks.map(task => task.trim());
    args.push('--subtasks', JSON.stringify(workflow.subtasks));
  }
  if (mode === 'pipeline') {
    if (stages.length !== agents.length) throw new Error('Choose an agent for each pipeline stage.');
    workflow.stages = stages.map((stage, index) => {
      const name = stage.name?.trim();
      if (!name) throw new Error(`Enter a name for stage ${index + 1}.`);
      if (stage.agent !== agents[index] || !['author', 'reviewer'].includes(stage.role)) {
        throw new Error(`Choose an agent and role for stage ${index + 1}.`);
      }
      const instruction = stage.task?.trim();
      return { name, ...(instruction ? { task: instruction } : {}), agent: stage.agent, role: stage.role };
    });
    args.push('--stages', JSON.stringify(workflow.stages));
  }
  receipt.workflow = workflow;
  return { args, receipt };
}

export async function submitTask(params, dispatch, matchSession) {
  const { sessionId, member } = params;
  const { args, receipt } = prepareTask(params);
  const command = member ? ['team', 'call', member] : ['start'];
  let reason;
  let rejected = false;
  try {
    const response = await dispatch([...command, '--session', sessionId, ...args]);
    let record;
    try { record = JSON.parse(response.stdout); } catch {}
    if (response.code === 0 && record?.success === true && record.sessionId === sessionId) return sessionId;
    reason = record?.error || response.stderr?.trim() || 'The launcher returned no acknowledgement.';
    const message = reason.replace(/^(?:Start failed|Fatal Council Error): /, '');
    rejected = (record?.success === false && record.sessionId !== sessionId) ||
      message.startsWith(`Session "${sessionId}" already exists with conflicting parameters`) ||
      message === `Session "${sessionId}" belongs to another job.`;
  } catch (error) {
    reason = error.message;
  }
  if (rejected) throw new Error(reason);
  // A worker may have started before the exec acknowledgement was lost.
  try {
    if ((await matchSession(receipt))?.matches === true) return sessionId;
  } catch {}
  throw new Error(`${reason} Check session ${sessionId} in Delegations. Retrying this form uses the same session.`);
}
