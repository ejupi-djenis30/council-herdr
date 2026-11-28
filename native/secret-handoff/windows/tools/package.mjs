import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArm64Pe } from '../src/preflight.mjs';

const digest = b => createHash('sha256').update(b).digest('hex');
if (process.argv.length !== 5) throw new Error('Expected binary, build-info and new output directory');
const [, , binaryPath, buildInfoPath, output] = process.argv;
const build = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
if (build.schema !== 'council.synthetic-build/v1' || build.compiler !== 'msvc' ||
    build.compilerVersion !== '19.44.35228.0' || build.windowsSdkVersion !== '10.0.26100.0' || build.target !== 'windows-arm64')
  throw new Error('Unsupported build metadata');
const binary = readFileSync(binaryPath);
if (!isArm64Pe(binary) || binary.length > 16 * 1024 * 1024) throw new Error('Invalid ARM64 PE');
const preflight = readFileSync(fileURLToPath(new URL('../src/preflight.mjs', import.meta.url)));
const entries = [['council-handoff-probe.exe', binary], ['preflight.mjs', preflight]];
const manifest = Buffer.from(`${JSON.stringify({
  schema: 'council.synthetic-package/v1', packageVersion: '0.1.0-feasibility',
  target: { os: 'windows', arch: 'arm64' },
  toolchain: { compiler: build.compiler, compilerVersion: build.compilerVersion, windowsSdkVersion: build.windowsSdkVersion },
  artifacts: entries.map(([name, bytes]) => ({ name, size: bytes.length, sha256: digest(bytes) })),
}, null, 2)}\n`);
mkdirSync(output);
for (const [name, bytes] of entries) writeFileSync(join(output, name), bytes, { flag: 'wx' });
writeFileSync(join(output, 'manifest.json'), manifest, { flag: 'wx' });
writeFileSync(join(output, 'manifest.sha256'), `${digest(manifest)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ schema: 'council.synthetic-package-build/v1', manifestSha256: digest(manifest), artifactSha256: digest(binary) })}\n`);
