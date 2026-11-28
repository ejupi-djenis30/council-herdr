import cp from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
if (process.env.HC_SESSION?.startsWith('cou7-win-x64-')) {
  const original = cp.spawnSync;
  cp.spawnSync = function (program, args, options) {
    if (/^(.*[\\/])?hc(?:\.exe)?$/i.test(program) && Array.isArray(args) && args[0] === 'run') {
      const command = args.indexOf('--') + 1;
      if (command > 0 && args[command] === 'junie') {
        if (!args.some(arg => arg.startsWith('--prompt=Council alignment check.'))) throw new Error('Unexpected fixture launch');
        const cwd = args[args.indexOf('--cwd') + 1];
        if (realpathSync.native(cwd).toLowerCase() !== realpathSync.native(join(root, 'ui-project')).toLowerCase()) throw new Error('Unexpected fixture project');
        appendFileSync(join(root, 'fixture-launches.jsonl'), JSON.stringify({ event: 'resolved' }) + '\n');
        args = args.with(command, join(root, 'bin', 'junie.cmd'));
      }
    }
    return original.call(this, program, args, options);
  };
  syncBuiltinESMExports();
}
