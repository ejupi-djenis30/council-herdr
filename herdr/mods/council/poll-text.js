export function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function projectName(folder) {
  return folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

export function projectLabels(folders) {
  const groups = new Map();
  for (const folder of new Set(folders)) {
    const key = projectName(folder).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(folder);
  }
  return new Map([...groups.values()].flatMap(group => group.map(folder => [folder, group.length > 1 ? folder : projectName(folder)])));
}

export function discussionType(item) {
  if (item.interactive) return 'Debate thread';
  if (item.mode === 'debate') return 'Archived debate';
  return item.mode === 'council' ? 'Council deliberation' : 'Formal review';
}

export function pollStatus(poll) {
  return poll.closedAt ? 'Closed' : 'Open';
}

export function participantName(participant) {
  return participant.label === participant.voter ? participant.voter : `${participant.label} (${participant.voter})`;
}

export function responseValue(poll, response) {
  return response.answer || poll.options.find(option => option.id === response.optionId)?.label || response.optionId;
}

export function invitation(poll, { folder, cli, participant }) {
  const voter = participant?.voter;
  const args = voter ? ` --voter ${voter}` : '';
  const instructions = [
    `Council poll: ${poll.question}`,
    ...(poll.context ? [`Context: ${poll.context}`] : []),
    `Poll ID: ${poll.id}`,
    `Project folder: ${folder}`,
    voter ? `Submit your response as ${voter}.` : 'Use your own Herdr terminal address as the voter ID.',
    '',
    'Read the poll with council_poll_read and respond with council_poll_vote using the same project.',
    `CLI alternative: run the Node entry point ${cli} from the project folder.`,
    `Read: poll show ${poll.id}`
  ];
  if (poll.mode !== 'open') instructions.push(`Choose: poll vote ${poll.id}${args} --option <option-id> --note "<your rationale>"`);
  if (poll.mode !== 'choice') instructions.push(`Free response: poll vote ${poll.id}${args} --answer "<your response>"`);
  if (!voter) instructions.push('The CLI uses HC_TERMINAL_ID when available. Otherwise pass --voter with a stable ID.');
  instructions.push('If your permissions prevent submission, reply with your recommendation in your current conversation.');
  return instructions.join('\n');
}

export function decisionSummary(poll, folder) {
  const { participants, participation, responses } = poll;
  const pending = participants.filter(participant => !responses.some(response => response.voter === participant.voter));
  const voters = new Map(participants.map(participant => [participant.voter, participantName(participant)]));
  voters.set('operator', 'Panel operator');
  const lines = [
    `# Council poll — ${poll.question.replace(/\s+/g, ' ')}`,
    '',
    `Project folder: ${folder}`,
    `Poll ID: ${poll.id}`,
    `${pollStatus(poll)} · ${countLabel(poll.responseCount, 'response')}`
  ];
  if (participation.expected) lines.push(`Tracked agents responded: ${participation.received}/${participation.expected}`);
  if (poll.context) lines.push(`Context: ${poll.context}`);
  if (poll.outcome) lines.push('', `Decision / next step: ${poll.outcome}`);
  if (poll.options.length || poll.freeCount) {
    lines.push('', '## Results');
    for (const option of poll.options) lines.push(`- ${option.label}: ${countLabel(option.count, 'vote')}`);
    if (poll.mode !== 'choice') lines.push(`- Free responses: ${poll.freeCount}`);
  }
  if (pending.length) {
    lines.push('', `${poll.closedAt ? 'No response' : 'Awaiting response'}: ${pending.map(participantName).join(', ')}`);
  }
  if (responses.length) {
    lines.push('', '## Responses');
    for (const response of responses) {
      lines.push(`- ${voters.get(response.voter) ?? response.voter}: ${responseValue(poll, response)}`);
      if (response.note) lines.push(`  Rationale: ${response.note}`);
    }
  }
  return lines.join('\n');
}
