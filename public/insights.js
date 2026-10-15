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
// 5,930 -> "5.9k" for chart labels, where the full figure sits in the tooltip.
const compact = (n) => (n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k` : String(n || 0));

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
    // Value labels only on labelled columns (and on hover) so they never collide.
    return `<div class="col${show ? ' on' : ''}" title="${label}: ${num(r.count)} designations">
      <span class="col-bar" style="height:${Math.max(2, (r.count / max) * 100)}%"><em>${compact(r.count)}</em></span>
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
  if (reset) { shown = 0; const pane = $('recentList').closest('.pane'); if (pane) pane.scrollTop = 0; }
  shown = Math.min(rows.length, shown + PAGE);
  $('recentList').innerHTML = rows.slice(0, shown).map(renderRecentRow).join('') ||
    '<p class="chart-empty">No designations match these filters.</p>';
  $('recentCount').textContent = rows.length
    ? `Showing ${num(Math.min(shown, rows.length))} of ${num(rows.length)} recent designations.`
    : '';
  $('moreBtn').hidden = shown >= rows.length;
}

const pctOf = (v) => (v == null ? '—' : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);
// Three bands, so a column of percentages reads at a glance; the number is
// always printed, the band only tints it.
const band = (v) => (v == null ? '' : v >= 0.75 ? 'dq-hi' : v >= 0.35 ? 'dq-mid' : 'dq-lo');

const AUTH_ORDER = ['OFAC', 'EU', 'UN', 'UK', 'BIS', 'State'];
const byAuthOrder = (a, b) => {
  const ia = AUTH_ORDER.indexOf(a), ib = AUTH_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
};

