'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../lib/history');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'history.ndjson');
const party = (id, authority = 'OFAC') => ({ id, name: 'Party ' + id, authority, list: 'L', type: 'Entity' });
const change = (at, added, removed) => ({ from: { publicationId: '1' }, to: { publicationId: '2', retrievedAt: at }, addedCount: added.length, removedCount: removed.length, added, removed });

test('append is idempotent per build and reads back oldest first', () => {
  const f = tmpFile();
  assert.equal(history.appendHistory(change('2026-10-02T00:00:00Z', [party('b')], []), f), true);
  assert.equal(history.appendHistory(change('2026-10-01T00:00:00Z', [party('a')], []), f), true);
  assert.equal(history.appendHistory(change('2026-10-02T00:00:00Z', [party('b')], []), f), false, 'same build twice');
  assert.deepEqual(history.readHistory(f).map((b) => b.at), ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z']);
});

test('events are newest first, filterable, paged, and flag bulk swings', () => {
  const bulk = Array.from({ length: history.BULK_THRESHOLD }, (_, i) => party('s' + i, 'State'));
  const builds = [
    history.entryFromChanges(change('2026-09-01T00:00:00Z', [party('x')], [])),
    history.entryFromChanges(change('2026-09-02T00:00:00Z', bulk, [party('x')])),
  ];
  const all = history.events(builds, { limit: 10 });
  assert.equal(all.total, history.BULK_THRESHOLD + 2);
  assert.equal(all.rows[0].kind, 'removed', 'newest build first, removals before additions');
  assert.equal(all.rows[0].at, '2026-09-02T00:00:00Z');
  assert.ok(all.rows.some((r) => r.bulk));

  const quiet = history.events(builds, { bulk: false, limit: 10 });
  assert.equal(quiet.total, 2);
  assert.deepEqual(history.events(builds, { kind: 'removed' }).rows.map((r) => r.id), ['x']);
  assert.equal(history.events(builds, { q: 'party x', bulk: false }).total, 2);
  assert.equal(history.events(builds, { authority: 'State', offset: 10, limit: 5 }).rows.length, 5);
});

test('a torn last line is skipped, not fatal', () => {
  const f = tmpFile();
  history.appendHistory(change('2026-10-01T00:00:00Z', [party('a')], []), f);
  fs.appendFileSync(f, '{"at":"2026-10-0');
  assert.equal(history.readHistory(f).length, 1);
});

test('the committed history is readable and summarised', () => {
  const s = history.summary(history.readHistory());
  assert.ok(s.builds >= 1);
  assert.ok(s.since <= s.until);
});
