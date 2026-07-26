'use strict';

/*
 * Sanctions + export-control screening server (OFAC/EU/UN/UK + BIS/State).
 *
 *   node server.js            → live by default: serve cache instantly, refresh in background
 *   node server.js --demo     → offline: serve the fictional demo sample only
 *
 * Endpoints:
 *   GET  /healthz                        liveness + snapshot summary
 *   GET  /api/meta                       snapshot provenance + lists/programs + loading
 *   GET  /api/stats                      list composition, designation timeline, recent additions
 *   GET  /api/search?q=&authority=&list=&program=&threshold=&yob=&country=  screening
 *   GET  /api/graph/ego-network?id=&depth=   relationship ego-network
 *   POST /api/refresh                    trigger a background live refresh (admin-gated)
 *
 * Public-facing hardening: security headers, per-IP rate limiting, input caps,
 * a short query-result cache, path-traversal-safe static serving, top-level
 * error handling (no crash on a bad request), and graceful shutdown. Terminate
 * TLS at a reverse proxy in front of this process.
 *
 * Compliance posture: results are ANALYSIS, not legal advice; the UI shows the
 * snapshot provenance so any determination is reproducible. Search queries are
 * never logged (they may contain personal names).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
const { screenEntity } = require('./lib/matcher');
const { finalizeSnapshot, readCache } = require('./lib/ingest');
const { egoNetwork } = require('./lib/graph');
const { createLimiter } = require('./lib/ratelimit');
const { snapshotStats } = require('./lib/stats');
const searchIndex = require('./lib/searchindex');

// ---- config (env-overridable) ----
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TTL_MS = Number(process.env.CACHE_TTL_MS) || 12 * 60 * 60 * 1000;
const DEMO_ONLY = process.argv.includes('--demo');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // if empty, manual /api/refresh is disabled
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_Q = 120, MAX_FIELD = 80;
const MAX_RESULTS = 200; // top-scoring slice returned; payload reports the true total

const apiLimiter = createLimiter({ windowMs: 60000, max: Number(process.env.RATE_MAX) || 120 });
const searchLimiter = createLimiter({ windowMs: 60000, max: Number(process.env.SEARCH_RATE_MAX) || 30 });

let snapshot = loadSampleSnapshot();
let loading = false;

function loadSampleSnapshot() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-data', 'sample.json'), 'utf8'));
  return finalizeSnapshot(raw.entities, {
    source: 'DEMO / OFFLINE SAMPLE — fictional, not real sanctions data',
    publicationId: 'demo', retrievedAt: new Date().toISOString(), isLive: false,
  });
}

function startRefresh() {
  if (loading || DEMO_ONLY) return;
  loading = true;
  queryCache.clear();
  console.log('Live refresh started in background worker…');
  // Cap the worker heap so the fetch+parse GCs aggressively instead of pushing
  // the container over its memory limit (Render free = 512MB total).
  const w = new Worker(path.join(__dirname, 'lib', 'snapshot-worker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: 300 },
  });
  w.on('message', (m) => {
    loading = false;
    if (m.ok) { const c = readCache(); if (c) { snapshot = c.snapshot; queryCache.clear(); warmIndex(); console.log(`Live snapshot ready: ${m.count} entities (pub ${m.publicationId}) in ${(m.ms / 1000).toFixed(0)}s`); } }
    else console.warn(`Live refresh failed: ${m.error}. Keeping current snapshot.`);
    w.terminate();
  });
  w.on('error', (e) => { loading = false; console.warn('Worker error:', e.message); });
}

// ---- helpers ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };

function securityHeaders() {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

function clientIp(req) {
  if (TRUST_PROXY) { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); }
  return req.socket.remoteAddress || '?';
}

// JSON responses are gzipped when the client accepts it and the body is worth
// compressing — /api/stats alone is ~96KB of highly repetitive JSON, and it is
// fetched on every insights page load.
function sendJson(res, code, obj, extra, req) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    securityHeaders(), extra || {},
  );
  if (req && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(code, headers);
  res.end(body);
}

function meta() {
  return {
    source: snapshot.source, isLive: !!snapshot.isLive, loading,
    canRefresh: !!ADMIN_TOKEN && !DEMO_ONLY,
    publicationId: snapshot.publicationId, publishedDate: snapshot.publishedDate || '',
    publications: snapshot.publications || [],
    retrievedAt: snapshot.retrievedAt,
    count: snapshot.count, lists: snapshot.lists, programs: snapshot.programs, authorities: snapshot.authorities || [],
  };
}

// ---- search (with a result cache + candidate prefilter) ----
// The snapshot is immutable and only changes on a refresh, which clears this
// cache, so a longer TTL cannot serve stale results — and repeat traffic on the
// same handful of names is most of the load.
const queryCache = new Map(); // key -> { t, payload }
const QCACHE_TTL = 10 * 60 * 1000, QCACHE_MAX = 500;

// Candidate index, rebuilt whenever the snapshot object changes.
let index = null, indexedSnapshot = null;
function ensureIndex() {
  if (indexedSnapshot !== snapshot) {
    const t = Date.now();
    index = searchIndex.build(snapshot.entities);
    indexedSnapshot = snapshot;
    console.log(`Search index built: ${snapshot.count} entities in ${Date.now() - t}ms`);
  }
  return index;
}

// Build it off the back of boot instead of inside the first search: it takes
// ~1.5s over 38k entities, and making the first visitor of a cold instance pay
// for that is most of why the app feels slow after a restart.
//
// Deliberately delayed rather than immediate: parsing the cached snapshot
// leaves ~200MB of short-lived garbage, and building the index on top of it
// before that is collected pushes peak memory up on a small container. A few
// seconds later the heap has settled and the build costs only what it keeps.
const INDEX_WARM_DELAY_MS = 4000;
function warmIndex() {
  setTimeout(() => {
    try { ensureIndex(); } catch (e) { console.warn('index warm-up failed:', e.message); }
  }, INDEX_WARM_DELAY_MS).unref();
}

function search(params) {
  const q = (params.get('q') || '').trim().slice(0, MAX_Q);
  const listFilter = (params.get('list') || '').slice(0, MAX_FIELD);
  const programFilter = (params.get('program') || '').slice(0, MAX_FIELD);
  const authorityFilter = (params.get('authority') || '').slice(0, MAX_FIELD);
  // Number(), not `parseFloat(...) || 0.95`: threshold=0 is falsy, so the old
  // form turned "widen the net as far as it goes" into the NARROWEST setting.
  const rawThreshold = (params.get('threshold') || '').trim();
  const parsedThreshold = rawThreshold === '' ? NaN : Number(rawThreshold);
  const threshold = Number.isFinite(parsedThreshold) ? Math.min(1, Math.max(0.8, parsedThreshold)) : 0.95;
  const yob = /^\d{4}$/.test(params.get('yob') || '') ? params.get('yob') : '';
  const country = (params.get('country') || '').trim().slice(0, MAX_FIELD);
  const mods = (yob || country) ? { yob, country } : null;

  if (!q) return { query: q, threshold, count: 0, results: [], snapshot: meta() };

  const key = `${snapshot.publicationId}|${q}|${listFilter}|${programFilter}|${authorityFilter}|${threshold}|${yob}|${country}`;
  const cached = queryCache.get(key);
  if (cached && Date.now() - cached.t < QCACHE_TTL) return cached.payload;

  // At the default threshold the candidate index is recall-safe: every channel
  // that can reach 0.95 is reproducible from it (see the invariant in
  // lib/searchindex, checked by scripts/verify-recall.js). Below the default —
  // an analyst deliberately widening the net — we scan the full list, because
  // no cheap index covers what the scorer will accept down there.
  ensureIndex();
  const cand = threshold >= 0.95 ? searchIndex.candidates(index, q) : null;
  const pool = cand ? cand.map((i) => snapshot.entities[i]) : snapshot.entities;

  const results = [];
  for (const e of pool) {
    if (authorityFilter && e.authority !== authorityFilter) continue;
    if (listFilter && e.list !== listFilter) continue;
    if (programFilter && !e.programs.includes(programFilter)) continue;
    const m = screenEntity(q, e, threshold, mods);
    if (!m) continue;
    results.push({
      id: e.id, name: e.name, authority: e.authority, list: e.list, type: e.type, title: e.title,
      programs: e.programs, sanctionsTypes: e.sanctionsTypes || (e.sanctionsType ? [e.sanctionsType] : []),
      legalAuthorities: e.legalAuthorities || [], datePublished: e.datePublished,
      names: e.names, addresses: e.addresses, idDocuments: e.idDocuments || [],
      relationships: e.relationships || [], attributes: e.attributes, identifiers: e.identifiers, remarks: e.remarks,
      score: m.score, matchType: m.matchType, matchedName: m.matchedName, matchedField: m.matchedField,
      explain: m.explain || '', corroborated: !!m.corroborated, conflict: !!m.conflict,
    });
  }
  results.sort((a, b) => b.score - a.score);
  // `count` is every hit above the threshold; `results` is the top slice. The
  // UI must show the former and say when it is showing fewer — an analyst who
  // reads "200 matches" when 573 cleared the threshold has been misinformed.
  const payload = {
    query: q, threshold, count: results.length,
    returned: Math.min(results.length, MAX_RESULTS), truncated: results.length > MAX_RESULTS,
    results: results.slice(0, MAX_RESULTS), snapshot: meta(),
  };

  queryCache.set(key, { t: Date.now(), payload });
  if (queryCache.size > QCACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  return payload;
}

// ---- static (path-traversal safe + cache headers + optional gzip) ----
function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/') rel = '/index.html';
  if (rel.includes('\0')) { res.writeHead(400, securityHeaders()); return res.end('Bad request'); }
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, securityHeaders()); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders())); return res.end('Not found'); }
    const ext = path.extname(filePath);
    // HTML/CSS/JS revalidate each load (unhashed filenames → avoid stale-after-deploy);
    // static assets (icons/text) may be cached.
    const cache = ['.html', '.css', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    const headers = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache }, securityHeaders());
    const enc = req.headers['accept-encoding'] || '';
    if (/\bgzip\b/.test(enc) && /text|javascript|json|svg/.test(headers['Content-Type']) && data.length > 1024) {
      headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers); return res.end(zlib.gzipSync(data));
    }
    res.writeHead(200, headers); res.end(data);
  });
}

// ---- request router ----
function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = clientIp(req);

  if (p === '/healthz') return sendJson(res, 200, { status: 'ok', live: !!snapshot.isLive, loading, entities: snapshot.count });

  if (p.startsWith('/api/')) {
    const rl = apiLimiter.check(ip);
    if (!rl.ok) return sendJson(res, 429, { error: 'rate limit exceeded' }, { 'Retry-After': String(rl.retryAfter) });

    // Read-only endpoints: GET and HEAD only, uniformly.
    const readOnly = req.method === 'GET' || req.method === 'HEAD';

    if (p === '/api/meta') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, meta(), null, req);
    }

    // Aggregate list composition + most-recent designations. Memoized per
    // snapshot in lib/stats, so this is a map lookup after the first call.
    if (p === '/api/stats') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      const s = snapshotStats(snapshot);
      return sendJson(res, 200, Object.assign({ loading }, s), null, req);
    }

    if (p === '/api/search') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      const sr = searchLimiter.check(ip);
      if (!sr.ok) return sendJson(res, 429, { error: 'search rate limit exceeded' }, { 'Retry-After': String(sr.retryAfter) });
      return sendJson(res, 200, search(url.searchParams), null, req);
    }

    if (p === '/api/graph/ego-network') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      const id = (url.searchParams.get('id') || '').slice(0, 40);
      const depth = Math.min(3, Math.max(1, parseInt(url.searchParams.get('depth')) || 2));
      if (!/^[\w:.-]+$/.test(id)) return sendJson(res, 400, { error: 'invalid id' });
      const g = egoNetwork(snapshot.entities, id, depth);
      if (!g) return sendJson(res, 404, { error: 'entity not found in snapshot' });
      g.snapshot = meta();
      return sendJson(res, 200, g, null, req);
    }

    if (p === '/api/refresh') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (DEMO_ONLY) return sendJson(res, 200, { ok: false, error: 'server started with --demo (offline)', meta: meta() });
      if (!ADMIN_TOKEN) return sendJson(res, 403, { ok: false, error: 'manual refresh disabled (auto-refreshes on a schedule)', meta: meta() });
      const tok = url.searchParams.get('token') || req.headers['x-admin-token'] || '';
      if (tok !== ADMIN_TOKEN) return sendJson(res, 401, { ok: false, error: 'unauthorized', meta: meta() });
      startRefresh();
      return sendJson(res, 200, { ok: true, loading: true, meta: meta() });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, securityHeaders()); return res.end('Method not allowed'); }
  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    // Access log WITHOUT query string (queries may contain personal names).
    const p = (req.url || '').split('?')[0];
    console.log(`${clientIp(req)} ${req.method} ${p} ${res.statusCode} ${Date.now() - started}ms`);
  });
  try { handle(req, res); }
  catch (e) {
    console.error('handler error:', e && e.stack || e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;

// Never let one bad request take the process down.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.stack || e));

function shutdown(sig) {
  console.log(`${sig} received — shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  const cached = DEMO_ONLY ? null : readCache();
  if (cached) { snapshot = cached.snapshot; console.log(`Loaded cached snapshot: ${snapshot.source} (${snapshot.count} entities)`); }
  console.log(`Sanctions screening on http://${HOST}:${PORT}  (live=${!DEMO_ONLY}, admin-refresh=${ADMIN_TOKEN ? 'on' : 'off'})`);
  console.log(`Snapshot: ${snapshot.source} (${snapshot.count} entities)`);
  warmIndex();
  if (!DEMO_ONLY) {
    const stale = !cached || cached.ageMs > TTL_MS;
    if (stale) startRefresh();
    else console.log(`Cache fresh (${(cached.ageMs / 3600000).toFixed(1)}h old) — no refresh needed.`);
  }
});
