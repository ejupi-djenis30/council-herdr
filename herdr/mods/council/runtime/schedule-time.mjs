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
