'use strict';

/*
 * Browser tests: the things only a real page shows. Run with
 *
 *   npm install --no-save playwright axe-core && npx playwright install chromium
 *   npm run test:ui
 *
 * Kept out of `npm test` (it needs a browser) and out of package.json's
 * dependencies (the app has none, and a test browser should not change that).
 * Skips cleanly when Playwright is not installed.
 *
 * The server runs against a temporary snapshot built from the demo data with
 * an HTML payload planted in every text field, so the XSS check exercises
 * every renderer, not just the ones somebody remembered.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium = null, axeSource = null;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* axe test skipped */ }

const ROOT = path.join(__dirname, '..', '..');
const PORT = 33000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PAYLOAD = (where) => `<img src=x class=XSS data-f="${where}">`;
const PAGES = ['/', '/?q=NORTHERN%20STAR%20TRADING', '/entity.html?id=90002', '/insights.html', '/changes.html', '/about.html'];

let proc, browser, cacheDir;

// Plant the payload in every string field except identifiers the code keys on.
function poison(value, where) {
  if (typeof value === 'string') return value + PAYLOAD(where);
  if (Array.isArray(value)) return value.map((v, i) => poison(v, `${where}.${i}`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = ['id', 'relatedId', 'authority', 'primary', 'lowQuality'].includes(k) ? v : poison(v, `${where}.${k}`);
    }
    return out;
  }
  return value;
}

function buildHostileCache() {
  const { writeSnapshotDir } = require(path.join(ROOT, 'lib', 'ingest'));
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-data', 'sample.json'), 'utf8'));
  // Keep the primary names searchable: the payload rides at the end of them.
  const entities = sample.entities.map((e) => Object.assign(poison(e, 'e' + e.id), { authority: e.authority || 'OFAC', id: e.id }));
  const now = new Date().toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-cache-'));
  writeSnapshotDir({
    source: 'UI test' + PAYLOAD('meta.source'), publicationId: '42', retrievedAt: now, isLive: true,
    sources: [{ label: 'OFAC' + PAYLOAD('src'), authorities: ['OFAC'], ok: true, count: entities.length, error: '' }],
    authorityFreshness: { OFAC: now },
  }, entities, path.join(dir, 'snapshot'));
  const added = entities.slice(0, 3).map((e) => ({ id: e.id, name: e.name, authority: 'OFAC', list: 'SDN' + PAYLOAD('chg.list'), type: 'Entity' }));
  const changes = { from: { publicationId: '41', count: 9 }, to: { publicationId: '42', retrievedAt: now, count: entities.length }, addedCount: 3, removedCount: 1, added, removed: [{ id: 'gone', name: 'Removed' + PAYLOAD('rm'), authority: 'OFAC', list: 'L', type: 'Entity' }], truncated: false, generatedAt: now };
  fs.writeFileSync(path.join(dir, 'changes.json'), JSON.stringify(changes));
  fs.writeFileSync(path.join(dir, 'history.ndjson'), JSON.stringify(Object.assign({ at: now }, changes)) + '\n');
  return dir;
}

const skip = !chromium && 'playwright is not installed (npm install --no-save playwright)';