function renderQuality(dq, totals) {
  if (!dq) { $('sourceTable').innerHTML = '<p class="chart-empty">Not available for this snapshot.</p>'; return; }

  // Sources: one row per upstream feed, as the last build found it.
  const freshness = dq.authorityFreshness || {};
  // aria-label rather than an sr-only <caption>: the caption is absolutely
  // positioned, escapes the card's scroll container and makes the page scroll.
  $('sourceTable').innerHTML = (dq.sources || []).length ? `<table class="dq-table" aria-label="Upstream sources in this snapshot">
    <thead><tr><th scope="col">Source</th><th scope="col">Records</th><th scope="col">Status</th><th scope="col">Retrieved</th></tr></thead>
    <tbody>${dq.sources.map((src) => {
      const status = !src.ok ? (src.carriedForward ? `Carried forward${src.asOf ? ` from ${fmtDate(src.asOf)}` : ''}` : 'Failed')
        : (src.failedLists || []).length ? `Fresh, ${src.failedLists.length} list(s) carried forward`
          : (src.qualityCarriedForward || []).length ? `Fresh, ${src.qualityCarriedForward.join(', ')} carried forward` : 'Fresh';
      const when = (src.authorities || []).map((a) => freshness[a]).filter(Boolean).sort()[0];
      return `<tr><th scope="row">${esc(src.label)}<span class="dq-sub">${esc((src.authorities || []).join(' · '))}</span></th>
        <td class="num">${num(src.count)}</td>
        <td><span class="dq-status ${src.ok && !(src.failedLists || []).length ? 'ok' : 'warn'}">${esc(status)}</span></td>
        <td class="nowrap">${esc(when ? new Date(when).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—')}</td></tr>`;
    }).join('')}</tbody></table>` : '<p class="chart-empty">No source record in this snapshot.</p>';

  // Field completeness: the quality gate's own profile.
  const auths = Object.keys(dq.fields.authorities || {}).sort(byAuthOrder);
  // Short headers so six columns fit a third of the screen; the full name is
  // the header's title and its accessible name.
  const cols = [['aliasRate', 'Alias', 'Records with at least one alias'], ['addressRate', 'Addr.', 'Records with an address'],
    ['addressDetailRate', 'Street', 'Addresses that say more than their country'], ['identifierRate', 'ID', 'Records with a screening identifier'],
    ['birthDateRate', 'DOB', 'Records with a birth date that parses'], ['nationalityRate', 'Nat.', 'Records with a nationality or citizenship']];
  $('fieldTable').innerHTML = `<table class="dq-table dq-grid" aria-label="Share of each authority's records that carry each field">
    <thead><tr><th scope="col">Authority</th>${cols.map(([, l, full]) => `<th scope="col" title="${esc(full)}"><abbr title="${esc(full)}">${esc(l)}</abbr></th>`).join('')}</tr></thead>
    <tbody>${auths.map((a) => {
      const r = dq.fields.authorities[a];
      return `<tr><th scope="row">${esc(a)}<span class="dq-sub">${num(r.count)}</span></th>${cols.map(([k]) => `<td class="num ${band(r[k])}">${pctOf(r[k])}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table>
    <p class="chart-note">Alias, address, identifier, birth date and nationality: share of records carrying the field. Street: share of addresses that say more than their country. Low figures for the State Department lists reflect what they publish, not a parsing fault.</p>`;

  const d = dq.fields.derived || {};
  $('parseStats').innerHTML =
    stat(pctOf(d.datePublishedIsoRate), 'listing dates in ISO form', 'floor 99%') +
    stat(pctOf(d.dobParseRate), 'birth dates parsed', `${num(d.dobValues)} values · floor 95%`) +
    stat(pctOf(d.countryResolveRate), 'country values resolved', `${num(d.countryValues)} values · floor 95%`) +
    stat(pctOf(d.identifierUnclassifiedRate), 'identifier types unclassified', `${num(d.identifiers)} identifiers · ceiling 25%`);

  // Annotations, summed across authorities.
  const sum = { documents: 0, dated: 0, flagged: 0, refuted: 0, reported: 0, lapsed: 0, native: 0 };
  for (const a of Object.values(dq.annotations || {})) {
    sum.documents += a.documents; sum.dated += a.documentsDated; sum.refuted += a.refutedValues;
    sum.reported += a.reportedValues; sum.lapsed += a.lapsedDenials; sum.native += a.nativeNames;
    for (const n of Object.values(a.documentStatus || {})) sum.flagged += n;
  }
  $('annotationStats').innerHTML =
    stat(num(sum.flagged), 'documents flagged', 'invalid, expired, revoked or false') +
    stat(num(sum.dated), 'documents with dates', `of ${num(sum.documents)} identity documents`) +
    stat(num(sum.refuted), 'values marked false', `${num(sum.reported)} more only reported`) +
    stat(num(sum.lapsed), 'lapsed BIS denial orders', 'kept, marked expired, ranked last') +
    stat(num(sum.native), 'records with an own-script name', 'searchable in that script');

  const x = dq.crossListing;
  if (!x) { $('crossStats').innerHTML = '<p class="chart-empty">Not computed for this snapshot.</p>'; return; }
  $('crossStats').innerHTML =
    stat(num(x.records), 'records linked', `${num(x.groups)} real parties, ${Math.round((x.records / (totals.entities || 1)) * 100)}% of records`) +
    stat(num((x.basis || {}).identifier || 0), 'groups on a shared identifier', `${num((x.basis || {})['name+dob'] || 0)} on name + birth year · ${num((x.basis || {})['name+country'] || 0)} on name + country`);
  $('crossBars').innerHTML = barChart(Object.entries(x.linked || {}).sort((a, b) => byAuthOrder(a[0], b[0])).map(([name, count]) => ({ name, count })), 0, { byAuthority: true });
}

function render(s) {
  const t = s.totals;
  renderQuality(s.dataQuality, t);

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
    const { res: sr, body: s } = await window.SS.getJson('api/stats');
    if (!sr.ok) throw new Error(sr.status);
    render(s);
    // A background refresh swaps the snapshot; re-pull once it finishes so the
    // page does not sit on numbers from the previous publication.
    if (s.loading) setTimeout(() => location.reload(), 20000);
  } catch {
    $('provenance').textContent = '';
    $('loadError').hidden = false;
  }
})();
