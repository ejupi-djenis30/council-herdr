function parsed(response) {
  try { return JSON.parse(response?.stdout); } catch { return null; }
}

function problem(response, record) {
  return record?.error || response?.stderr?.trim() || 'Council returned no acknowledgement.';
}

export async function refreshFormalTally(review, dispatch) {
  const round = review.roundActions?.round;
  if (!round) throw new Error('Finish the participant turns before refreshing the tally.');
  const response = await dispatch(['retally', '--session', review.id]);
  const record = parsed(response);
  // The CLI exits 1 for a recorded decision that declined approval.
  if (record?.sessionId === review.id && record.round === round && record.tally?.round === round &&
      typeof record.status === 'string' && typeof record.authorized === 'boolean' &&
      record.success === record.authorized && response.code === (record.authorized ? 0 : 1)) return record;
  throw new Error(problem(response, record));
}

export async function startFormalRound(review, dispatch) {
  const action = review.roundActions;
  if (!action?.canStartNext) throw new Error('A completed round and its original proposal are required.');
  const args = ['round', '--session', review.id, '--new-session', action.nextSessionId];
  let response;
  let reason;
  try {
    response = await dispatch(args);
  } catch (error) {
    reason = error.message;
  }
  const record = parsed(response);
  if (response?.code === 0 && record?.success === true && record.sessionId === action.nextSessionId) return record.sessionId;
  if (record?.success === false) throw new Error(problem(response, record));
  // Read the job fingerprint after an unacknowledged launch; never dispatch a second worker here.
  try {
    const receipt = await dispatch([...args, '--inspect']);
    const match = parsed(receipt);
    if (receipt.code === 0 && match?.sessionId === action.nextSessionId && match.matches === true) return match.sessionId;
  } catch {}
  throw new Error(`${reason || problem(response, record)} Check session ${action.nextSessionId} in Activity.`);
}
