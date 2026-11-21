import { join } from 'node:path';
import { appendEvent, eventFiles, isDirectory, readText } from './store-files.mjs';

const stages = new Set(['starting', 'deliberating', 'completed', 'failed', 'uncertain']);
const deliveries = new Set(['planned', 'attempting', 'acknowledged', 'failed', 'uncertain']);
const powerStates = new Set(['starting', 'on', 'stopping', 'off', 'unconfirmed']);
const progressStates = new Set(['working', 'blocked', 'handoff']);
const maxNotes = 240;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function snapshot(job) {
  return {
    state: stages.has(job.state) ? job.state : null,
    delivery: deliveries.has(job.deliveryState) ? job.deliveryState : null,
    claimed: job.worker?.status === 'claimed',
    terminal: typeof job.participant?.address === 'string' ? job.participant.address.slice(0, 96) : null,
    power: powerStates.has(job.participant?.power) ? job.participant.power : null
  };
}

export function recordJobSnapshot(job, at) {
  const point = snapshot(job);
  if (!Array.isArray(job.timeline)) job.timeline = [];
  const last = job.timeline.at(-1);
  if (last && Object.keys(point).every(key => point[key] === last[key])) return;
  job.timeline.push({ at, ...point });
}

export function jobTimeline(job, { dispatchFailed, status } = {}) {
  const createdAt = time(job.createdAt);
  const entries = createdAt ? [{ kind: 'scheduled', at: createdAt }] : [];
  let previous = {};
  const snapshots = Array.isArray(job.timeline) ? job.timeline.slice(0, 64) : [];
  const history = snapshots[0]?.at === createdAt ? 'recorded' : 'summary';
  for (const point of snapshots) {
    const at = time(point?.at);
    if (!at) continue;
    if (point.claimed && !previous.claimed) entries.push({ kind: 'claimed', at });
    if (point.delivery === 'attempting' && previous.delivery !== 'attempting') entries.push({ kind: 'dispatched', at });
    if (point.terminal && point.terminal !== previous.terminal) entries.push({ kind: 'terminal', at, text: String(point.terminal).slice(0, 96) });
    if (point.delivery === 'acknowledged' && previous.delivery !== 'acknowledged') entries.push({ kind: 'delivered', at });
    if (point.state === 'completed' && previous.state !== 'completed' && status === 'completed') entries.push({ kind: 'captured', at });
    if (point.power !== previous.power && ['stopping', 'off', 'unconfirmed'].includes(point.power)) {
      entries.push({ kind: point.power, at });
    }
    previous = point;
  }
  const at = time(job.result?.completedAt) ?? time(job.updatedAt);
  if (status === 'completed' && !entries.some(entry => entry.kind === 'captured')) entries.push({ kind: 'captured', at });
  if (history === 'summary' && job.deliveryState === 'acknowledged' && !entries.some(entry => entry.kind === 'delivered')) {
    entries.splice(createdAt ? 1 : 0, 0, { kind: 'delivered', at: null });
  }
  if (history === 'summary' && job.participant?.power === 'off' && !entries.some(entry => entry.kind === 'off')) {
    entries.push({ kind: 'off', at: time(job.updatedAt) });
  }
  if (dispatchFailed) entries.push({ kind: 'dispatch_failed', at: time(dispatchFailed.failedAt) });
  else if (['blocked', 'failed', 'uncertain', 'invalid', 'timed_out'].includes(status)) {
    const observedTimeout = status === 'timed_out' && job.state === 'failed';
    entries.push({ kind: observedTimeout ? 'wait_timed_out' : status,
      at: status === 'timed_out' && !observedTimeout ? time(job.deadlineAt) : time(job.updatedAt) });
  }
  return { history, entries };
}

function progressNote(note) {
  if (note?.$schema !== 'council.progress/v1' || !time(note.at) || !progressStates.has(note.state) ||
      typeof note.text !== 'string' || !note.text.trim() || note.text.length > 1200 ||
      (note.component !== null && (typeof note.component !== 'string' || !/^[\w-]{1,80}$/.test(note.component)))) {
    throw new Error('Invalid progress note.');
  }
  return { at: note.at, state: note.state, text: note.text, component: note.component,
    reporter: typeof note.reporter === 'string' ? note.reporter.slice(0, 96) : null };
}

export function readProgress(dir, limit = 30) {
  const path = join(dir, 'progress');
  const notes = [];
  let unreadable = 0;
  const files = eventFiles(path);
  for (const file of files.slice(-limit)) {
    try { notes.push(progressNote(JSON.parse(readText(join(path, file), 16384)))); }
    catch { unreadable++; }
  }
  return { notes, count: files.length, unreadable };
}

function existingProgress(path, files, pending) {
  if (!pending.requestId) return null;
  for (const file of [...files].reverse()) {
    let stored;
    try { stored = JSON.parse(readText(join(path, file), 16384)); }
    catch { continue; }
    if (stored?.requestId !== pending.requestId) continue;
    const record = progressNote(stored);
    if (['state', 'text', 'component', 'reporter'].some(field => record[field] !== pending[field])) {
      throw new Error('This update ID is already used. Open a new update to save different content.');
    }
    return record;
  }
  return null;
}

export function saveProgress(dir, input, terminalId, validateComponent) {
  const { requestId } = input;
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.-]{1,96}$/.test(requestId))) {
    throw new Error('Invalid progress update ID.');
  }
  const note = {
    $schema: 'council.progress/v1', at: new Date().toISOString(), state: input.state ?? 'working',
    text: typeof input.text === 'string' ? input.text.trim() : null, component: input.component ?? null,
    reporter: typeof terminalId === 'string' && terminalId ? terminalId.slice(0, 96) : null, requestId
  };
  const view = progressNote(note);
  const path = join(dir, 'progress');
  for (let attempt = 0; attempt < 12; attempt++) {
    const files = eventFiles(path);
    const existing = existingProgress(path, files, note);
    if (existing) return existing;
    if (note.component !== null && !validateComponent(note.component)) {
      throw new Error('Choose a component ID from this project’s PLAN.md.');
    }
    const revision = files.length ? Number(files.at(-1).slice(0, 8)) + 1 : 1;
    if (files.length >= maxNotes || revision > 99999999) throw new Error('This session has reached its progress note limit.');
    isDirectory(path, { create: true });
    if (appendEvent(path, revision, note)) return view;
  }
  throw new Error('Progress was updated concurrently. Try again.');
}
