'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSnapshotDir, readSnapshotDir } = require('../lib/ingest');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snapdir-'));
const ent = (id, authority) => ({ id, authority, name: 'N' + id, names: [{ name: 'N' + id }] });

test('round-trips meta and every party, one sorted shard per authority', () => {
  const dir = tmp();
  const meta = { publicationId: '7', retrievedAt: '2026-10-15T00:00:00Z' };
  const entities = [ent('20', 'OFAC'), ent('EU-2', 'EU'), ent('10', 'OFAC'), ent('EU-1', 'EU')];
  writeSnapshotDir(meta, entities, dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['EU.ndjson', 'OFAC.ndjson', 'meta.json']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'OFAC.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['10', '20']);
  const back = readSnapshotDir(dir);
  assert.deepEqual(back.meta, meta);
  assert.deepEqual(back.entities.map((e) => e.id).sort(), ['10', '20', 'EU-1', 'EU-2']);
});

test('a shard cut short is detected, not read as a smaller list', () => {
  const dir = tmp();
  writeSnapshotDir({}, [ent('1', 'UN'), ent('2', 'UN'), ent('3', 'UN')], dir);
  const f = path.join(dir, 'UN.ndjson');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
  assert.throws(() => readSnapshotDir(dir), /holds 2 parties, meta.json says 3/);
});

test('a shard for an authority that is gone is removed on rewrite', () => {
  const dir = tmp();
  writeSnapshotDir({}, [ent('1', 'UN'), ent('2', 'UK')], dir);
  writeSnapshotDir({}, [ent('1', 'UN')], dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['UN.ndjson', 'meta.json']);
});

test('the committed snapshot directory reads and matches its own meta count', () => {
  const back = readSnapshotDir();
  assert.ok(back.entities.length > 30000);
  assert.ok(back.meta.authorityFreshness);
});
