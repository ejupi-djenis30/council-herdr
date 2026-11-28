const fs = require('node:fs');
function records(path) {
  try { return fs.readFileSync(path, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
}
function evaluate(focusRows, inspectionRows) {
  const pre = focusRows.find(x => x.stage === 'preflight') ?? {};
  const input = focusRows.find(x => x.stage === 'native_input') ?? {};
  const focus = focusRows.find(x => x.stage === 'herdr_native_focus') ?? {};
  const app = inspectionRows.find(x => x.stage === 'desktop_owned_window') ?? {};
  const checks = {
    actorPermissions: pre.axTrusted === true && pre.postEvent === true && pre.onConsole === true && pre.loginDone === true && pre.displayCount > 0,
    ownedInput: input.pass === true && input.eventPosted === true && input.ownProcessFrontmost === true,
    ownAppWindow: app.pidExists === true && app.ownedOnScreenWindows === 1 && app.executingCpuType === 16777228,
    targetFocus: focus.pass === true && focus.targetWindowPidMatches === true && focus.targetFrontmost === true && focus.targetActive === true && focus.targetExecutingCpuType === 16777228,
    posixSession: Number.isInteger(focus.actorPosixSession) && focus.actorPosixSession > 0 && focus.actorPosixSession === focus.targetPosixSession
  };
  return { stage: 'ui_precondition', pass: Object.values(checks).every(Boolean), checks };
}
if (require.main === module) {
  const result = evaluate(records(process.argv[2]), records(process.argv[3]));
  console.log(JSON.stringify(result));
  process.exit(result.pass ? 0 : 1);
}
module.exports = { evaluate };
