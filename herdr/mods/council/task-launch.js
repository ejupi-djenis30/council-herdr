export const taskAgents = ['codex', 'claude', 'antigravity', 'junie'];

export async function submitTask({ sessionId, member, task, agent, permission, timeout }, dispatch, matchSession) {
  const brief = task.trim();
  if (!brief || brief.length > 12000) throw new Error('Enter a task of 1 to 12000 characters.');
  const seconds = Number(timeout);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(new Date(Date.now() + seconds * 1000).getTime())) {
    throw new Error('Enter a positive deadline in whole seconds.');
  }
  if (!member && (!taskAgents.includes(agent) || !['read', 'write'].includes(permission))) {
    throw new Error('Choose an agent and its project access.');
  }
  const args = member ? ['team', 'call', member] : ['start', '--agent', agent, '--permission', permission];
  // The CLI recognizes a leading "--" as a flag. JobManager trims the task before saving it.
  args.push('--session', sessionId, '--timeout', String(seconds), '--task', brief.startsWith('--') ? ' ' + brief : brief);
  let reason;
  let rejected = false;
  try {
    const response = await dispatch(args);
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
    const receipt = await matchSession({ sessionId, member, task: brief, timeoutSec: seconds, agent, permission });
    if (receipt?.matches === true) return sessionId;
  } catch {}
  throw new Error(`${reason} Check session ${sessionId} in Delegations. Retrying this form uses the same session.`);
}
