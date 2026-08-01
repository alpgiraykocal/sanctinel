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
 *   GET  /api/ownership?id=              50% Rule: chains to a blocked owner
 *   GET  /api/entity?id=                 one party by id (permalink target)
 *   GET  /api/below-the-line?q=&threshold=   hit counts per threshold + the marginal hits
 *   GET  /api/changes                    parties added/removed by the last rebuild
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
const { finalizeSnapshot, readCache, EXPECTED_AUTHORITIES } = require('./lib/ingest');
const { egoNetwork } = require('./lib/graph');
const { profile: ownershipProfile, summary: ownershipSummary, clusterOf: ownershipCluster } = require('./lib/ownership');
// Written by scripts/build-cache.js when it replaces the snapshot.
const CHANGES_PATH = path.join(__dirname, 'cache', 'changes.json');
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
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function securityHeaders() {
  return {
    // No third-party origins at all. The fonts used to come from
    // fonts.googleapis.com / fonts.gstatic.com, which handed Google the IP and
    // User-Agent of everyone who opened a sanctions-screening tool. They are
    // served from public/fonts/ now, so the policy has no external host left to
    // allow — and anything that tries to add one fails loudly instead of
    // quietly phoning home.
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
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

/*
 * Authorities a complete snapshot carries, minus the ones this snapshot
 * actually has. Reported to the client so the UI can say WHICH lists are not
 * being screened right now — a screening tool that quietly covers less than it
 * claims is worse than one that is visibly down, because the user reads an
 * empty result as "clear" either way.
 *
 * Computed from the entities present rather than from the source log, so a
 * snapshot built before source tracking existed still reports its gaps.
 */
function missingAuthorities() {
  if (!snapshot.isLive) return [];
  const have = new Set(snapshot.authorities || []);
  return EXPECTED_AUTHORITIES.filter((a) => !have.has(a));
}

function meta() {
  const missing = missingAuthorities();
  return {
    source: snapshot.source, isLive: !!snapshot.isLive, loading,
    canRefresh: !!ADMIN_TOKEN && !DEMO_ONLY,
    publicationId: snapshot.publicationId, publishedDate: snapshot.publishedDate || '',
    publications: snapshot.publications || [],
    retrievedAt: snapshot.retrievedAt,
    count: snapshot.count, lists: snapshot.lists, programs: snapshot.programs, authorities: snapshot.authorities || [],
    missingAuthorities: missing,
    // Why each one is missing, when the snapshot recorded it.
    sourceFailures: (snapshot.sources || []).filter((s) => !s.ok).map((s) => ({ label: s.label, authorities: s.authorities, error: s.error })),
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

/*
 * Below-the-line testing.
 *
 * Tuning a match threshold without seeing what falls just under it is exactly
 * the practice regulators criticise: the false-positive side of the trade costs
 * review time, but the false-negative side is a strict-liability violation, so
 * a threshold change has to be justified by looking at the hits it would drop.
 * The app told analysts to do this ("below-the-line testing required before any
 * production change") while giving them no way to actually do it.
 *
 * One full scan at the slider's floor produces both halves of the answer: a
 * count at every step, and the actual records sitting between the floor and the
 * active threshold. It is deliberately a separate, opt-in request — the default
 * search stays on the recall-safe fast index, and this one cannot use it.
 */
const BTL_FLOOR = 0.8;      // the slider minimum
const BTL_STEP = 0.01;
const BTL_MAX_MARGINAL = 50;
const BTL_MAX_PREFIX = 25;

/*
 * What kind of identifier the query looks like.
 *
 * A vessel screened by IMO that returns nothing reads as "not listed". The
 * truth may be that the snapshot carries an IMO for 41 of 31,954 parties, which
 * is a completely different statement. Naming the interpretation and its
 * coverage turns a silent miss into a fact the user can act on.
 */
function identifierShape(q) {
  const raw = q.trim();
  const bare = raw.replace(/[^A-Za-z0-9]/g, '');
  if (/^IMO/i.test(raw) && /^\d{7}$/.test(bare.replace(/^IMO/i, ''))) return 'IMO';
  if (/^\d{7}$/.test(bare)) return 'IMO';
  if (/^\d{9}$/.test(bare)) return 'MMSI';
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return 'Digital currency address';
  if (/^[13bA-Za-z][a-km-zA-HJ-NP-Z0-9]{25,60}$/.test(raw) && /\d/.test(raw) && /[A-Z]/.test(raw) && /[a-z]/.test(raw)) return 'Digital currency address';
  return null;
}

// How many parties in this snapshot carry each identifier type. Memoized per
// snapshot object; a refresh swaps the array and the cache falls away with it.
let idCoverageFor = null, idCoverageCache = null;
function identifierCoverage() {
  if (idCoverageFor !== snapshot.entities) {
    const counts = new Map();
    for (const e of snapshot.entities) {
      const seen = new Set();
      for (const id of e.identifiers || []) {
        const t = String(id.type || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    idCoverageCache = counts;
    idCoverageFor = snapshot.entities;
  }
  return idCoverageCache;
}

function belowTheLine(params) {
  const q = (params.get('q') || '').trim().slice(0, MAX_Q);
  const listFilter = (params.get('list') || '').slice(0, MAX_FIELD);
  const programFilter = (params.get('program') || '').slice(0, MAX_FIELD);
  const authorityFilter = (params.get('authority') || '').slice(0, MAX_FIELD);
  const parsed = Number((params.get('threshold') || '').trim());
  const active = Number.isFinite(parsed) ? Math.min(1, Math.max(BTL_FLOOR, parsed)) : 0.95;
  const yob = /^\d{4}$/.test(params.get('yob') || '') ? params.get('yob') : '';
  const country = (params.get('country') || '').trim().slice(0, MAX_FIELD);
  const mods = (yob || country) ? { yob, country } : null;

  if (!q) return { query: q, active, floor: BTL_FLOOR, steps: [], marginal: [], marginalCount: 0, snapshot: meta() };

  const buckets = new Map();  // threshold step -> number of hits at or above it
  const marginal = [];
  let marginalCount = 0;

  /*
   * Literal "starts with", collected in the same pass.
   *
   * The scorer has no prefix channel — "Gazpr" scores nothing against GAZPROM
   * because a truncated token is not a near-miss under any of its similarity
   * measures — yet typing half a company name is what people actually do. This
   * is deliberately a plain string test rather than a new scoring channel: it
   * stays outside the score, so it cannot disturb the threshold or the
   * candidate index's recall invariant, and it is labelled as what it is.
   */
  const prefixQ = q.trim().toUpperCase();
  const usePrefix = /^[^\s]+$/.test(prefixQ) && prefixQ.length >= 3;
  const prefixHits = [];
  let prefixCount = 0;
  const startsWithQuery = (name) => {
    const n = String(name || '').toUpperCase();
    if (n.startsWith(prefixQ)) return true;
    // A token boundary inside the name, so "GAZPR" reaches
    // "PUBLIC JOINT STOCK COMPANY GAZPROM NEFT".
    const at = n.indexOf(prefixQ);
    return at > 0 && /[^A-Z0-9]/.test(n[at - 1]);
  };

  for (const e of snapshot.entities) {
    if (authorityFilter && e.authority !== authorityFilter) continue;
    if (listFilter && !(e.lists || [e.list]).includes(listFilter)) continue;
    if (programFilter && !e.programs.includes(programFilter)) continue;

    if (usePrefix) {
      const names = (e.names && e.names.length) ? e.names : [{ name: e.name }];
      const hit = names.find((n) => startsWithQuery(n.name));
      if (hit) {
        prefixCount++;
        if (prefixHits.length < BTL_MAX_PREFIX) {
          prefixHits.push({
            id: e.id, name: e.name, authority: e.authority, list: e.list, lists: e.lists || [e.list],
            type: e.type, matchedName: hit.name, datePublished: e.datePublished,
          });
        }
      }
    }

    const m = screenEntity(q, e, BTL_FLOOR, mods);
    if (!m) continue;
    // One score, counted into every step it clears — so the counts are a real
    // cumulative curve, not independent re-runs that could disagree.
    for (let t = BTL_FLOOR; t <= 1.0001; t += BTL_STEP) {
      const step = Number(t.toFixed(2));
      if (m.score >= step) buckets.set(step, (buckets.get(step) || 0) + 1);
    }
    if (m.score < active) {
      marginalCount++;
      if (marginal.length < BTL_MAX_MARGINAL) {
        marginal.push({
          id: e.id, name: e.name, authority: e.authority, list: e.list, lists: e.lists || [e.list],
          type: e.type, programs: e.programs, sanctionsTypes: e.sanctionsTypes || [],
          datePublished: e.datePublished, attributes: e.attributes, addresses: e.addresses,
          names: e.names,
          score: m.score, matchType: m.matchType, matchedName: m.matchedName,
          matchedField: m.matchedField, explain: m.explain || '',
        });
      }
    }
  }

  const steps = [];
  for (let t = BTL_FLOOR; t <= 1.0001; t += BTL_STEP) {
    const step = Number(t.toFixed(2));
    steps.push({ threshold: step, count: buckets.get(step) || 0 });
  }
  marginal.sort(rankResults);
  prefixHits.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // If the query reads as an identifier, say so and say how much of the
  // snapshot could possibly have answered it.
  const shape = identifierShape(q);
  const coverage = identifierCoverage();
  const identifier = shape ? {
    shape,
    carriers: coverage.get(shape) || 0,
    total: snapshot.count,
    // Every identifier type present, so "we hold almost no IMOs" is visible
    // rather than inferred.
    types: [...coverage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, n]) => ({ type, count: n })),
  } : null;

  return {
    query: q, active, floor: BTL_FLOOR, steps,
    marginal, marginalCount, truncated: marginalCount > marginal.length,
    prefix: prefixHits, prefixCount, prefixTruncated: prefixCount > prefixHits.length,
    identifier,
    snapshot: meta(),
  };
}

/*
 * Rank hits that score identically.
 *
 * A single-token query against a multi-token name is capped at exactly 0.96 by
 * the scorer, so a surname search flattens: "Putin" returns 16 hits of which 15
 * score 0.96, sorting by score alone does nothing, and the order falls out of
 * whatever the scan produced. Vladimir Putin came third, behind two of his
 * daughters matched on their PUTINA aliases.
 *
 * One tiebreak is real evidence: a hit on the party's own primary name is
 * stronger than a hit on an alias, so primaries come first.
 *
 * Beyond that the tie is genuine and the ordering must not pretend otherwise.
 * Every 0.96 hit for "Putin" is a three-token name matching on one token; the
 * differences left — 21 characters versus 29, a patronymic spelled -itj rather
 * than -ich — are not relevance, and sorting on them manufactures a ranking a
 * reader will believe. So the remaining order is by id: arbitrary, but stable
 * and reproducible, which is what matters when a result gets cited later.
 *
 * The honest half of this fix is `topScoreTies` below, which lets the UI say
 * the leaders are indistinguishable and point at what actually separates them.
 *
 * Scores are untouched — this only orders ties, so nothing crosses the
 * threshold that did not before.
 */
function rankResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const primary = (r) => (r.matchedField === 'primary name' ? 0 : 1);
  if (primary(a) !== primary(b)) return primary(a) - primary(b);
  return String(a.id).localeCompare(String(b.id));
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
    // Membership, not primary label: an entity on both the Consolidated List
    // and the CMIC list must be reachable through either filter.
    if (listFilter && !(e.lists || [e.list]).includes(listFilter)) continue;
    if (programFilter && !e.programs.includes(programFilter)) continue;
    const m = screenEntity(q, e, threshold, mods);
    if (!m) continue;
    results.push({
      id: e.id, name: e.name, authority: e.authority, list: e.list, lists: e.lists || [e.list], type: e.type, title: e.title,
      programs: e.programs, sanctionsTypes: e.sanctionsTypes || (e.sanctionsType ? [e.sanctionsType] : []),
      legalAuthorities: e.legalAuthorities || [], datePublished: e.datePublished,
      names: e.names, addresses: e.addresses, idDocuments: e.idDocuments || [],
      relationships: e.relationships || [], attributes: e.attributes, identifiers: e.identifiers, remarks: e.remarks,
      score: m.score, matchType: m.matchType, matchedName: m.matchedName, matchedField: m.matchedField,
      explain: m.explain || '', corroborated: !!m.corroborated, conflict: !!m.conflict,
      // 50 Percent Rule lead: does this party's ownership chain reach a blocked
      // person, and are there several of them (the aggregate case). Null when
      // there is nothing to report, so the row stays quiet unless it matters.
      derivative: ownershipSummary(snapshot.entities, e.id),
      // Which ownership structure this party belongs to. A 67-hit result set is
      // a different amount of work depending on whether it is 67 companies or
      // one group — and the count alone never says which.
      cluster: ownershipCluster(snapshot.entities, e.id),
    });
  }
  results.sort(rankResults);
  // `count` is every hit above the threshold; `results` is the top slice. The
  // UI must show the former and say when it is showing fewer — an analyst who
  // reads "200 matches" when 573 cleared the threshold has been misinformed.
  // How many hits share the top score. A surname query flattens everything to
  // one value, and a reader takes the first row for the best answer unless told
  // the leaders are indistinguishable — so tell them, and say what separates
  // them (date of birth, nationality, the corroborating-identifier inputs).
  const topScore = results.length ? results[0].score : 0;
  const topScoreTies = results.filter((r) => r.score === topScore).length;

  const payload = {
    query: q, threshold, count: results.length,
    returned: Math.min(results.length, MAX_RESULTS), truncated: results.length > MAX_RESULTS,
    topScore, topScoreTies,
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
    // Font files never change under a given name (family-weight-subset), so
    // they can be cached hard; markup and code must revalidate every load.
    const cache = ['.html', '.css', '.js'].includes(ext) ? 'no-cache'
      : ext === '.woff2' ? 'public, max-age=31536000, immutable'
      : 'public, max-age=86400';
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

    /*
     * One party by id — the record behind a permalink.
     *
     * A search URL is not a stable reference to a hit: it re-runs the matcher,
     * so the same link resolves to a different set as the snapshot moves or the
     * threshold changes, and it can never point at one party unambiguously.
     * A compliance file needs to cite the record, not the query that found it.
     */
    if (p === '/api/entity') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      const id = (url.searchParams.get('id') || '').slice(0, 40);
      if (!/^[\w:.-]+$/.test(id)) return sendJson(res, 400, { error: 'invalid id' });
      const e = snapshot.entities.find((x) => String(x.id) === id);
      if (!e) return sendJson(res, 404, { error: 'not found in this snapshot' });
      return sendJson(res, 200, {
        entity: Object.assign({}, e, {
          lists: e.lists || [e.list],
          derivative: ownershipSummary(snapshot.entities, e.id),
        }),
        ownership: ownershipProfile(snapshot.entities, e.id),
        snapshot: meta(),
      }, null, req);
    }

    // Full derivative-blocking profile for one party: the ownership chains that
    // reach a blocked person, plus its own subsidiaries and control-only links.
    if (p === '/api/ownership') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      const id = (url.searchParams.get('id') || '').slice(0, 40);
      if (!/^[\w:.-]+$/.test(id)) return sendJson(res, 400, { error: 'invalid id' });
      const prof = ownershipProfile(snapshot.entities, id);
      if (!prof) return sendJson(res, 404, { error: 'entity not found in snapshot' });
      prof.snapshot = meta();
      return sendJson(res, 200, prof, null, req);
    }

    /*
     * What the last snapshot rebuild added and removed.
     *
     * Computed at build time (scripts/build-cache.js) because a removal cannot
     * be derived from the current snapshot — a delisted party simply is not
     * there. Additions alone would be half the picture, and the missing half is
     * the one that lets a firm release blocked funds.
     */
    if (p === '/api/changes') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const raw = fs.readFileSync(CHANGES_PATH, 'utf8');
        return sendJson(res, 200, Object.assign(JSON.parse(raw), { snapshot: meta() }), null, req);
      } catch {
        return sendJson(res, 200, { unavailable: true, snapshot: meta() }, null, req);
      }
    }

    // Full scan by design; shares the tighter search rate limit.
    if (p === '/api/below-the-line') {
      if (!readOnly) return sendJson(res, 405, { error: 'method not allowed' });
      const sr = searchLimiter.check(ip);
      if (!sr.ok) return sendJson(res, 429, { error: 'search rate limit exceeded' }, { 'Retry-After': String(sr.retryAfter) });
      return sendJson(res, 200, belowTheLine(url.searchParams), null, req);
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
