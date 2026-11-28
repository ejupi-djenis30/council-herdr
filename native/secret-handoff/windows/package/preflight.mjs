import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const names = ['council-handoff-probe.exe', 'preflight.mjs'];
const requirements = ['protected_installation', 'dedicated_identities', 'managed_run_attestation', 'operator_surface_isolation', 'protected_custody', 'local_ipc_identity_qos', 'fixed_route'];

// This verifies package consistency, never provenance or permission to enable it.
export function isArm64Pe(bytes) {
  if (bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const p = bytes.readUInt32LE(0x3c);
  if (p < 64 || p > bytes.length - 24 || bytes.readUInt32LE(p) !== 0x4550 ||
      bytes.readUInt16LE(p + 4) !== 0xaa64 || (bytes.readUInt16LE(p + 22) & 0x2002) !== 0x0002) return false;
  const sections = bytes.readUInt16LE(p + 6);
  const optionalSize = bytes.readUInt16LE(p + 20);
  const optional = p + 24;
  if (sections < 1 || sections > 96 || optionalSize < 112 || optionalSize > bytes.length - optional ||
      bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) > Math.floor((optionalSize - 112) / 8)) return false;
  const table = optional + optionalSize;
  const tableEnd = table + sections * 40;
  const headerSize = bytes.readUInt32LE(optional + 60);
  if (tableEnd > bytes.length || headerSize < tableEnd || headerSize > bytes.length) return false;
  for (let i = 0; i < sections; i++) {
    const entry = table + i * 40;
    const size = bytes.readUInt32LE(entry + 16);
    const offset = bytes.readUInt32LE(entry + 20);
    if (size && (offset < headerSize || offset > bytes.length || size > bytes.length - offset)) return false;
  }
  return true;
}

function readBounded(folder, name, max, io) {
  const path = join(folder, name);
  const before = io.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('invalid');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = io.openSync(path, flags);
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.size > max || stat.size < 1 ||
        (before.ino && stat.ino && (before.ino !== stat.ino || before.dev !== stat.dev))) throw new Error('invalid');
    const bytes = Buffer.allocUnsafe(max + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = io.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = io.fstatSync(fd);
    if (length !== stat.size || length > max || after.size !== stat.size) throw new Error('invalid');
    return bytes.subarray(0, length);
  } finally {
    io.closeSync(fd);
  }
}

function manifestValid(m) {
  const keys = (v, expected) => v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).sort().join(',') === [...expected].sort().join(',');
  return keys(m, ['schema', 'packageVersion', 'target', 'toolchain', 'artifacts']) &&
    m.schema === 'council.synthetic-package/v1' && m.packageVersion === '0.1.0-feasibility' &&
    keys(m.target, ['os', 'arch']) && m.target.os === 'windows' && m.target.arch === 'arm64' &&
    keys(m.toolchain, ['compiler', 'compilerVersion', 'windowsSdkVersion']) &&
    m.toolchain.compiler === 'msvc' && m.toolchain.compilerVersion === '19.44.35228.0' && m.toolchain.windowsSdkVersion === '10.0.26100.0' &&
    Array.isArray(m.artifacts) && m.artifacts.length === names.length && m.artifacts.every((a, i) =>
      keys(a, ['name', 'size', 'sha256']) && a.name === names[i] && Number.isSafeInteger(a.size) && a.size > 0 &&
      a.size <= 16 * 1024 * 1024 && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256));
}

export function inspectPackage(folder, options = {}) {
  const io = options.io ?? fs;
  const host = options.host ?? (() => ({ platform: process.platform, arch: process.arch, machine: os.machine() }));
  let platform = 'unverifiable';
  try {
    const h = host();
    if (typeof h.platform === 'string' && typeof h.arch === 'string' && typeof h.machine === 'string')
      platform = h.platform === 'win32' && h.arch === 'arm64' && h.machine.toLowerCase() === 'arm64' ? 'supported' : 'unsupported';
  } catch { /* No raw host diagnostics are returned. */ }
  let code = 'passed';
  let stage = 'manifest';
  try {
    const bytes = readBounded(folder, 'manifest.json', 16384, io);
    const expected = decoder.decode(readBounded(folder, 'manifest.sha256', 128, io)).trim();
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(bytes) !== expected) throw new Error('digest');
    const m = JSON.parse(decoder.decode(bytes));
    if (!manifestValid(m)) throw new Error('invalid');
    stage = 'artifact';
    for (const artifact of m.artifacts) {
      const contents = readBounded(folder, artifact.name, 16 * 1024 * 1024, io);
      if (contents.length !== artifact.size || hash(contents) !== artifact.sha256 ||
        (artifact.name.endsWith('.exe') && !isArm64Pe(contents))) throw new Error('mismatch');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') code = `${stage}_missing`;
    else if (error?.code && error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') code = 'unverifiable';
    else if (error.message === 'digest') code = 'manifest_digest_mismatch';
    else code = stage === 'manifest' ? 'manifest_invalid' : 'artifact_mismatch';
  }
  return {
    schema: 'council.synthetic-preflight/v1',
    platform: { status: platform },
    package: { status: code === 'passed' ? 'passed' : code === 'unverifiable' ? 'unverifiable' : 'failed', code },
    prerequisites: [
      { id: 'package_consistency', status: code === 'passed' ? 'verified' : code.endsWith('_missing') ? 'missing' : code === 'unverifiable' ? 'unverified' : 'failed' },
      { id: 'native_platform', status: platform === 'supported' ? 'verified' : platform === 'unsupported' ? 'failed' : 'unverified' },
      ...requirements.map(id => ({ id, status: 'unverified' })),
    ],
    readiness: { status: 'unverified' },
    availability: { available: false, code: 'disabled_by_default' },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    process.stdout.write('{"schema":"council.synthetic-preflight/v1","error":"invalid_input","availability":{"available":false}}\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify(inspectPackage(dirname(fileURLToPath(import.meta.url))))}\n`);
  }
}
