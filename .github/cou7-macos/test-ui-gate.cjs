const assert = require('node:assert/strict');
const fs = require('node:fs');
const { evaluate } = require('./ui-gate.cjs');
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const pre = rows.find(x => x.stage === 'preflight');
const input = rows.find(x => x.stage === 'native_input');
const app = rows.find(x => x.stage === 'desktop_owned_window');
assert.equal(input.pass, true);
assert.equal(app.ownedOnScreenWindows, 1);
const simulatedFocus = { stage: 'herdr_native_focus', pass: true, targetWindowPidMatches: true, targetFrontmost: true,
  targetActive: true, targetExecutingCpuType: 16777228, actorPosixSession: 1, targetPosixSession: 1 };
assert.equal(evaluate([pre, input, simulatedFocus], [app]).pass, true);
for (const bad of [
  { ...simulatedFocus, pass: false }, { ...simulatedFocus, targetWindowPidMatches: false },
  { ...simulatedFocus, targetExecutingCpuType: 7 }, { ...simulatedFocus, targetPosixSession: 2 }
]) assert.equal(evaluate([pre, input, bad], [app]).pass, false);
assert.equal(evaluate([pre, { ...input, eventPosted: false }, simulatedFocus], [app]).pass, false);
assert.equal(evaluate([pre, input, simulatedFocus], [{ ...app, ownedOnScreenWindows: 0 }]).pass, false);
console.log(JSON.stringify({ sourceRun:'https://github.com/Ejupi-Labs/council-herdr/actions/runs/46188198212',
  observed:'owned_native_input_and_Herdr_window', focus:'simulated_only', cases:'positive_and_six_negative',
  actualTargetFocus:'not_yet_tested', mutationActuallyEmitted:false }));
