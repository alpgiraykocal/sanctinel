'use strict';

/*
 * Is the deployed app up and serving complete, current data?
 *
 *   node scripts/check-deployment.js https://sanctinel.onrender.com
 *
 * The nightly build can be green while the site is not: the deploy failed, the
 * instance is crash-looping, or it booted into the fictional sample data. And
 * the site can be up while the build has been red for days. This asks the one
 * thing a screener relies on — what is the live instance actually screening
 * against — and exits 1 with the reasons if the answer is not good enough.
 *
 * Waits out a cold start: a free instance sleeps after 15 idle minutes, wakes
 * in about a minute, and answers 503 while it loads the snapshot.
 */

const MAX_AGE_HOURS = Number(process.env.MAX_SNAPSHOT_AGE_HOURS) || 36;
const ATTEMPTS = Number(process.env.CHECK_ATTEMPTS) || 12;
const DELAY_MS = Number(process.env.CHECK_DELAY_MS) || 15000;

async function meta(base) {
  let last = '';
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const r = await fetch(new URL('api/meta', base.endsWith('/') ? base : base + '/'), { signal: AbortSignal.timeout(60000) });
      if (r.ok) return { body: await r.json() };
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.message; }
    if (i < ATTEMPTS - 1) await new Promise((res) => setTimeout(res, DELAY_MS));
  }
  return { error: `no healthy answer after ${ATTEMPTS} attempts (last: ${last})` };
}

function assess(m) {
  const problems = [];
  const notes = [];
  if (!m.isLive) problems.push(`serving non-live data: ${m.source}`);
  if ((m.missingAuthorities || []).length) problems.push(`authorities not screened at all: ${m.missingAuthorities.join(', ')}`);
  if (m.snapshotAgeHours == null) problems.push('snapshot age unknown');
  else if (m.snapshotAgeHours > MAX_AGE_HOURS) problems.push(`snapshot is ${m.snapshotAgeHours}h old (limit ${MAX_AGE_HOURS}h)`);
  for (const s of m.staleAuthorities || []) notes.push(`${s.authority} data is ${s.ageHours}h old (carried forward)`);
  if (m.refreshBlocked) notes.push(`runtime refresh blocked: ${m.refreshBlocked.reason}`);
  return { problems, notes };
}

if (require.main === module) {
  const base = process.argv[2];
  if (!base) { console.error('usage: check-deployment.js <base-url>'); process.exit(2); }
  meta(base).then(({ body, error }) => {
    if (error) { console.log(`DOWN: ${base} — ${error}`); process.exit(1); }
    const { problems, notes } = assess(body);
    console.log(`${base}: ${body.count} parties, publication ${body.publicationId}, snapshot ${body.snapshotAgeHours}h old`);
    for (const n of notes) console.log(`  note: ${n}`);
    for (const p of problems) console.log(`  PROBLEM: ${p}`);
    process.exit(problems.length ? 1 : 0);
  });
}

module.exports = { assess };
