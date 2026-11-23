import { randomBytes } from 'node:crypto';

export const alignmentKey = 'council.alignment';
export const challengeKey = 'council.challenge';
export const skillRevision = 'council/herdr-alignment-v1';
// Included in the standalone Desktop runtime as well as the MCP server.
export const alignmentVersion = '3.7.0';
const maxAge = 8 * 60 * 60 * 1000;

export function terminalIdentity(terminal) {
  if (terminal?.state !== 'live' || terminal.reported !== true || !Number.isSafeInteger(terminal.created_ms) ||
      !Number.isSafeInteger(terminal.pid) || typeof terminal.status?.app !== 'string') return null;
  return [terminal.created_ms, terminal.pid, terminal.status.app].join(':');
}

export function alignmentDetails(terminal, now = Date.now()) {
  const subject = terminalIdentity(terminal);
  if (!subject || !terminal.labels?.[alignmentKey]) return { state: 'unconfirmed' };
  try {
    const receipt = JSON.parse(Buffer.from(terminal.labels[alignmentKey], 'base64url').toString('utf8'));
    if (receipt.subject === subject && Number.isFinite(receipt.expiresAt) && now < receipt.expiresAt) {
      if (receipt.state === 'aligned' && receipt.serverVersion !== alignmentVersion) {
        return { state: 'needs_reload', serverVersion: typeof receipt.serverVersion === 'string' ? receipt.serverVersion : null,
          expectedVersion: alignmentVersion, nextAction: alignmentError(terminal.address, 'needs_reload') };
      }
      if (receipt.revision === skillRevision) {
        if (receipt.state === 'not_aligned') return { state: 'not_aligned' };
        if (receipt.state === 'aligned') return { state: 'aligned', serverVersion: receipt.serverVersion };
      }
    }
  } catch {}
  return { state: 'unconfirmed' };
}

export function alignmentOf(terminal, now = Date.now()) {
  return alignmentDetails(terminal, now).state;
}

export function alignmentLabel(terminal, state, now = Date.now()) {
  const subject = terminalIdentity(terminal);
  if (!subject || !['aligned', 'not_aligned'].includes(state)) throw new Error('Council requires a live Herdr agent that reports its app.');
  const receipt = { revision: skillRevision, ...(state === 'aligned' ? { serverVersion: alignmentVersion } : {}),
    subject, state, expiresAt: now + maxAge };
  return `${alignmentKey}=${Buffer.from(JSON.stringify(receipt)).toString('base64url')}`;
}

function pendingChallenge(terminal) {
  const value = terminal?.labels?.[challengeKey];
  const match = typeof value === 'string' && /^(\d+)\.([a-f0-9]{32})$/.exec(value);
  return match && Date.now() < Number(match[1]) ? match[2] : null;
}

export function alignmentChallenge(terminal) {
  const existing = pendingChallenge(terminal);
  if (existing) return { token: existing, argument: null, target: terminal.address };
  const token = randomBytes(16).toString('hex');
  return { token, argument: `${challengeKey}=${Date.now() + 15 * 60 * 1000}.${token}`, target: terminal?.address };
}

export function reportAlignment(herdr, { state, revision, target, challenge }, { viaMcp = false } = {}) {
  const address = target ?? herdr.terminalId;
  if (!address) throw new Error('Run the Council integration from your own Herdr terminal. HC_TERMINAL_ID is missing.');
  if (!['aligned', 'not_aligned'].includes(state)) throw new Error('Use aligned or not_aligned.');
  if (state === 'aligned' && (!viaMcp || revision !== skillRevision)) {
    throw new Error('Load the current Council skill and register through its Council MCP tool.');
  }
  const probe = herdr.get(address);
  if (!probe.success || probe.details?.address !== address) throw new Error('Council could not verify your Herdr terminal.');
  if ((address !== herdr.terminalId || challenge != null) &&
      (typeof challenge !== 'string' || challenge !== pendingChallenge(probe.details))) {
    throw new Error('A current challenge from that terminal is required for this readiness report.');
  }
  const value = alignmentLabel(probe.details, state);
  const reply = herdr.exec(['label', '--json', address, value, `${challengeKey}=`], { timeout: 10000 });
  if (!reply.success) throw new Error(reply.stderr || reply.stdout || 'Herdr could not save your Council alignment.');
  return { address, state, revision: skillRevision, ...(state === 'aligned' ? { serverVersion: alignmentVersion } : {}) };
}

export function alignmentNotice(declineEntry, challenge) {
  const lines = [
    'Council alignment check. This message contains no Council assignment.',
    `Use council_status to confirm this agent's Council MCP server is version ${alignmentVersion}. If you have this version and the current Council skill, follow the skill to report your alignment using council_alignment. Then finish this turn and wait for a separate assignment.`,
    'If either is missing, reply exactly "Council alignment: not aligned" and stop. In Council MCP, report not_aligned if the tool is available.'
  ];
  if (challenge) {
    const target = challenge.target ? `the target ${challenge.target}` : 'your own HC_TERMINAL_ID as the target';
    lines.push(`If MCP cannot see your Herdr terminal identity, include ${target} and this challenge: ${challenge.token}.`);
  }
  if (declineEntry) lines.push(`If permitted, you can also report missing setup in Herdr by running Node with "${declineEntry}" and arguments: alignment decline.`);
  return lines.join('\n');
}

export function alignmentError(address, state) {
  if (state === 'needs_reload') {
    return `Reload the Council MCP connection in the agent running in terminal ${address} with Council ${alignmentVersion}. Then run council alignment check ${address} and wait for a fresh receipt.`;
  }
  const label = state === 'not_aligned' ? 'reported missing Council setup' : 'has no current Council alignment';
  return `Terminal ${address} ${label}. Install or refresh the Council skill and the plugin or MCP connection in that agent, then register with council_alignment.`;
}
