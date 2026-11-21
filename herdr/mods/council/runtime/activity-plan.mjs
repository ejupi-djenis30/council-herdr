import { join } from 'node:path';
import { readText } from './store-files.mjs';

const states = { ' ': 'pending', '~': 'working', '!': 'blocked', x: 'done' };
const componentId = /^[\w-]{1,80}$/;
const heading = /^(#{2,5})\s+(.+?)\s*\{#([\w-]{1,80})\}\s*$/;
const taskRow = /^\s*[-*]\s+\[([ ~!xX])\]\s+(.+?)\s*$/;
const maxComponents = 48;
const maxTasks = 60;

function list(value) {
  return [...new Set(value.replace(/^\[/, '').replace(/\]$/, '').split(',')
    .map(item => item.trim().replace(/^[`"']|[`"']$/g, '')).filter(Boolean))].slice(0, 32);
}

function dependencyWarnings(components) {
  const known = new Map(components.map(component => [component.id, component.needs]));
  const visited = new Set();
  const active = new Set();
  const cycles = new Set();
  const visit = id => {
    if (active.has(id)) cycles.add(id);
    if (visited.has(id) || !known.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const need of known.get(id)) visit(need);
    active.delete(id);
  };
  for (const id of known.keys()) visit(id);
  return [...cycles].map(id => `Dependency cycle includes ${id}.`);
}

function dependencyLayers(components) {
  let pending = components;
  const placed = new Set();
  const layers = [];
  while (pending.length) {
    const available = pending.filter(component => component.needs.every(id => placed.has(id)));
    if (!available.length) {
      layers.push({ kind: 'unresolved', ids: pending.map(component => component.id) });
      break;
    }
    const ids = available.map(component => component.id);
    layers.push({ kind: layers.length ? 'dependent' : 'independent', ids });
    for (const id of ids) placed.add(id);
    pending = pending.filter(component => !placed.has(component.id));
  }
  return layers;
}

export function parsePlan(markdown) {
  const components = [];
  const decisions = [];
  const issues = [];
  const ids = new Set();
  let title = '';
  let component;
  let task;
  let fenced;
  let inDecisions = false;
  let clipped = false;
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const [, marker, suffix] = fence;
      if (!fenced) fenced = marker;
      else if (marker[0] === fenced[0] && marker.length >= fenced.length && !suffix.trim()) fenced = null;
      continue;
    }
    if (fenced) continue;
    if (!title && line.startsWith('# ')) title = line.slice(2).trim().slice(0, 180);
    if (/^#{2,5}\s/.test(line)) {
      component = null;
      task = null;
      inDecisions = /^##\s+decisions\s*$/i.test(line);
      const match = heading.exec(line);
      if (!match) continue;
      const [, , name, id] = match;
      if (ids.has(id)) {
        if (issues.length < 16) issues.push(`Duplicate component: ${id}.`);
        continue;
      }
      if (components.length >= maxComponents) {
        clipped = true;
        continue;
      }
      component = { id, title: name.trim().slice(0, 160), files: [], needs: [], links: [], kind: null, tech: null, tasks: [] };
      ids.add(id);
      components.push(component);
      continue;
    }
    if (inDecisions && /^\s*[-*]\s/.test(line) && decisions.length < 12) {
      decisions.push(line.replace(/^\s*[-*]\s+/, '').trim().slice(0, 480));
    }
    if (!component) continue;
    const row = taskRow.exec(line);
    if (row) {
      if (component.tasks.length >= maxTasks) {
        clipped = true;
        task = null;
        continue;
      }
      const [, state, text] = row;
      const id = /\s+\{#([\w-]{1,80})\}\s*$/.exec(text);
      task = { title: (id ? text.slice(0, id.index) : text).slice(0, 320), id: id?.[1] ?? null,
        state: states[state.toLowerCase()], by: null, from: null, evidence: null };
      component.tasks.push(task);
      continue;
    }
    const meta = /^(\s*)(files|needs|links|kind|tech|by|from|evidence):\s*(.+?)\s*$/.exec(line);
    if (!meta) continue;
    const [, indent, key, value] = meta;
    if (task && indent && ['by', 'from', 'evidence'].includes(key)) task[key] = value.slice(0, 240);
    else if (['files', 'needs', 'links'].includes(key)) component[key] = list(value).filter(entry => entry.length <= 160);
    else if (key === 'tech' || (key === 'kind' && ['human', 'knowledge'].includes(value))) component[key] = value.slice(0, 200);
  }
  for (const component of components) {
    const unresolved = [...new Set([...component.needs, ...component.links])].filter(id => !ids.has(id));
    if (unresolved.length && issues.length < 16) issues.push(`${component.id} references unknown components: ${unresolved.join(', ')}.`);
  }
  return { title, components, decisions, layers: dependencyLayers(components),
    issues: [...issues, ...dependencyWarnings(components)].slice(0, 16), clipped };
}

export function readPlan(cwd) {
  const text = readText(join(cwd, 'PLAN.md'), 256 * 1024);
  return text === null ? null : parsePlan(text);
}

export function plansComponent(plan, id) {
  return typeof id === 'string' && componentId.test(id) && plan?.components.some(component => component.id === id);
}

function compilePattern(pattern) {
  const path = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '/**');
  const parts = path.split('/');
  if (!parts.every(part => part && part !== '..' && part !== '.') || path.includes(':')) return null;
  return parts;
}

function matchSegment(pattern, value) {
  if (!/[?*]/.test(pattern)) return pattern === value;
  const tokens = Array.from(pattern);
  const chars = Array.from(value);
  let token = 0;
  let char = 0;
  let star = -1;
  let covered = 0;
  while (char < chars.length) {
    if (tokens[token] === '*') {
      star = token++;
      covered = char;
    } else if (tokens[token] === '?' || tokens[token] === chars[char]) {
      token++;
      char++;
    } else if (star >= 0) {
      token = star + 1;
      char = ++covered;
    } else return false;
  }
  while (tokens[token] === '*') token++;
  return token === tokens.length;
}

function matches(parts, file) {
  const segments = file.split('/');
  let positions = [0];
  for (const part of parts) {
    if (!positions.length) return false;
    positions = part === '**'
      ? Array.from({ length: segments.length - positions[0] + 1 }, (_, index) => positions[0] + index)
      : positions.filter(index => index < segments.length && matchSegment(part, segments[index])).map(index => index + 1);
  }
  return positions.includes(segments.length);
}

export function attachPlanChanges(plan, changes) {
  const patterns = new Map(plan.components.map(component => [component.id,
    component.files.map(compilePattern).filter(Boolean)]));
  return {
    ...plan,
    components: plan.components.map(component => ({ ...component,
      changes: changes.filter(change => patterns.get(component.id).some(parts =>
        matches(parts, change.path) || (change.previous && matches(parts, change.previous)))).slice(0, 24) }))
  };
}
