// Explicit anonymous GitHub reads. Constructing this module never makes a
// request; callers must supply a transport and initiate verification.
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { parseEvidenceUrl } from './plane-fixture.mjs';
import { problem } from './plane-journal-fixture.mjs';

const ORIGIN = 'https://api.github.com';
const LIMIT = 1024 * 1024;
const brands = new WeakSet();
const pathPattern = /^\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/(pulls\/[1-9][0-9]*|commits\/[a-f0-9]{40}))?$/;
const validPath = path => {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 512) return false;
  const match = typeof path === 'string' && pathPattern.exec(path);
  return !!match && match[2] !== '.' && match[2] !== '..';
};
export const isGitHubVerifier = value => brands.has(value);

// Direct Node HTTPS is opt-in. There is no proxy, credential, redirect, body
// logging or caller-provided host; bytes are capped while streaming.
export function createAnonymousGitHubTransport({ connect = httpsRequest } = {}) {
  if (typeof connect !== 'function') throw problem('invalid_input');
  return ({ method, origin, path, signal }) => new Promise((resolve, reject) => {
    if (method !== 'GET' || origin !== ORIGIN || !validPath(path)) return reject(problem('evidence_unverified'));
    let req, timer, settled=false;
    const finish=(fn,value)=>{ if (settled) return; settled=true; clearTimeout(timer); fn(value); };
    try {
      req = connect({ hostname:'api.github.com', protocol:'https:', method:'GET', path,
        agent:false, rejectUnauthorized:true, signal,
        headers:{ accept:'application/vnd.github+json', 'user-agent':'council-herdr' } }, res => {
        res.on('error', () => finish(reject,problem('offline')));
        res.on('aborted', () => finish(reject,problem('offline')));
        res.on('close', () => finish(reject,problem('offline')));
        const length=res.headers['content-length'];
        if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          finish(resolve,{status:res.statusCode,redirected:false,body:Buffer.alloc(0)}); res.destroy(); return;
        }
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length)>LIMIT)) {
          finish(reject,problem('evidence_unverified')); res.destroy(); return;
        }
        let size=0; const chunks=[];
        res.on('data', chunk => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { finish(reject,problem('evidence_unverified')); res.destroy(); req.destroy(); return; }
          size += chunk.length;
          if (size > LIMIT) { finish(reject,problem('evidence_unverified')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('end', () => finish(resolve,{status:res.statusCode,redirected:false,body:Buffer.concat(chunks,size)}));
      });
      req.on('error', () => finish(reject,problem('offline')));
      if (!settled) {
        timer=setTimeout(()=>{ finish(reject,problem('offline')); req.destroy(); },10000);
        req.end();
      }
    } catch { finish(reject,problem('offline')); }
  });
}

export function createGitHubVerifier({ registry, request, requestTimeoutMs = 10000, budgetMs = 60000 }) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).sort().join(',') !== 'fullName,id,public' || typeof registry.fullName !== 'string' || registry.fullName.length > 140 || typeof request !== 'function' ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000 ||
      !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) throw problem('invalid_input');
  const pin = structuredClone(registry);
  parseEvidenceUrl(`https://github.com/${pin.fullName}/pull/1`,pin);
  const [owner,repo] = pin.fullName.split('/');
  const root = `/repos/${owner}/${repo}`;
  if (!validPath(root)) throw problem('invalid_input');
  async function get(path, deadline) {
    const remaining = deadline - performance.now();
    if (!(remaining > 0)) throw problem('offline');
    const controller = new AbortController();
    let timer;
    try {
      const timeout = Math.max(1,Math.min(requestTimeoutMs,remaining));
      const requestDeadline = performance.now()+timeout;
      const result = await Promise.race([
        Promise.resolve().then(() => request({ method:'GET', origin:ORIGIN, path, signal:controller.signal })),
        new Promise((_,reject) => { timer=setTimeout(()=>{ controller.abort(); reject(problem('offline')); },timeout); })
      ]);
      if (performance.now() >= deadline || performance.now() >= requestDeadline) throw problem('offline');
      if (!result || result.status !== 200 || result.redirected !== false || !Buffer.isBuffer(result.body) || result.body.length > LIMIT) throw problem('evidence_unverified');
      let body;
      try { body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.body)); } catch { throw problem('evidence_unverified'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('evidence_unverified');
      return body;
    } catch (error) {
      if (error?.code === 'evidence_unverified') throw problem('evidence_unverified');
      throw problem('offline');
    } finally { clearTimeout(timer); }
  }
  const verifier = {
    matchesRegistry(value) { return !!value && Object.keys(value).sort().join(',') === 'fullName,id,public' && value.fullName === pin.fullName && value.id === pin.id && value.public === pin.public; },
    deadline() { return performance.now()+budgetMs; },
    assertDeadline(deadline) { if (!Number.isFinite(deadline) || performance.now() >= deadline) throw problem('offline'); },
    async verify(url, deadline = performance.now()+budgetMs) {
      if (!Number.isFinite(deadline)) throw problem('offline');
      deadline=Math.min(deadline,performance.now()+budgetMs);
      if (typeof url !== 'string' || Buffer.byteLength(url) > 300) throw problem('evidence_unverified');
      let parsed;
      try { parsed=parseEvidenceUrl(url,pin); } catch { throw problem('evidence_unverified'); }
      const repository = await get(root,deadline);
      if (repository.id !== pin.id || repository.full_name !== pin.fullName || repository.private !== false) throw problem('evidence_unverified');
      const path = `${root}/${parsed.kind === 'pull' ? `pulls/${parsed.reference}` : `commits/${parsed.reference}`}`;
      const evidence = await get(path,deadline);
      if (evidence.html_url !== url || (parsed.kind === 'pull' ?
        evidence.number !== Number(parsed.reference) || evidence.base?.repo?.id !== pin.id : evidence.sha !== parsed.reference)) throw problem('evidence_unverified');
      if (performance.now() >= deadline) throw problem('offline');
      return { url, repositoryId:pin.id, kind:parsed.kind, reference:parsed.reference };
    }
  };
  brands.add(verifier);
  return Object.freeze(verifier);
}
