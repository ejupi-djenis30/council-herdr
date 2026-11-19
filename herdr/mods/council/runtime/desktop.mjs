import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PollStore } from './polls.mjs';
import { isDirectory, isFile, readText } from './store-files.mjs';

function readJson(path) {
  const raw = readText(path, 1024 * 1024);
  return raw === null ? null : JSON.parse(raw);
}

function readReview(base, id, selected) {
  const dir = join(base, id);
  if (!isDirectory(dir)) return null;
  const session = readJson(join(dir, 'session.json'));
  if (session?.sessionId !== id || !['council', 'review'].includes(session.mode)) return null;
  const createdAt = Date.parse(session.createdAt);
  const candidates = ['reports', 'validation'].flatMap(folder => {
    const results = join(dir, folder);
    if (!isDirectory(results)) return [];
    const verdict = readJson(join(results, 'verdict.json'));
    const validation = verdict?.validation;
    const timestamp = Date.parse(validation?.validatedAt);
    if (verdict?.sessionId !== id || verdict.mode !== session.mode ||
        validation?.$schema !== 'council.validation/v1' || !verdict.tally ||
        !Number.isFinite(createdAt) || !Number.isFinite(timestamp) || timestamp < createdAt) return [];
    return [{ folder, verdict, timestamp }];
  });
  // A reused ID may have an older report alongside its current validation.
  candidates.sort((a, b) => b.timestamp - a.timestamp ||
    Number(b.folder === 'validation') - Number(a.folder === 'validation'));
  const saved = candidates[0];
  const validation = saved?.verdict.validation;
  const tally = saved?.verdict.tally;
  const authorized = saved?.folder === 'reports' && validation.passed === true &&
    ['validated', 'conditional'].includes(validation.verdict) && validation.artifactIntegrity === true &&
    validation.mutationDetected === false && tally.passed === true && tally.quorumMet === true && tally.invalidCount === 0;
  const taskDir = join(dir, 'task');
  const task = isDirectory(taskDir) ? readText(join(taskDir, 'task.md'), 1024 * 1024)?.trim() : null;
  const reportPath = selected && saved ? join(dir, saved.folder, 'report.md') : null;
  const summary = {
    id, mode: session.mode, question: task?.slice(0, 220) || id, createdAt: session.createdAt,
    status: authorized ? 'approved'
      : ['approved', 'validated', 'conditional'].includes(validation?.verdict) ? 'unconfirmed' : validation?.verdict ?? 'pending'
  };
  const detail = selected ? {
    ...summary, task: task?.slice(0, 2400) || id,
    tally: tally ?? null, validation: validation ?? null, participants: session.participants ?? [],
    reportPath: reportPath && isFile(reportPath) ? reportPath : null
  } : null;
  return { summary, detail };
}

function reviews(cwd, selected) {
  const base = join(cwd, '.agent_workspace');
  if (!isDirectory(base)) return { reviews: [], review: null, errors: [] };
  if (selected != null) {
    if (typeof selected !== 'string' || !selected || selected.startsWith('.') || /[\\/:\u0000-\u001f]/.test(selected)) {
      throw new Error('Invalid review ID.');
    }
    return { review: readReview(base, selected, true)?.detail ?? null };
  }
  const entries = readdirSync(base, { withFileTypes: true });

  const summaries = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const result = readReview(base, entry.name, false);
      if (!result) continue;
      summaries.push(result.summary);
    } catch (error) {
      errors.push({ id: entry.name, error: error.message });
    }
  }
  summaries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { reviews: summaries, errors };
}

export function desktopRequest(cwd, action, args) {
  const store = new PollStore(cwd);
  switch (action) {
    case 'polls': {
      if (args.id) return { poll: store.show(args.id) };
      return store.list();
    }
    case 'reviews': return reviews(cwd, args.id);
    case 'create': return store.create(args);
    case 'add-option': return store.addOption(args.id, args.label);
    case 'track': return store.track(args.id, args);
    case 'untrack': return store.untrack(args.id, args.voter);
    case 'vote': return store.vote(args.id, { ...args, voter: 'operator' }, { fromPanel: true });
    case 'close': return store.close(args.id, args.outcome);
    default: throw new Error('Unknown Council panel action.');
  }
}