test.before(async () => {
  if (skip) return;
  cacheDir = buildHostileCache();
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', SANCTIONS_CACHE_DIR: cacheDir, CACHE_TTL_MS: String(1e12), RATE_MAX: '100000', SEARCH_RATE_MAX: '100000' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 150; i++) {
    try { const j = await (await fetch(BASE + '/healthz')).json(); if (!j.booting) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (proc) proc.kill(); });

async function open(url, opts = {}) {
  const ctx = await browser.newContext(opts.context || {});
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  if (opts.viewport) await page.setViewportSize(opts.viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  return { page, ctx, errors };
}

test('hostile data renders as text everywhere, never as markup', { skip }, async () => {
  for (const url of PAGES) {
    const { page, ctx, errors } = await open(url);
    for (const t of await page.$$('.rc-toggle')) await t.click();
    const injected = await page.$$eval('img.XSS, [data-f]', (els) => els.map((e) => e.getAttribute('data-f')));
    assert.deepEqual(injected, [], `${url}: payload became markup at ${injected.join(', ')}`);
    assert.deepEqual(errors, [], `${url}: console errors`);
    await ctx.close();
  }
  // And it did reach the page — as text.
  const { page, ctx } = await open('/?q=NORTHERN%20STAR%20TRADING');
  assert.match(await page.innerText('#resultList'), /data-f=/);
  await ctx.close();
});

/*
 * The page itself never scrolls, in either direction, at any width: every
 * region that can grow scrolls inside its own pane (see "App shell" in
 * styles.css). Checked on phones, a tablet and a laptop.
 */
test('no page scrolls — vertically or sideways — at any width', { skip }, async () => {
  for (const [width, height] of [[320, 640], [360, 740], [390, 844], [1024, 768], [1440, 900]]) {
    for (const url of PAGES) {
      const { page, ctx } = await open(url, { viewport: { width, height } });
      for (const t of await page.$$('.rc-toggle')) await t.click().catch(() => {});
      const [sw, cw, sh, ch] = await page.evaluate(() => {
        const d = document.documentElement;
        return [d.scrollWidth, d.clientWidth, d.scrollHeight, d.clientHeight];
      });
      assert.ok(sw <= cw, `${url} at ${width}px scrolls sideways: ${sw} > ${cw}`);
      assert.ok(sh <= ch, `${url} at ${width}x${height} scrolls the page: ${sh} > ${ch}`);
      await ctx.close();
    }
  }
});

test('results scroll in their own pane and start at the top for a new search', { skip }, async () => {
  const { page, ctx } = await open('/?q=Ivanov', { viewport: { width: 1280, height: 600 } });
  for (const t of await page.$$('.rc-toggle')) await t.click();
  const pane = await page.$('#resultsPane');
  const scrollable = await pane.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto');
  assert.ok(scrollable, 'the results pane is the scroller');
  await pane.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.fill('#q', 'NORTHERN STAR TRADING');
  await page.press('#q', 'Enter');
  await page.waitForTimeout(600);
  assert.equal(await pane.evaluate((el) => el.scrollTop), 0);
  await ctx.close();
});

test('on a phone, What changed shows one column at a time as tabs', { skip }, async () => {
  const { page, ctx, errors } = await open('/changes.html', { viewport: { width: 390, height: 844 } });
  assert.ok(await page.isVisible('.col-tabs'));
  assert.ok(await page.isVisible('.col-added'));
  assert.equal(await page.isVisible('.col-removed'), false);
  await page.click('#tabHistory');
  assert.ok(await page.isVisible('#historySection'));
  assert.equal(await page.isVisible('.col-added'), false);
  assert.equal(await page.getAttribute('#tabHistory', 'aria-selected'), 'true');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the theme toggle works when storage is blocked', { skip }, async () => {
  const { page, ctx, errors } = await open('/', {
    init: () => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); },
  });
  await page.click('#themeToggle');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a shared link restores its filters and shows the slider value it really set', { skip }, async () => {
  let { page, ctx } = await open('/?q=Ivanov&threshold=0.5');
  assert.equal(await page.$eval('#threshold', (e) => e.value), '0.95');
  assert.equal(await page.innerText('#threshOut'), '0.95');
  await ctx.close();
  ({ page, ctx } = await open('/?q=Ivanov&list=No%20Such%20List'));
  assert.ok(await page.isVisible('#urlNote'));
  assert.match(await page.innerText('#urlNote'), /No Such List/);
  await ctx.close();
});

test('the relationship graph opens and closes', { skip }, async () => {
  const { page, ctx, errors } = await open('/?q=NORTHERN%20STAR%20TRADING');
  await page.click('.rc-graph');
  await page.waitForTimeout(800);
  assert.ok(await page.isVisible('#graphModal'));
  for (const sel of ['[data-view="ownership"]', '[data-depth="1"]', '[data-view="radial"]']) await page.click(sel);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await page.isVisible('#graphModal'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the change history filters and pages', { skip }, async () => {
  const { page, ctx, errors } = await open('/changes.html');
  assert.ok(await page.isVisible('#historySection'));
  await page.selectOption('#hKind', 'removed');
  await page.waitForTimeout(400);
  assert.match(await page.innerText('#historyNote'), /of 1\)/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('no WCAG 2 AA violations on any page, light or dark', { skip: skip || (!axeSource && 'axe-core is not installed') }, async () => {
  for (const scheme of ['light', 'dark']) {
    for (const url of PAGES) {
      const { page, ctx } = await open(url, { context: { bypassCSP: true, colorScheme: scheme } });
      for (const t of await page.$$('.rc-toggle')) await t.click();
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }))
        .violations.map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0].target.join(' ')}`));
      assert.deepEqual(violations, [], `${scheme} ${url}`);
      await ctx.close();
    }
  }
});
