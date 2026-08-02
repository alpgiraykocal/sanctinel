'use strict';

/*
 * What the last snapshot rebuild added and removed.
 *
 * The delta is computed at build time (scripts/build-cache.js), not here: a
 * removal cannot be derived from the current snapshot, because a delisted party
 * simply is not in it. Showing only additions would be the easy version and the
 * misleading one — the removal side is what tells a firm it may be holding
 * funds it no longer has to.
 */

const $ = (id) => document.getElementById(id);
const esc = window.SS.esc;

const PAGE = 50;
let DATA = null;
let shownAdded = 0;
let shownRemoved = 0;

const permalink = (id) => `entity.html?id=${encodeURIComponent(id)}`;

function filterRows(rows) {
  const a = $('cAuthority').value;
  const q = $('cText').value.trim().toLowerCase();
  return rows.filter((r) => {
    if (a && r.authority !== a) return false;
    if (!q) return true;
    return `${r.name} ${r.list || ''} ${r.authority || ''}`.toLowerCase().includes(q);
  });
}

/*
 * Added parties link to their record; removed ones do not. A removed party is
 * absent from the snapshot, so its permalink would 404 — offering the link
 * would promise a page that cannot exist.
 */
function row(r, linked) {
  const meta = [r.authority, r.list, r.type].filter(Boolean).map(esc).join(' · ');
  const name = linked
    ? `<a href="${permalink(r.id)}">${esc(r.name)}</a>`
    : `${esc(r.name)} <span class="chg-gone">no longer in snapshot</span>`;
  return `<div class="chg-row">
      <span class="chg-name">${name}</span>
      <span class="chg-meta">${meta}${r.datePublished ? ` · listed ${esc(r.datePublished)}` : ''} · id ${esc(r.id)}</span>
    </div>`;
}

function renderList(which, reset) {
  const rows = filterRows(DATA[which] || []);
  const isAdded = which === 'added';
  if (reset) { if (isAdded) shownAdded = 0; else shownRemoved = 0; }
  const shown = Math.min(rows.length, (isAdded ? shownAdded : shownRemoved) + PAGE);
  if (isAdded) shownAdded = shown; else shownRemoved = shown;

  $(isAdded ? 'addedList' : 'removedList').innerHTML =
    rows.slice(0, shown).map((r) => row(r, isAdded)).join('') ||
    `<p class="chart-empty">No ${isAdded ? 'additions' : 'removals'} match these filters.</p>`;
  $(isAdded ? 'addedNote' : 'removedNote').textContent =
    rows.length ? `(showing ${Math.min(shown, rows.length)} of ${rows.length})` : '(none)';
  $(isAdded ? 'addedMore' : 'removedMore').hidden = shown >= rows.length;
}

function renderAll(reset) {
  renderList('added', reset);
  renderList('removed', reset);
}

// Same markup the insights page uses — .stat-num / .stat-lbl / .stat-sub carry
// the layout, so a bare <strong>/<span> would render as one run-on line.
function stat(value, label, sub) {
  return `<div class="stat"><span class="stat-num">${esc(value)}</span><span class="stat-lbl">${esc(label)}</span>${
    sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</div>`;
}

function render(d) {
  DATA = d;
  const from = d.from || {}, to = d.to || {};
  $('changesProvenance').textContent =
    `Comparing OFAC publication #${from.publicationId || '?'} (${from.count != null ? from.count.toLocaleString() : '?'} parties) ` +
    `→ #${to.publicationId || '?'} (${to.count != null ? to.count.toLocaleString() : '?'} parties) · delta computed ${d.generatedAt ? new Date(d.generatedAt).toLocaleString() : '—'}`;

  const net = (to.count || 0) - (from.count || 0);
  $('changesHeadline').innerHTML =
    stat((d.addedCount || 0).toLocaleString(), 'parties added', 'new designations') +
    stat((d.removedCount || 0).toLocaleString(), 'parties removed', 'delisted or reissued') +
    stat((net >= 0 ? '+' : '') + net.toLocaleString(), 'net change', 'in list size') +
    stat((to.count || 0).toLocaleString(), 'parties now', 'in this snapshot');
  $('changesHeadline').hidden = false;

  const auths = [...new Set([...(d.added || []), ...(d.removed || [])].map((r) => r.authority).filter(Boolean))].sort();
  $('cAuthority').innerHTML = '<option value="">All authorities</option>' +
    auths.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

  $('changesBody').hidden = false;
  renderAll(true);

  if (d.truncated) {
    // Be explicit rather than quietly showing a prefix: a user comparing this
    // page against a count elsewhere needs to know the list is capped.
    $('changesProvenance').textContent += ' · list capped at 3,000 per side';
  }
}

function exportCsv() {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['Change', 'Name', 'Authority', 'List', 'Type', 'Entity ID', 'Date published']];
  for (const r of filterRows(DATA.added || [])) rows.push(['added', r.name, r.authority, r.list, r.type, r.id, r.datePublished || '']);
  for (const r of filterRows(DATA.removed || [])) rows.push(['removed', r.name, r.authority, r.list, r.type, r.id, '']);
  rows.push([], ['From publication', DATA.from && DATA.from.publicationId], ['To publication', DATA.to && DATA.to.publicationId]);
  rows.push(['Delta computed', DATA.generatedAt], ['Exported', new Date().toISOString()]);
  rows.push(['Note', 'A removal is not self-executing — confirm the delisting with the issuing authority before releasing anything.']);
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const b = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u;
  a.download = `sanctions-search-changes-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
}

$('cAuthority').addEventListener('change', () => renderAll(true));
$('cText').addEventListener('input', () => renderAll(true));
$('addedMore').addEventListener('click', () => renderList('added', false));
$('removedMore').addEventListener('click', () => renderList('removed', false));
$('cExport').addEventListener('click', exportCsv);

(async () => {
  try {
    const { body: d } = await window.SS.getJson('api/changes');
    window.SS.renderCoverage(d.snapshot);
    if (d.unavailable) {
      $('changesProvenance').textContent = '';
      $('changesUnavailable').innerHTML =
        '<strong>No delta available yet.</strong> The comparison is written when the snapshot is rebuilt, ' +
        'so it appears after the next scheduled refresh. Until then this page cannot tell you what changed — ' +
        'which is different from telling you nothing changed.';
      $('changesUnavailable').hidden = false;
      return;
    }
    render(d);
  } catch (e) {
    $('changesProvenance').textContent = '';
    $('changesUnavailable').textContent = `Could not load the change list: ${e.message}`;
    $('changesUnavailable').hidden = false;
  }
})();
