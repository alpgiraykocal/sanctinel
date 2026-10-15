'use strict';

// End-to-end against a real server process in --demo mode (fictional sample
// data, no network, boots instantly).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 31000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--demo'], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', SEARCH_RATE_MAX: '20', RATE_MAX: '1000' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
test.after(() => { if (proc) proc.kill(); });

// A fresh client address per call, so the per-IP limits do not interfere
// with tests that are not about them.
let n = 0;
const get = (p, headers = {}) => fetch(BASE + p, { headers: Object.assign({ 'X-Forwarded-For': `198.51.100.${++n % 250}` }, headers) });

test('healthz and meta describe the demo snapshot', async () => {
  const h = await (await get('/healthz')).json();
  assert.equal(h.status, 'ok');
  assert.equal(h.booting, false);
  const m = await (await get('/api/meta')).json();
  assert.equal(m.isLive, false);
  assert.ok(m.count > 0);
});

test('search finds a demo party and reports threshold, count and snapshot', async () => {
  const j = await (await get('/api/search?q=' + encodeURIComponent('Northern Star Trading'))).json();
  assert.equal(j.threshold, 0.95);
  assert.ok(j.count >= 1);
  assert.equal(j.results[0].name, 'NORTHERN STAR TRADING LLC');
  assert.ok(j.snapshot && j.snapshot.publicationId);
});

test('threshold below the recall-safe floor is clamped, not honoured', async () => {
  for (const t of ['0', '0.2', 'abc', '-1']) {
    const j = await (await get('/api/search?q=Ivanov&threshold=' + t)).json();
    assert.ok(j.threshold >= 0.95 && j.threshold <= 1, `threshold=${t} → ${j.threshold}`);
  }
});

test('entity, ownership and graph endpoints validate ids', async () => {
  assert.equal((await get('/api/entity?id=90002')).status, 200);
  assert.equal((await get('/api/entity?id=../etc/passwd')).status, 400);
  assert.equal((await get('/api/entity?id=nope')).status, 404);
  assert.equal((await get('/api/ownership?id=90002')).status, 200);
  const g = await (await get('/api/graph/ego-network?id=90002&depth=99')).json();
  assert.equal(g.depth, 3);
});

test('read-only API rejects other methods; refresh is disabled without a token', async () => {
  assert.equal((await fetch(BASE + '/api/search?q=x', { method: 'POST' })).status, 405);
  assert.equal((await fetch(BASE + '/api/refresh', { method: 'POST' })).status, 200);
  assert.equal((await fetch(BASE + '/api/refresh')).status, 405);
});

test('static files are served with security headers and no path traversal', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js']) {
    assert.notEqual((await get(p)).status, 200, p);
  }
});

test('a spoofed X-Forwarded-For does not escape the search rate limit', async () => {
  const codes = [];
  for (let i = 0; i < 25; i++) {
    const r = await fetch(BASE + '/api/search?q=limit' + i, { headers: { 'X-Forwarded-For': `203.0.113.${i}, 192.0.2.7` } });
    codes.push(r.status);
  }
  assert.ok(codes.includes(429), 'a fresh leftmost address per request must not reset the limit');
});

test('every page and script referenced by the pages is served', async () => {
  for (const p of ['/', '/index.html', '/entity.html', '/insights.html', '/changes.html', '/about.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    for (const [, src] of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|svg))"/g)) {
      const url = '/' + src.replace(/^\.?\//, '');
      assert.equal((await get(url)).status, 200, `${p} → ${url}`);
    }
  }
});

test('check-deployment flags demo data, missing authorities and an old snapshot', async () => {
  const { assess } = require('../scripts/check-deployment');
  const demo = await (await get('/api/meta')).json();
  assert.ok(assess(demo).problems.some((p) => /non-live/.test(p)), 'the demo instance is flagged');
  const good = { isLive: true, missingAuthorities: [], snapshotAgeHours: 10, staleAuthorities: [] };
  assert.deepEqual(assess(good).problems, []);
  assert.equal(assess(Object.assign({}, good, { snapshotAgeHours: 324 })).problems.length, 1);
  assert.equal(assess(Object.assign({}, good, { missingAuthorities: ['EU'] })).problems.length, 1);
});

test('below-the-line returns a cumulative curve from the async scan', async () => {
  const j = await (await get('/api/below-the-line?q=' + encodeURIComponent('Dmitri Ivanov'))).json();
  assert.equal(j.floor, 0.8);
  assert.ok(j.steps.length > 5);
  for (let i = 1; i < j.steps.length; i++) assert.ok(j.steps[i].count <= j.steps[i - 1].count, 'counts fall as the threshold rises');
  assert.ok(j.steps[0].count >= 1);
});

test('history endpoint pages and filters', async () => {
  const j = await (await get('/api/history?limit=5&bulk=0')).json();
  assert.ok(j.summary && j.summary.builds >= 1);
  assert.ok(j.rows.length <= 5);
  for (const r of j.rows) assert.equal(r.bulk, false);
  const removed = await (await get('/api/history?kind=removed&limit=3')).json();
  for (const r of removed.rows) assert.equal(r.kind, 'removed');
  assert.equal((await get('/api/history?limit=99999')).status, 200);
});

test('static files: gzip when accepted, identical bytes on repeat, directories are not served', async () => {
  const a = await fetch(BASE + '/styles.css', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('content-encoding'), 'gzip');
  const b = await fetch(BASE + '/styles.css');
  assert.equal((await a.text()).length, (await b.text()).length);
  assert.equal((await get('/fonts')).status, 404);
  assert.equal((await get('/fonts/')).status, 404);
  const h = await fetch(BASE + '/app.js', { method: 'HEAD' });
  assert.equal(h.status, 200);
});
