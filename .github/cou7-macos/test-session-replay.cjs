const fs = require('node:fs');
const assert = require('node:assert/strict');
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const preflight = rows.find(row => row.stage === 'preflight');
const desktop = rows.find(row => row.stage === 'desktop_owned_window');
assert.equal(preflight.onConsole, null);
assert.equal(preflight.sessionDictionaryPresent, true);
assert.equal(preflight.displayCount, 1);
assert.equal(desktop.ownedOnScreenWindows, 1);
assert.equal(desktop.active, true);
// Apple's SDK defines kCGSessionOnConsoleKey as kCGSSessionOnConsoleKey.
const session = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true };
assert.equal(session.kCGSessionOnConsoleKey, undefined);
assert.equal(session.kCGSSessionOnConsoleKey, true);
assert.equal(session.kCGSessionLoginDoneKey, true);
const base = '/Users/runner/work/_temp/cou7-macos/home/state/herdr-core/';
const name = 'cou7-macos-46187851812';
const longest = Buffer.byteLength(`${base}${name}/${name}.holder.sock`) + 9;
assert.equal(longest, 124);
assert.ok(longest > 103);
const shortLongest = Buffer.byteLength('/tmp/c7.abcdefgh/c.holder.sock') + 9;
assert.ok(shortLongest <= 103);
console.log(JSON.stringify({ sourceRun: 'https://github.com/Ejupi-Labs/council-herdr/actions/runs/46187851812',
  observed: 'literal_key_null_with_visible_owned_window', fixture: 'SDK_constant_maps_to_double_S_key',
  result: 'legacy_lookup_absent_constant_lookup_true', nativeSessionValue: 'unverified_until_runner_retest',
  socketModel: { longest, max: 103, shortLongest, assumesRuntimeDirUnset: true, actualFirstError: 'not_captured' } }));
