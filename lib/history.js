'use strict';

/*
 * Every build's additions and removals, kept.
 *
 * cache/changes.json holds the LAST build's delta and is overwritten by the
 * next one, so "when did this party come off the list?" stopped being
 * answerable a day later. A delisting is the event that lets a firm release
 * frozen funds, and the date it happened is exactly what an audit asks for.
 *
 * cache/history.ndjson is append-only: one line per build, oldest first, each
 * the compacted changes.json of that build. Appending keeps it cheap in git —
 * a day adds one line — and it is small enough to read whole.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'cache', 'history.ndjson');

/*
 * Builds in which one authority added or removed this many parties at once are
 * flagged. That is never a day of designations: it is an authority returning
 * to the snapshot after an outage (6,256 BIS and State records "added" on
 * 2026-08-02) or leaving it, and showing those rows as new listings would
 * bury the real ones.
 */
const BULK_THRESHOLD = 500;

const slim = (r) => ({
  id: String(r.id), name: r.name, authority: r.authority || 'OFAC', list: r.list || '', type: r.type || '',
  ...(r.datePublished ? { datePublished: r.datePublished } : {}),
});

// One history line from a changes.json-shaped delta.
function entryFromChanges(c) {
  return {
    at: (c.to && c.to.retrievedAt) || c.generatedAt || '',
    from: c.from || {},
    to: c.to || {},
    addedCount: c.addedCount || 0,
    removedCount: c.removedCount || 0,
    truncated: !!c.truncated,
    added: (c.added || []).map(slim),
    removed: (c.removed || []).map(slim),
  };
}

// Append a build, unless it is the build already at the end (a re-run that
// rewrote the same snapshot must not record its changes twice).
function appendHistory(changes, file = HISTORY_PATH) {
  const entry = entryFromChanges(changes);
  if (!entry.at) return false;
  const existing = readHistory(file);
  if (existing.some((b) => b.at === entry.at)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return true;
}

let _cache = { file: '', mtime: -1, builds: [] };
function readHistory(file = HISTORY_PATH) {
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  if (_cache.file === file && _cache.mtime === mtime) return _cache.builds;
  const builds = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { builds.push(JSON.parse(line)); } catch { /* a torn last line is skipped, not fatal */ }
  }
  builds.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  _cache = { file, mtime, builds };
  return builds;
}

// Authority → side → count for one build, to flag bulk swings.
function bulkSides(build) {
  const out = new Set();
  for (const kind of ['added', 'removed']) {
    const n = new Map();
    for (const r of build[kind] || []) n.set(r.authority, (n.get(r.authority) || 0) + 1);
    for (const [a, c] of n) if (c >= BULK_THRESHOLD) out.add(`${kind}:${a}`);
  }
  return out;
}

/*
 * Flattened events, newest first: one row per party per build.
 *   kind       'added' | 'removed' | ''
 *   authority  exact authority, or ''
 *   q          case-insensitive substring of name, list or id
 *   bulk       false hides bulk swings (default true: shown, flagged)
 *   offset / limit  paging
 */
function events(builds, { kind = '', authority = '', q = '', bulk = true, offset = 0, limit = 100 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const rows = [];
  let total = 0;
  for (let i = builds.length - 1; i >= 0; i--) {
    const b = builds[i];
    const bulkSet = bulkSides(b);
    for (const k of ['removed', 'added']) {
      if (kind && kind !== k) continue;
      for (const r of b[k] || []) {
        if (authority && r.authority !== authority) continue;
        const isBulk = bulkSet.has(`${k}:${r.authority}`);
        if (!bulk && isBulk) continue;
        if (needle && !`${r.name} ${r.list} ${r.id}`.toLowerCase().includes(needle)) continue;
        if (total >= offset && rows.length < limit) {
          rows.push(Object.assign({ kind: k, at: b.at, fromPublication: b.from.publicationId || '', toPublication: b.to.publicationId || '', bulk: isBulk }, r));
        }
        total++;
      }
    }
  }
  return { total, rows };
}

function summary(builds) {
  const authorities = new Set();
  let added = 0, removed = 0;
  for (const b of builds) {
    added += b.addedCount || 0; removed += b.removedCount || 0;
    for (const r of [...(b.added || []), ...(b.removed || [])]) authorities.add(r.authority);
  }
  return {
    builds: builds.length,
    since: builds.length ? builds[0].at : '',
    until: builds.length ? builds[builds.length - 1].at : '',
    added, removed,
    authorities: [...authorities].sort(),
    truncatedBuilds: builds.filter((b) => b.truncated).length,
  };
}

module.exports = { HISTORY_PATH, BULK_THRESHOLD, entryFromChanges, appendHistory, readHistory, events, summary };
