// Desktop accepts a local wall time or an ISO timestamp. Verify its calendar fields before
// Date.parse can roll an impossible date or a missing daylight-saving hour into a different slot.
export function parseScheduleTime(value, { requireDateTime = false } = {}) {
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(text);
  if (requireDateTime && !match?.[4]) return NaN;
  if (!match) return Date.parse(text);
  const [, year, month, day, hour, minute, , zone] = match;
  const date = new Date(text.slice(0, 10) + 'T00:00:00Z');
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return NaN;
  const time = Date.parse(text.replace(' ', 'T'));
  if (hour && !zone && hour !== '24') {
    const local = new Date(time);
    if (local.getFullYear() !== Number(year) || local.getMonth() + 1 !== Number(month) || local.getDate() !== Number(day) ||
        local.getHours() !== Number(hour) || local.getMinutes() !== Number(minute)) return NaN;
  }
  return time;
}

export function fitsScheduleDates(first, everySec, count) {
  if (everySec === null) return true;
  const intervalMs = everySec * 1000;
  const finalSlot = (count ?? 2) - 1;
  return Number.isFinite(intervalMs) && Number.isFinite(new Date(first + intervalMs * finalSlot).getTime());
}

// Resolve wall time in Node on the project machine, which has its time zone's transition rules.
export function scheduleTiming({ firstRun, repeating, interval, runs }) {
  const first = firstRun === '' ? Date.now() : parseScheduleTime(firstRun, { requireDateTime: true });
  if (!Number.isFinite(first)) throw new Error('Enter an existing date and time as YYYY-MM-DD HH:mm on the project machine, or an ISO timestamp with a time zone.');
  const everySec = repeating ? Number(interval) : null;
  const count = repeating ? (runs.trim() ? Number(runs) : null) : 1;
  if (repeating && (!Number.isFinite(everySec) || everySec < 1)) throw new Error('Enter a repeat interval of at least one second.');
  if (count !== null && (!Number.isSafeInteger(count) || count < 1)) throw new Error('Enter a positive whole number of runs.');
  if (!fitsScheduleDates(first, everySec, count)) throw new Error('The repeat interval and run count exceed the supported date range.');
  return { at: new Date(first).toISOString(), everySec, count };
}
