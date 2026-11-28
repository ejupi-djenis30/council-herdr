// Fixture journal only. Native ownership, directory durability and ACLs are
// deployment gates; an injected fixture acknowledgement is not that proof.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const tupleDigest = value => digest(JSON.stringify(value));
export const problem = code => Object.assign(new Error(code), { code });
const equalKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

function bounded(path, limit) {
  const before = lstatSync(path, { bigint:true });
  if (!before.isFile() || before.isSymbolicLink()) throw problem('integrity_error');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint:true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw problem('integrity_error');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    const after = fstatSync(fd, { bigint:true });
    const pathAfter = lstatSync(path, { bigint:true });
    if (!size || size > limit || BigInt(size) !== opened.size || after.size !== opened.size ||
        pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || !pathAfter.isFile()) throw problem('integrity_error');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

function safeError(error) {
  return ['invalid_input','scope_conflict','not_found','stale_preview','integrity_error','storage_error','offline','evidence_unverified'].includes(error?.code)
    ? problem(error.code) : problem('storage_error');
}
export function fixtureJournal(options) {
  try { return makeFixtureJournal(options); } catch (error) { throw safeError(error); }
}
function makeFixtureJournal({ privateRoot, scope, fold, acknowledgeDirectory, hook = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(scope) || typeof fold !== 'function' || typeof acknowledgeDirectory !== 'function' || typeof hook !== 'function') throw problem('invalid_input');
  const root = realpathSync.native(privateRoot);
  const dir = join(root, scope);
  const binding = join(root, `${scope}.binding`);
  let existingBinding;
  try { existingBinding = bounded(binding, 4096); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const rootStat = statSync(root, { bigint:true });
  const dirStat = lstatSync(dir, { bigint:true });
  if (!rootStat.isDirectory() || !dirStat.isDirectory() || !rootStat.ino || !dirStat.ino) throw problem('integrity_error');
  const identity = { schema:'council.plane-fixture-directory/v1', scope, rootDev:String(rootStat.dev), rootIno:String(rootStat.ino),
    dirDev:String(dirStat.dev), dirIno:String(dirStat.ino) };
  const identityBytes = Buffer.from(JSON.stringify(identity));
  if (!existingBinding) {
    const temp = join(root, `.${randomUUID()}.binding-tmp`);
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd,identityBytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (acknowledgeDirectory('before','binding') !== true) throw problem('storage_error');
      try { linkSync(temp,binding); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (acknowledgeDirectory('after','binding') !== true) throw problem('storage_error');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  function verifyDirectory() {
    try {
      const rootNow = statSync(root, { bigint:true }), dirNow = lstatSync(dir, { bigint:true });
      if (!rootNow.isDirectory() || !dirNow.isDirectory() || String(rootNow.dev) !== identity.rootDev || String(rootNow.ino) !== identity.rootIno ||
          String(dirNow.dev) !== identity.dirDev || String(dirNow.ino) !== identity.dirIno || !bounded(binding,4096).equals(identityBytes)) throw problem('integrity_error');
    } catch { throw problem('integrity_error'); }
  }
  verifyDirectory();
  function read(allowPrefix = false) {
    verifyDirectory();
    const names = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
    if (names.length > 10000) throw problem('integrity_error');
    let previous = '0'.repeat(64);
    let state = fold(null, null);
    let sequence = 0;
    let integrity = null;
    for (let i = 0; i < names.length; i++) {
      try {
        if (names[i] !== `${String(i + 1).padStart(8, '0')}.json`) throw problem('integrity_error');
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bounded(join(dir, names[i]), 65536)));
        if (!equalKeys(event, ['schema','sequence','scope','previous','type','data','hash']) || event.schema !== 'council.plane-fixture-event/v1' ||
            event.sequence !== i + 1 || event.scope !== scope || event.previous !== previous ||
            event.hash !== tupleDigest([event.schema,event.sequence,event.scope,event.previous,event.type,event.data])) throw problem('integrity_error');
        // A failed fold must not partially change the returned prefix.
        state = fold(structuredClone(state), event);
        previous = event.hash;
        sequence++;
      } catch {
        if (!allowPrefix) throw problem('integrity_error');
        integrity = 'integrity_error';
        break;
      }
    }
    // Recovery may have observed a linked record whose original publication
    // acknowledgement was lost. The fixture must acknowledge the directory
    // again before treating that read as durable.
    verifyDirectory();
    if (acknowledgeDirectory('read', 'journal') !== true) throw problem('storage_error');
    return { state, sequence, previous, integrity };
  }
  function append(type, decide, beforeCommit = () => {}) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const head = read();
      const decision = decide(head.state);
      if (!decision || !Object.hasOwn(decision, 'data')) return { written: false, result: decision?.result };
      const event = { schema: 'council.plane-fixture-event/v1', sequence: head.sequence + 1, scope,
        previous: head.previous, type, data: decision.data };
      event.hash = tupleDigest([event.schema,event.sequence,event.scope,event.previous,event.type,event.data]);
      // Validate transitions before creating a durable record.
      fold(structuredClone(head.state), event);
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      const target = join(dir, `${String(event.sequence).padStart(8, '0')}.json`);
      let fd;
      try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(event)); fsyncSync(fd); closeSync(fd); fd = undefined;
        if (acknowledgeDirectory('before', type) !== true) throw problem('storage_error');
        hook('before_link', type);
        verifyDirectory();
        beforeCommit(event, head.state);
        try { linkSync(temporary, target); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        hook('after_link', type);
        if (acknowledgeDirectory('after', type) !== true) throw problem('storage_error');
        return { written: true, event };
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    throw problem('storage_error');
  }
  return {
    read() { try { return read(); } catch (error) { throw safeError(error); } },
    readPrefix() { try { return read(true); } catch (error) { throw safeError(error); } },
    append(type, decide, beforeCommit) { try { return append(type, decide, beforeCommit); } catch (error) {
      // Preserve the observed expiry timestamp for a durable retirement event.
      const safe = safeError(error);
      if (safe.code === 'stale_preview' && Number.isSafeInteger(error?.expiredAt)) safe.expiredAt = error.expiredAt;
      if (safe.code === 'stale_preview' && Number.isSafeInteger(error?.rollbackAt)) safe.rollbackAt = error.rollbackAt;
      throw safe;
    } }
  };
}
