// Compatibility entry point for installed panels from before the bundled runtime.
import { desktopRequest } from './mods/council/runtime/desktop.mjs';

try {
  const [action, payload] = process.argv.slice(2);
  const result = desktopRequest(process.cwd(), action, JSON.parse(payload ?? '{}'));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
