import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectPackage } from '../../native/secret-handoff/windows/src/preflight.mjs';

const source = resolve('native/secret-handoff/windows/package');
const digest = b => createHash('sha256').update(b).digest('hex');
const supported = () => ({ platform: 'win32', arch: 'arm64', machine: 'arm64' });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'council-feasibility-'));
  const folder = join(root, 'package');
  cpSync(source, folder, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return folder;
}
function manifest(folder, mutate) {
  const p = join(folder, 'manifest.json');
  const m = JSON.parse(readFileSync(p));
  mutate(m);
  const bytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(p, bytes);
  writeFileSync(join(folder, 'manifest.sha256'), `${digest(bytes)}\n`);
}
function inspect(folder, host = supported, io) { return inspectPackage(folder, { host, ...(io ? { io } : {}) }); }

test('coherent package remains disabled and unverified; inspection makes no writes', t => {
  const folder = fixture(t);
  const names = ['manifest.json', 'manifest.sha256', 'preflight.mjs', 'council-handoff-probe.exe'];
  const before = names.map(n => [readFileSync(join(folder, n)), statSync(join(folder, n)).mtimeMs]);
  const result = inspect(folder);
  assert.deepEqual(result.platform, { status: 'supported' });
  assert.deepEqual(result.package, { status: 'passed', code: 'passed' });
  assert.deepEqual(result.availability, { available: false, code: 'disabled_by_default' });
  assert.equal(result.readiness.status, 'unverified');
  assert.equal(result.prerequisites.find(p => p.id === 'package_consistency').status, 'verified');
  assert.equal(result.prerequisites.find(p => p.id === 'protected_custody').status, 'unverified');
  assert.deepEqual(names.map(n => [readFileSync(join(folder, n)), statSync(join(folder, n)).mtimeMs]), before);
  assert.ok(!JSON.stringify(result).includes(folder));
});

test('unsupported and unverifiable host detections never enable the feature', t => {
  const folder = fixture(t);
  for (const host of [() => ({ platform: 'linux', arch: 'arm64', machine: 'arm64' }),
    () => ({ platform: 'win32', arch: 'x64', machine: 'arm64' }),
    () => ({ platform: 'win32', arch: 'arm64', machine: 'x64' })]) {
    assert.equal(inspect(folder, host).platform.status, 'unsupported');
    assert.equal(inspect(folder, host).availability.available, false);
  }
  assert.equal(inspect(folder, () => { throw Error('private detail'); }).platform.status, 'unverifiable');
});

test('missing, malformed and invalid manifest and digest fail closed', t => {
  for (const scenario of ['missing', 'badDigest', 'invalidJson', 'invalidSchema', 'invalidUtf8']) {
    const folder = fixture(t);
    const p = join(folder, 'manifest.json');
    if (scenario === 'missing') unlinkSync(p);
    if (scenario === 'badDigest') writeFileSync(join(folder, 'manifest.sha256'), 'a'.repeat(64));
    if (scenario === 'invalidJson' || scenario === 'invalidUtf8') {
      const bytes = scenario === 'invalidJson' ? Buffer.from('{') : Buffer.from([255]);
      writeFileSync(p, bytes); writeFileSync(join(folder, 'manifest.sha256'), digest(bytes));
    }
    if (scenario === 'invalidSchema') manifest(folder, m => { m.target.arch = 'x64'; });
    const result = inspect(folder);
    assert.equal(result.package.status, 'failed', scenario);
    if (scenario === 'missing') assert.equal(result.prerequisites.find(p => p.id === 'package_consistency').status, 'missing');
    assert.equal(result.availability.available, false);
  }
});

test('missing, altered, and non-ARM64 artifacts fail closed', t => {
  for (const scenario of ['missing', 'altered', 'wrongPe']) {
    const folder = fixture(t);
    const p = join(folder, 'council-handoff-probe.exe');
    if (scenario === 'missing') unlinkSync(p);
    if (scenario === 'altered') writeFileSync(p, Buffer.from('altered'));
    if (scenario === 'wrongPe') {
      const bytes = readFileSync(p); bytes.writeUInt16LE(0x8664, bytes.readUInt32LE(0x3c) + 4); writeFileSync(p, bytes);
      manifest(folder, m => { m.artifacts[0].sha256 = digest(bytes); });
    }
    const result = inspect(folder);
    assert.equal(result.package.status, 'failed', scenario);
    assert.equal(result.availability.available, false);
  }
});

test('inaccessible package is unverifiable and does not disclose the error', t => {
  const folder = fixture(t);
  const io = { lstatSync() { throw Object.assign(new Error('private detail'), { code: 'EACCES' }); }, readFileSync };
  const result = inspect(folder, supported, io);
  assert.deepEqual(result.package, { status: 'unverifiable', code: 'unverifiable' });
  assert.equal(result.prerequisites.find(p => p.id === 'package_consistency').status, 'unverified');
  assert.ok(!JSON.stringify(result).includes('private detail'));
  assert.equal(result.availability.available, false);
});

test('checked-in package contains the matching preflight source and real ARM64 PE', () => {
  assert.deepEqual(readFileSync(join(source, 'preflight.mjs')), readFileSync(resolve('native/secret-handoff/windows/src/preflight.mjs')));
  assert.equal(inspect(source).package.code, 'passed');
});

test('native ARM64 executable reports only fixed metadata and rejects arguments', { skip: process.platform !== 'win32' || process.arch !== 'arm64' }, () => {
  const exe = join(source, 'council-handoff-probe.exe');
  const ok = spawnSync(exe, [], { encoding: 'utf8' });
  assert.equal(ok.status, 0); assert.equal(ok.stderr, '');
  assert.deepEqual(JSON.parse(ok.stdout), { schema: 'council.synthetic-native-probe/v1', status: 'supported', available: false });
  const bad = spawnSync(exe, ['private-canary'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.ok(!bad.stdout.includes('private-canary'));
  assert.equal(JSON.parse(bad.stdout).available, false);
});
