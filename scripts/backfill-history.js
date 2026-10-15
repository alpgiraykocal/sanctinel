'use strict';

/*
 * Rebuild cache/history.ndjson from every committed version of
 * cache/changes.json in the git history.
 *
 *   node scripts/backfill-history.js            # needs history, not a shallow clone
 *
 * A blobless clone is enough and cheap: git fetches only the changes.json
 * blobs it is asked for, never the snapshots beside them —
 *   git clone --filter=blob:none <repo>
 *
 * Writes the file from scratch, oldest build first. The nightly build appends
 * to it from then on (scripts/build-cache.js), so this is a one-off.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const { HISTORY_PATH, entryFromChanges } = require('../lib/history');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1048576 });

const shas = git('log', '--reverse', '--format=%H', '--', 'cache/changes.json').trim().split('\n').filter(Boolean);
const seen = new Set();
const lines = [];
for (const sha of shas) {
  let c;
  try { c = JSON.parse(git('show', `${sha}:cache/changes.json`)); } catch { continue; }
  const e = entryFromChanges(c);
  if (!e.at || seen.has(e.at)) continue;
  seen.add(e.at);
  lines.push(e);
}
lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
fs.writeFileSync(HISTORY_PATH, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
console.log(`wrote ${lines.length} builds from ${shas.length} commits to ${HISTORY_PATH}`);
