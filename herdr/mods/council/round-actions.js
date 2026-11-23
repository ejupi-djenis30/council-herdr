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
  // An implicit start can reconnect to a custom ID created since this view was read.
  const args = ['round', '--session', review.id];
  let response;
  let reason;
  try {
    response = await dispatch(args);
  } catch (error) {
    reason = error.message;
  }
  const identifiesRound = record => record?.sessionId === action.nextSessionId ||
    (typeof record?.sessionId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(record.sessionId) &&
      record.previousSession === review.id && record.round === action.round + 1);
  const record = parsed(response);
  if (response?.code === 0 && record?.success === true && identifiesRound(record)) return record.sessionId;
  if (record?.success === false) throw new Error(problem(response, record));
  // Read the job fingerprint after an unacknowledged launch; never dispatch a second worker here.
  let id = action.nextSessionId;
  try {
    const receipt = await dispatch([...args, '--inspect']);
    const match = parsed(receipt);
    if (receipt.code === 0 && match?.matches === true && identifiesRound(match)) return match.sessionId;
    if (match?.success === false) reason = problem(receipt, match);
    if (match?.sessionId) id = match.sessionId;
  } catch {}
  throw new Error(`${reason || problem(response, record)} Check session ${id} in Activity.`);
}
