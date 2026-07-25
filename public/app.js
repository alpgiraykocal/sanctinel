'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const GROUP_ORDER = ['Identity', 'Documents', 'Vessel / Aircraft', 'Digital & Contact', 'Program', 'Other'];

// Action guidance keyed to authority + list type. Triage hint, not a determination.
function determinationHint(r) {
  const l = r.list || '';
  if (r.authority === 'UN') return { label: 'UN asset freeze', text: 'UN Security Council listing: member states must <strong>freeze funds and economic resources</strong> and bar their provision. Apply the implementing national/EU regulation; this is not OFAC doctrine.' };
  if (r.authority === 'UK') return { label: 'UK asset freeze', text: 'UK OFSI designation: <strong>freeze funds/economic resources</strong> and do not make them available to or for the designated person; report to OFSI. UK regime, not OFAC.' };
  if (/CMIC/i.test(l)) return { label: 'Securities restriction', text: 'Non-SDN CMIC: restricts securities transactions — <strong>not</strong> full blocking. Do not freeze an ordinary payment on this basis alone.' };
  if (/CAPTA/i.test(l)) return { label: 'Correspondent account restriction', text: 'CAPTA: restricts or prohibits U.S. <strong>correspondent / payable-through accounts</strong> for the listed institution — not full blocking. Verify the specific restriction imposed.' };
  if (/FSE/i.test(l)) return { label: 'Foreign sanctions evader', text: 'FSE List: transactions and dealings with this party are <strong>prohibited</strong> for U.S. persons; property is not blocked. Reject rather than freeze.' };
  if (/Sectoral/i.test(l)) return { label: 'Sectoral directive', text: 'SSI: directive-based debt/equity tenor limits — <strong>not</strong> blocked. Verify the specific directive before acting.' };
  if (/Palestinian/i.test(l)) return { label: 'Reject', text: 'NS-PLC drives <strong>rejection</strong> rather than blocking. Return the transaction; do not hold funds.' };
  if (/Menu-Based/i.test(l)) return { label: 'Menu-based', text: 'Read the per-record measures — the imposed prohibition varies by entry.' };
  return { label: 'Potential block', text: 'SDN / Consolidated blocking list: if confirmed, <strong>block and freeze</strong>, then file the blocking report within the OFAC deadline. Apply the 50% Rule to owned entities.' };
}

function scoreClass(t) {
  if (t === 'exact' || t === 'strong' || t === 'strong_alias' || t === 'identifier') return 's-hi';
  if (t === 'fuzzy' || t === 'weak_alias') return 's-mid';
  return 's-low';
}

let pollTimer = null;
async function loadMeta() {
  try {
    const m = await fetch('/api/meta').then((r) => r.json());
    applyMeta(m);
    pollIfLoading(m);
  } catch { $('snapSource').textContent = 'Snapshot unavailable'; }
}

function applyMeta(m) {
  renderSnapshot(m);
  if ((m.authorities || []).length > 1) fillSelect($('authority'), m.authorities, 'All authorities (' + m.authorities.join(' · ') + ')');
  fillSelect($('list'), m.lists, 'All lists');
  fillSelect($('program'), m.programs, 'All programs');
  $('refreshBtn').hidden = !m.canRefresh; // hidden unless server has admin refresh enabled
}

// While a background live refresh runs, poll until it completes, then swap in
// the real snapshot metadata + filters without a page reload.
function pollIfLoading(m) {
  clearTimeout(pollTimer);
  if (!m.loading) return;
  pollTimer = setTimeout(async () => {
    try { const mm = await fetch('/api/meta').then((r) => r.json()); applyMeta(mm); pollIfLoading(mm); }
    catch { pollIfLoading(m); }
  }, 5000);
}

