'use strict';

/*
 * List insights page: renders /api/stats — snapshot composition, the
 * designation timeline, and the most recent designations.
 *
 * Charts are inline SVG/CSS on purpose: the CSP allows no third-party script,
 * and a bar chart does not justify a charting library.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => (n || 0).toLocaleString();

// Designation dates are calendar dates, not instants. Formatting them in the
// viewer's local zone renders a 2026-07-24 designation as "Jul 23, 2026" for
// anyone west of UTC — a wrong date on a compliance record. Pin to UTC.
const fmtDate = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const fmtMonth = (key) => {
  const t = Date.parse(key + '-01T00:00:00Z');
  if (Number.isNaN(t)) return key;
  // "Jul '26" rather than "Jul 26", which reads as a day of the month on an axis.
  const parts = new Date(t).toLocaleDateString('en-US', { year: '2-digit', month: 'short', timeZone: 'UTC' }).split(' ');
  return `${parts[0]} '${parts[1]}`;
};

const authClass = (a) => 'auth-' + String(a || '').toLowerCase().replace(/[^a-z]/g, '');

function stat(n, label, sub) {
  return `<div class="stat"><span class="stat-num">${esc(n)}</span><span class="stat-lbl">${esc(label)}</span>${
    sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</div>`;
}

// Horizontal bars, each scaled against the largest row in its own group.
function barChart(rows, total, opts) {
  if (!rows || !rows.length) return '<p class="chart-empty">No data in this snapshot.</p>';
  const max = Math.max(...rows.map((r) => r.count)) || 1;
  const cls = (opts && opts.tone) || '';
  return rows.map((r) => {
    const pct = total ? (r.count / total) * 100 : 0;
    return `<div class="bar-row">
      <span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="bar-track"><span class="bar-fill ${cls} ${opts && opts.byAuthority ? authClass(r.name) : ''}" style="width:${(r.count / max) * 100}%"></span></span>
      <span class="bar-val">${num(r.count)}${total ? `<em>${pct.toFixed(pct < 1 ? 1 : 0)}%</em>` : ''}</span>
    </div>`;
  }).join('');
}

// Vertical columns for the timelines. Heights are relative to the tallest bar.
// `everyN` thins the axis labels (24 monthly labels do not fit) — counting back
// from the newest column so the most recent period is always labelled.
function colChart(rows, labelFn, everyN) {
  if (!rows || !rows.length) return '<p class="chart-empty">No dated designations.</p>';
  const max = Math.max(...rows.map((r) => r.count)) || 1;
  const step = everyN || 1;
  return rows.map((r, i) => {
    const label = esc(labelFn(r.label));
    const show = (rows.length - 1 - i) % step === 0;
    return `<div class="col" title="${label}: ${num(r.count)} designations">
      <span class="col-bar" style="height:${Math.max(2, (r.count / max) * 100)}%"><em>${num(r.count)}</em></span>
      <span class="col-lbl">${show ? label : ''}</span>
    </div>`;
  }).join('');
}

function renderRecentRow(r) {
  const measures = (r.measures || []).slice(0, 2).map((m) => `<span class="tag">${esc(m)}</span>`).join('');
  const progs = (r.programs || []).slice(0, 4).map((p) => `<span class="tag tag-prog">${esc(p)}</span>`).join('');
  return `<article class="recent-item">
    <div class="recent-date"><time datetime="${esc(r.date)}">${esc(fmtDate(r.date))}</time></div>
    <div class="recent-body">
      <h3 class="recent-name">${esc(r.name)}</h3>
      ${r.title ? `<p class="recent-title">${esc(r.title)}</p>` : ''}
      <div class="tags">
        <span class="tag tag-auth ${authClass(r.authority)}">${esc(r.authority)}</span>
        <span class="tag tag-list">${esc(r.list)}</span>
        <span class="tag tag-type">${esc(r.type)}</span>
        ${r.country ? `<span class="tag">${esc(r.country)}</span>` : ''}
        ${r.aliases ? `<span class="tag">${num(r.aliases)} alias${r.aliases === 1 ? '' : 'es'}</span>` : ''}
        ${measures}${progs}
      </div>
    </div>
    <a class="recent-screen btn-ghost" href="./?q=${encodeURIComponent(r.name)}" title="Screen this party">Screen →</a>
  </article>`;
}

let RECENT = [];
let shown = 0;
const PAGE = 25;

function filtered() {
  const a = $('fAuthority').value, t = $('fType').value;
  const q = $('fText').value.trim().toLowerCase();
  return RECENT.filter((r) => {
    if (a && r.authority !== a) return false;
    if (t && r.type !== t) return false;
    if (!q) return true;
    return (r.name + ' ' + r.list + ' ' + r.country + ' ' + (r.programs || []).join(' ')).toLowerCase().includes(q);
  });
}

function renderRecent(reset) {
  const rows = filtered();
  if (reset) shown = 0;
  shown = Math.min(rows.length, shown + PAGE);
  $('recentList').innerHTML = rows.slice(0, shown).map(renderRecentRow).join('') ||
    '<p class="chart-empty">No designations match these filters.</p>';
  $('recentCount').textContent = rows.length
    ? `Showing ${num(Math.min(shown, rows.length))} of ${num(rows.length)} recent designations.`
    : '';
  $('moreBtn').hidden = shown >= rows.length;
}

function render(s) {
  const t = s.totals;

  $('provenance').innerHTML =
    `${s.snapshot.isLive ? 'Live snapshot' : 'Offline sample'}` +
    (s.snapshot.publicationId && s.snapshot.publicationId !== 'unknown' ? ` · OFAC publication #${esc(s.snapshot.publicationId)}` : '') +
    (s.snapshot.retrievedAt ? ` · retrieved ${esc(fmtDate(s.snapshot.retrievedAt))}` : '') +
    (t.newest ? ` · newest designation ${esc(fmtDate(t.newest))}` : '') +
    (s.loading ? ' · <strong>refresh in progress</strong>' : '');

  $('headline').innerHTML =
    stat(num(t.entities), 'listed parties', `${num(t.dated)} dated`) +
    stat(num(t.authorities), 'issuing authorities', `${num(t.lists)} lists`) +
    stat(num(t.added90), 'designated in 90 days', `${num(t.added30)} in the last 30`) +
    stat(num(t.added365), 'designated in 12 months', `${num(t.programs)} programs`);

  $('authBars').innerHTML = barChart(s.byAuthority, t.entities, { byAuthority: true });
  $('typeBars').innerHTML = barChart(s.byType, t.entities);
  $('measureBars').innerHTML = barChart(s.byMeasure, t.entities);
  $('listBars').innerHTML = barChart(s.byList, t.entities);
  $('progBars').innerHTML = barChart(s.byProgram, t.entities);
  $('countryBars').innerHTML = barChart(s.byCountry, t.entities);

  $('yearChart').innerHTML = colChart(s.timeline.years, (l) => l, 1);
  $('monthChart').innerHTML = colChart(s.timeline.months, fmtMonth, 3);
  $('timelineNote').textContent =
    `${num(t.dated)} of ${num(t.entities)} records carry a designation date (${num(t.undated)} undated, mostly older BIS and State Department entries)` +
    (t.oldest ? `. Oldest dated designation: ${fmtDate(t.oldest)}.` : '.');

  $('depthStats').innerHTML =
    stat(num(t.withAliases), 'parties with aliases', `${Math.round((t.withAliases / (t.entities || 1)) * 100)}% of records`) +
    stat(num(t.withIdentifiers), 'with an identifier', 'passport, IMO, tax ID, crypto…') +
    stat(num(t.withRelationships), 'with relationships', `${num(t.relationshipEdges)} edges`) +
    stat(num(t.ownershipEdges), 'ownership edges', 'drive the 50% Rule graph');

  RECENT = s.recent || [];
  const authorities = [...new Set(RECENT.map((r) => r.authority))].sort();
  const types = [...new Set(RECENT.map((r) => r.type))].sort();
  $('fAuthority').innerHTML = '<option value="">All authorities</option>' + authorities.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  $('fType').innerHTML = '<option value="">All types</option>' + types.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  renderRecent(true);
}

$('fAuthority').addEventListener('change', () => renderRecent(true));
$('fType').addEventListener('change', () => renderRecent(true));
$('fText').addEventListener('input', () => renderRecent(true));
$('moreBtn').addEventListener('click', () => renderRecent(false));

(async () => {
  try {
    const s = await fetch('api/stats').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    render(s);
    // A background refresh swaps the snapshot; re-pull once it finishes so the
    // page does not sit on numbers from the previous publication.
    if (s.loading) setTimeout(() => location.reload(), 20000);
  } catch {
    $('provenance').textContent = '';
    $('loadError').hidden = false;
  }
})();