function fillSelect(sel, values, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = values.includes(cur) ? cur : '';
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function renderSnapshot(m) {
  $('snapDot').className = 'status-dot ' + (m.loading ? 'loading' : m.isLive ? 'live' : 'demo');
  const label = m.loading ? 'Updating…' : m.isLive ? 'Live' : 'Sample data';
  $('snapSource').textContent = label;
  const parties = `${(m.count || 0).toLocaleString()} parties`;
  const pub = m.publicationId && m.publicationId !== 'unknown' ? ` · OFAC pub ${m.publicationId}` : '';
  $('snapMeta').textContent = m.isLive ? `${parties}${pub}` : parties;
  const pill = $('statusPill');
  if (pill) pill.title = m.isLive ? `OFAC publication ${m.publicationId}${m.publishedDate ? ' (' + new Date(m.publishedDate).toLocaleDateString() + ')' : ''} · retrieved ${relTime(m.retrievedAt)}` : '';
}

let controller = null;
let lastResults = [];
async function runSearch(e) {
  if (e) e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  if (controller) controller.abort();
  controller = new AbortController();

  const params = new URLSearchParams({ q, authority: $('authority').value, list: $('list').value, program: $('program').value, threshold: $('threshold').value, yob: $('yob').value.trim(), country: $('country').value.trim() });
  $('emptyState').hidden = true;
  $('resultSummary').hidden = true;
  $('searchBtn').disabled = true;
  $('resultList').innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:14px"></div>';

  try {
    const data = await fetch('/api/search?' + params, { signal: controller.signal }).then((r) => r.json());
    lastResults = data.results;
    render(data);
    syncUrl(q);
  } catch (err) {
    if (err.name !== 'AbortError') $('resultList').innerHTML = `<div class="no-hits">Search failed: ${esc(err.message)}</div>`;
  } finally {
    $('searchBtn').disabled = false;
  }
}

function render(data) {
  const list = $('resultList');
  const summary = $('resultSummary');
  const n = data.results.length;
  summary.hidden = false;
  $('copyLinkBtn').hidden = false;
  summary.innerHTML = n
    ? `<strong>${n}</strong> potential match${n === 1 ? '' : 'es'} for <strong>“${esc(data.query)}”</strong> <span class="summary-sub">· screened against ${(data.snapshot.count || 0).toLocaleString()} sanctioned parties at threshold ${data.threshold}</span>`
    : '';

  if (!n) {
    list.innerHTML = `<div class="no-hits clear"><strong>No match</strong> for “${esc(data.query)}” at threshold ${data.threshold}.<br>Absence of a hit is not a clearance — confirm the snapshot is current and consider lowering the threshold for a below-the-line check.</div>`;
    return;
  }

  list.innerHTML = data.results.map((r, i) => card(r, i)).join('');
  list.querySelectorAll('.rc-toggle').forEach((btn) => btn.addEventListener('click', () => {
    const d = btn.closest('.result-card').querySelector('.rc-detail');
    const open = d.hasAttribute('hidden');
    if (open) d.removeAttribute('hidden'); else d.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('span').textContent = open ? 'Hide full record' : 'Show full record';
  }));
  list.querySelectorAll('.rc-graph').forEach((btn) => btn.addEventListener('click', () => {
    if (window.OFACGraph) window.OFACGraph.open(btn.dataset.id);
  }));
  list.querySelectorAll('.rc-copy').forEach((btn) => btn.addEventListener('click', () => {
    const rec = lastResults[Number(btn.dataset.i)];
    navigator.clipboard.writeText(JSON.stringify(rec, null, 2)).then(() => {
      btn.textContent = 'Copied JSON';
      setTimeout(() => (btn.textContent = 'Copy JSON'), 1500);
    });
  }));
  list.querySelectorAll('.rc-csv').forEach((btn) => btn.addEventListener('click', () => {
    const r = lastResults[Number(btn.dataset.i)];
    download(`sanctinel-${r.id}.csv`, toCsv(r), 'text/csv;charset=utf-8');
  }));
  list.querySelectorAll('.rc-print').forEach((btn) => btn.addEventListener('click', () => printMemo(lastResults[Number(btn.dataset.i)])));
}

function attrGroups(attributes) {
  const groups = {};
  for (const a of attributes || []) (groups[a.group] ||= []).push(a);
  return GROUP_ORDER.filter((g) => groups[g]).map((g) => ({ group: g, rows: groups[g] }));
}

function card(r, i) {
  const hint = determinationHint(r);
  const idHit = r.matchType === 'identifier';
  const sc = scoreClass(r.matchType);
  const primary = (r.names || []).find((n) => n.primary) || { name: r.name };
  const aliases = (r.names || []).filter((n) => !n.primary);
  const sanctionsTypes = r.sanctionsTypes || [];
  const owns = (r.relationships || []).filter((x) => /own|control|subsid|parent/i.test(x.type));

  const nativeLine = primary.native ? `<div class="detail-row"><dt>Primary (native)</dt><dd class="native">${esc(primary.native)}${primary.script ? ` <span class="script-tag">${esc(primary.script)}</span>` : ''}</dd></div>` : '';
  const partsLine = (primary.parts || []).length ? `<div class="detail-row"><dt>Name parts</dt><dd>${primary.parts.map(esc).join(' · ')}</dd></div>` : '';
  const aliasHtml = aliases.length
    ? `<ul class="name-list">${aliases.map((a) => `<li><span class="alias-type">${esc(a.type)}</span> ${esc(a.name)}${a.native ? ` <span class="native">${esc(a.native)}</span>` : ''}${a.lowQuality ? ' <span class="lowq">low-quality</span>' : ''}</li>`).join('')}</ul>`
    : '<em>none</em>';

  const addrHtml = (r.addresses || []).length
    ? `<ul>${r.addresses.map((a) => `<li>${esc(a.full || a)}</li>`).join('')}</ul>` : '<em>—</em>';

  const groupsHtml = attrGroups(r.attributes).map((g) => `
    <div class="attr-group">
      <h4 class="attr-group-title">${esc(g.group)}</h4>
      <dl class="attr-grid">
        ${g.rows.map((row) => `<div class="detail-row"><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join('')}
      </dl>
    </div>`).join('');

  const docsHtml = (r.idDocuments || []).length ? `
    <div class="attr-group">
      <h4 class="attr-group-title">Identity Documents</h4>
      <div class="doc-table">
        ${r.idDocuments.map((d) => `<div class="doc-row">
          <span class="doc-type">${esc(d.type)}</span>
          <span class="doc-num">${esc(d.number || '—')}</span>
          <span class="doc-meta">${[d.issuingCountry && `issued by ${esc(d.issuingCountry)}`, d.issueDate && `issued ${esc(d.issueDate)}`, d.expirationDate && `expires ${esc(d.expirationDate)}`].filter(Boolean).join(' · ') || ''}</span>
        </div>`).join('')}
      </div>
    </div>` : '';

  const relHtml = (r.relationships || []).length ? `
    <div class="attr-group">
      <h4 class="attr-group-title">Relationships & Ownership</h4>
      <ul class="name-list">
        ${r.relationships.map((x) => `<li><span class="rel-type">${esc(x.type)}</span> ${esc(x.relatedName)}${x.relatedId ? ` <span class="rel-id">#${esc(x.relatedId)}</span>` : ''}</li>`).join('')}
      </ul>
      ${owns.length ? '<p class="rel-note">50% Rule: entities owned 50%+ (individually or in aggregate) by a blocked person are themselves blocked, listed or not. Trace this chain.</p>' : ''}
    </div>` : '';

  const idsHtml = (r.identifiers || []).length
    ? `<div class="rc-tags ids">${r.identifiers.map((id) => `<span class="tag tag-id"><span class="id-type">${esc(id.type)}</span> ${esc(id.value)}</span>`).join('')}</div>`
    : '';

  return `
  <article class="result-card mt-${esc(r.matchType)}">
    <div class="rc-head">
      <div>
        <h3 class="rc-name">${esc(primary.name)}</h3>
        <p class="rc-sub">${esc(r.type)} · ID ${esc(r.id)} · matched on <span class="matched-alias">${esc(r.matchedField)}</span>${idHit || r.matchedField.indexOf('primary') === -1 ? ` — “${esc(r.matchedName)}”` : ''}</p>
      </div>
      <div class="score-badge ${sc}">
        <span class="score-num">${r.score.toFixed(2)}</span>
        <span class="score-type">${esc(r.matchType.replace('_', ' '))}</span>
        ${r.corroborated ? '<span class="corrob-flag ok">ID ✓</span>' : ''}
        ${r.conflict ? '<span class="corrob-flag bad">ID ✗</span>' : ''}
      </div>
    </div>

    <div class="rc-tags">
      <span class="tag tag-auth auth-${esc((r.authority || 'OFAC').toLowerCase())}">${esc(r.authority || 'OFAC')}</span>
      <span class="tag tag-list">${esc(r.list)}</span>
      ${(r.programs || []).map((p) => `<span class="tag tag-prog">${esc(p)}</span>`).join('')}
      ${sanctionsTypes.map((t) => `<span class="tag tag-type">${esc(t)}</span>`).join('')}
      ${owns.length ? '<span class="tag tag-own">50% Rule</span>' : ''}
    </div>

    ${r.explain ? `<p class="rc-explain"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z"/></svg> Matched on ${esc(r.explain)}</p>` : ''}

    <div class="determination"><strong>${esc(hint.label)}:</strong> ${hint.text}</div>

    <div class="rc-detail" hidden>
      <div class="attr-group">
        <h4 class="attr-group-title">Names & Aliases</h4>
        <dl class="attr-grid">
          ${nativeLine}${partsLine}
          <div class="detail-row"><dt>Aliases</dt><dd>${aliasHtml}</dd></div>
        </dl>
      </div>
      ${groupsHtml}
      ${docsHtml}
      ${relHtml}
      ${idsHtml ? `<div class="attr-group"><h4 class="attr-group-title">Screening Identifiers</h4>${idsHtml}</div>` : ''}
      <div class="attr-group">
        <h4 class="attr-group-title">Program & Provenance</h4>
        <dl class="attr-grid">
          ${r.title ? `<div class="detail-row"><dt>Title</dt><dd>${esc(r.title)}</dd></div>` : ''}
          <div class="detail-row"><dt>Programs</dt><dd>${(r.programs || []).map(esc).join(', ') || '—'}</dd></div>
          ${sanctionsTypes.length ? `<div class="detail-row"><dt>Sanctions Type</dt><dd>${sanctionsTypes.map(esc).join(', ')}</dd></div>` : ''}
          ${(r.legalAuthorities || []).length ? `<div class="detail-row"><dt>Legal Authority</dt><dd>${r.legalAuthorities.map(esc).join('; ')}</dd></div>` : ''}
          ${r.datePublished ? `<div class="detail-row"><dt>Date Published</dt><dd>${esc(r.datePublished)}</dd></div>` : ''}
          <div class="detail-row"><dt>Addresses</dt><dd>${addrHtml}</dd></div>
          ${r.remarks ? `<div class="detail-row"><dt>Raw Remarks</dt><dd class="raw">${esc(r.remarks)}</dd></div>` : ''}
        </dl>
      </div>
    </div>
    <div class="rc-actions">
      <button class="rc-toggle" type="button" aria-expanded="false"><span>Show full record</span></button>
      ${(r.relationships || []).length ? `<button class="rc-graph" type="button" data-id="${esc(r.id)}">View network</button>` : ''}
      <button class="rc-print" type="button" data-i="${i}">Print / PDF</button>
      <button class="rc-csv" type="button" data-i="${i}">CSV</button>
      <button class="rc-copy" type="button" data-i="${i}">Copy JSON</button>
    </div>
  </article>`;
}

async function refreshLive() {
  const btn = $('refreshBtn');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  try {
    const res = await fetch('/api/refresh', { method: 'POST' }).then((r) => r.json());
    if (!res.ok) { alert('Live refresh unavailable: ' + res.error); applyMeta(res.meta); return; }
    applyMeta(res.meta); pollIfLoading(res.meta);
  } catch (e) { alert('Live refresh error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Refresh live'; }
}

// ---- export helpers ----
function download(name, text, type) {
  const b = new Blob([text], { type });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(u);
}

function toCsv(r) {
  const aliases = (r.names || []).filter((n) => !n.primary).map((n) => `${n.type}: ${n.name}`).join(' | ');
  const rows = [
    ['Field', 'Value'],
    ['Name', r.name], ['Type', r.type], ['OFAC entity ID', r.id], ['List', r.list],
    ['Programs', (r.programs || []).join('; ')], ['Sanctions types', (r.sanctionsTypes || []).join('; ')],
    ['Legal authorities', (r.legalAuthorities || []).join('; ')], ['Date published', r.datePublished || ''],
    ['Aliases', aliases], ['Addresses', (r.addresses || []).map((a) => a.full || a).join(' | ')],
    ['Identifiers', (r.identifiers || []).map((i) => `${i.type} ${i.value}`).join(' | ')],
    ['Relationships', (r.relationships || []).map((x) => `${x.type} ${x.relatedName}`).join(' | ')],
    ...(r.attributes || []).map((a) => [a.label, a.value]),
    ['Match score', r.score], ['Match type', r.matchType], ['Matched on', `${r.matchedField}${r.explain ? ' — ' + r.explain : ''}`],
    ['Screened at', new Date().toISOString()], ['Source', 'OFAC SLS via Sanctinel — educational, not legal advice'],
  ];
  return '﻿' + rows.map((row) => row.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function memoHtml(r) {
  const hint = determinationHint(r);
  const list = (arr, f) => (arr || []).map(f).join('');
  const aliases = (r.names || []).filter((n) => !n.primary);
  return `
    <h1>Sanctions screening record</h1>
    <p class="memo-sub">Generated ${new Date().toLocaleString()} · Sanctinel · educational analysis, not legal advice</p>
    <h2>${esc(r.name)}</h2>
    <p>${esc(r.type)} · OFAC entity ID ${esc(r.id)} · <strong>${esc(r.list)}</strong></p>
    <table>
      <tr><th>Determination guidance</th><td><strong>${esc(hint.label)}.</strong> ${hint.text.replace(/<[^>]+>/g, '')}</td></tr>
      <tr><th>Match</th><td>score ${r.score.toFixed(2)} (${esc(r.matchType.replace('_', ' '))}) · matched on ${esc(r.matchedField)}${r.explain ? ' — ' + esc(r.explain) : ''}</td></tr>
      <tr><th>Programs</th><td>${esc((r.programs || []).join(', ') || '—')}</td></tr>
      ${(r.sanctionsTypes || []).length ? `<tr><th>Sanctions type</th><td>${esc(r.sanctionsTypes.join(', '))}</td></tr>` : ''}
      ${(r.legalAuthorities || []).length ? `<tr><th>Legal authority</th><td>${esc(r.legalAuthorities.join('; '))}</td></tr>` : ''}
      ${r.datePublished ? `<tr><th>Date published</th><td>${esc(r.datePublished)}</td></tr>` : ''}
      ${aliases.length ? `<tr><th>Aliases</th><td>${list(aliases, (a) => `${esc(a.type)} ${esc(a.name)}<br>`)}</td></tr>` : ''}
      ${(r.identifiers || []).length ? `<tr><th>Identifiers</th><td>${list(r.identifiers, (i) => `${esc(i.type)}: ${esc(i.value)}<br>`)}</td></tr>` : ''}
      ${(r.addresses || []).length ? `<tr><th>Addresses</th><td>${list(r.addresses, (a) => `${esc(a.full || a)}<br>`)}</td></tr>` : ''}
      ${(r.relationships || []).length ? `<tr><th>Relationships</th><td>${list(r.relationships, (x) => `${esc(x.type)}: ${esc(x.relatedName)}<br>`)}</td></tr>` : ''}
    </table>
    <p class="memo-foot">Screening analysis only — not a determination and not legal advice. Confirm against OFAC's official Sanctions List Search (sanctionssearch.ofac.treas.gov) before any compliance decision. Apply the 50% Rule to ownership.</p>`;
}

function printMemo(r) {
  const el = $('printArea');
  el.innerHTML = memoHtml(r);
  document.body.classList.add('printing');
  window.print();
  setTimeout(() => document.body.classList.remove('printing'), 500);
}

// ---- shareable URL ----
function syncUrl(q) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if ($('threshold').value !== '0.95') p.set('threshold', $('threshold').value);
  if ($('authority').value) p.set('authority', $('authority').value);
  if ($('list').value) p.set('list', $('list').value);
  if ($('program').value) p.set('program', $('program').value);
  if ($('yob').value.trim()) p.set('yob', $('yob').value.trim());
  if ($('country').value.trim()) p.set('country', $('country').value.trim());
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function initFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('threshold')) { $('threshold').value = p.get('threshold'); $('threshOut').textContent = parseFloat(p.get('threshold')).toFixed(2); }
  if (p.get('authority')) $('authority').value = p.get('authority');
  if (p.get('list')) $('list').value = p.get('list');
  if (p.get('program')) $('program').value = p.get('program');
  if (p.get('yob')) $('yob').value = p.get('yob');
  if (p.get('country')) $('country').value = p.get('country');
  if (p.get('q')) { $('q').value = p.get('q'); runSearch(); }
}

$('searchForm').addEventListener('submit', runSearch);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
document.querySelectorAll('.chip[data-q]').forEach((c) => c.addEventListener('click', () => { $('q').value = c.dataset.q; runSearch(); }));
$('threshold').addEventListener('input', (e) => { $('threshOut').textContent = parseFloat(e.target.value).toFixed(2); });
$('authority').addEventListener('change', () => $('q').value.trim() && runSearch());
$('list').addEventListener('change', () => $('q').value.trim() && runSearch());
$('program').addEventListener('change', () => $('q').value.trim() && runSearch());
$('refreshBtn').addEventListener('click', refreshLive);
$('copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => {
    const b = $('copyLinkBtn'); b.textContent = 'Link copied'; setTimeout(() => (b.textContent = 'Copy link'), 1500);
  });
});
loadMeta().then(initFromUrl);
