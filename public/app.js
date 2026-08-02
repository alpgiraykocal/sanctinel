'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));



// Verification links live in chrome.js so the banner renders identically on the
// insights and about pages, which have no app.js.
const AUTHORITY_URL = window.SS.AUTHORITY_URL;





function scoreClass(t) {
  if (t === 'exact' || t === 'strong' || t === 'strong_alias' || t === 'identifier') return 's-hi';
  if (t === 'fuzzy' || t === 'weak_alias') return 's-mid';
  return 's-low';
}

let pollTimer = null;
async function loadMeta() {
  try {
    // Waits out a cold start rather than reporting a failure the user cannot act on.
    const { body: m } = await window.SS.getJson('api/meta', {
      onWait: () => { $('snapSource').textContent = 'Starting…'; },
    });
    if (!m || typeof m.count !== 'number') { $('snapSource').textContent = 'Snapshot unavailable'; return; }
    applyMeta(m);
    pollIfLoading(m);
  } catch { $('snapSource').textContent = 'Snapshot unavailable'; }
}

function applyMeta(m) {
  renderSnapshot(m);
  renderCoverage(m);
  if ((m.authorities || []).length > 1) fillSelect($('authority'), m.authorities, 'All authorities (' + m.authorities.join(' · ') + ')');
  fillSelect($('list'), m.lists, 'All lists');
  fillSelect($('program'), m.programs, 'All programs');
  $('refreshBtn').hidden = !m.canRefresh; // hidden unless server has admin refresh enabled
}

const renderCoverage = window.SS.renderCoverage;

// Record rendering is shared with the permalink page (record.js) so the two
// views can never give different compliance guidance for the same party.
const {
  AUTHORITY_SOURCE, listsOf, determinationHint,
  factsHtml, tagsHtml, detailHtml, permalink,
} = window.SSRecord;
// This page fetches /api/meta itself (loadMeta) and hands the result to
// renderCoverage, so chrome.js must not fetch the same thing again.
window.SS.ownsMeta = true;

// While a background live refresh runs, poll until it completes, then swap in
// the real snapshot metadata + filters without a page reload.
function pollIfLoading(m) {
  clearTimeout(pollTimer);
  if (!m.loading) return;
  pollTimer = setTimeout(async () => {
    try { const { body: mm } = await window.SS.getJson('api/meta'); applyMeta(mm); pollIfLoading(mm); }
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
  if (pill) {
    const auth = (m.authorities || []).length ? `Authorities: ${m.authorities.join(', ')}\n` : '';
    pill.title = m.isLive
      ? `${auth}OFAC publication ${m.publicationId}${m.publishedDate ? ' (' + new Date(m.publishedDate).toLocaleDateString() + ')' : ''}\nRetrieved ${relTime(m.retrievedAt)}`
      : '';
  }
}

let controller = null;
let lastResults = [];   // rows as rendered (sorted) — card handlers index into this
let lastData = null;    // last server payload, so re-sorting needs no refetch
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
    const { res, body: data } = await window.SS.getJson('api/search?' + params, {
      init: { signal: controller.signal },
      onWait: () => { $('resultList').innerHTML = '<div class="no-hits">Server is starting up and loading the sanctions snapshot — retrying…</div>'; },
    });
    // Rate limits and server errors come back as {error}. Without this the
    // render path hit `data.results.length` on undefined and the analyst saw a
    // JavaScript type error instead of "search rate limit exceeded".
    if (!res.ok || !Array.isArray(data.results)) {
      const reason = data.error || `server responded ${res.status}`;
      const retry = res.status === 429 ? ' Wait a minute and try again.' : '';
      $('resultSummary').hidden = true;
      $('resultList').innerHTML = `<div class="no-hits"><strong>Search unavailable:</strong> ${esc(reason)}.${retry}</div>`;
      return;
    }
    lastData = data;
    render(data);
    syncUrl(q);
  } catch (err) {
    if (err.name !== 'AbortError') $('resultList').innerHTML = `<div class="no-hits">Search failed: ${esc(err.message)}</div>`;
  } finally {
    $('searchBtn').disabled = false;
  }
}

/*
 * Every filter currently narrowing the result set, as removable chips.
 *
 * The filters live in a side panel that scrolls out of view, so a value left
 * over from an earlier query keeps trimming later ones invisibly — and a result
 * set that is short because of a filter looks exactly like one that is short
 * because the party is clean. Naming them next to the count removes the
 * ambiguity, and each chip is also the way to undo it.
 */
function renderActiveFilters() {
  const box = $('activeFilters');
  const chips = [];
  const add = (id, label, value, reset) => { if (value) chips.push({ id, label, value, reset }); };
  add('authority', 'Authority', $('authority').value, '');
  add('list', 'List', $('list').value, '');
  add('program', 'Program', $('program').value, '');
  add('yob', 'Year of birth', $('yob').value.trim(), '');
  add('country', 'Country', $('country').value.trim(), '');
  if ($('threshold').value !== '0.95') chips.push({ id: 'threshold', label: 'Threshold', value: $('threshold').value, reset: '0.95' });

  if (!chips.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = `<span class="af-label">Filtered by</span>` + chips.map((c) =>
    `<button class="af-chip" type="button" data-id="${esc(c.id)}" data-reset="${esc(c.reset)}" title="Remove this filter">
       <span class="af-key">${esc(c.label)}</span> ${esc(c.value)} <span aria-hidden="true">×</span>
       <span class="sr-only">— remove filter</span>
     </button>`).join('') +
    `<button class="af-clear" type="button" id="clearFiltersBtn">Clear all</button>`;
  box.hidden = false;

  box.querySelectorAll('.af-chip').forEach((b) => b.addEventListener('click', () => {
    const el = $(b.dataset.id);
    el.value = b.dataset.reset;
    if (b.dataset.id === 'threshold') $('threshOut').textContent = parseFloat(el.value).toFixed(2);
    runSearch();
  }));
  $('clearFiltersBtn').addEventListener('click', () => {
    for (const id of ['authority', 'list', 'program', 'yob', 'country']) $(id).value = '';
    $('threshold').value = '0.95';
    $('threshOut').textContent = '0.95';
    runSearch();
  });
}

// Sorting is applied client-side over the slice the server returned, so it
// reorders what is on screen — it does not reach past the truncation point.
// The summary says how many were withheld, so that stays honest.
// Ownership groups first (largest first), unaffiliated parties last; within a
// group, the usual ranking.
function clusterKey(r) { return (r.cluster && r.cluster.id) || ''; }

function sortResults(rows) {
  const mode = $('sortBy').value;
  const copy = rows.slice();
  if (mode === 'name') copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === 'date') copy.sort((a, b) => (Date.parse(b.datePublished) || 0) - (Date.parse(a.datePublished) || 0));
  else if (mode === 'cluster') {
    const seen = new Map();
    for (const r of copy) { const k = clusterKey(r); seen.set(k, (seen.get(k) || 0) + 1); }
    copy.sort((a, b) => {
      const ka = clusterKey(a), kb = clusterKey(b);
      if (!ka !== !kb) return ka ? -1 : 1;              // unaffiliated last
      if (ka !== kb) return (seen.get(kb) - seen.get(ka)) || ka.localeCompare(kb);
      return rankResults(a, b);
    });
  }
  // Same comparator the server ranks with. Sorting on score alone here would
  // undo the tiebreak and put the arbitrary order back: a single-token query
  // caps every hit at 0.96, so ties are the normal case, not the edge case.
  else copy.sort(rankResults);
  return copy;
}

/*
 * Say when the leading hits are tied.
 *
 * The scorer caps a single-token query against a multi-token name at exactly
 * 0.96, so "Putin" produces 15 hits on one score — all three-token names
 * matching on one token, genuinely indistinguishable on the name alone. A
 * reader takes row one for the best answer regardless, so the ordering has to
 * disclaim itself and point at what does separate these parties: the
 * corroborating identifiers, and the DOB/nationality already on each card.
 */
function tieNote(data) {
  const n = data.topScoreTies || 0;
  if (n < 3) return '';

  /*
   * When the tied rows are one party listed by several authorities, saying
   * "compare the date of birth to separate them" is advice against the data:
   * there is nothing to separate, and following it wastes the reviewer's time
   * on four copies of one decision. Detect that case and say the opposite.
   */
  const tied = (data.results || []).filter((r) => r.score === data.topScore);
  const clusters = new Set(tied.map((r) => (r.crossListed && r.crossListed.clusterId) || `_${r.id}`));
  if (tied.length >= 3 && clusters.size === 1 && tied[0].crossListed) {
    const authorities = [...new Set(tied.map((r) => r.authority))].sort();
    return `<span class="tie-note">
      <strong>${tied.length} hits share the top score of ${Number(data.topScore).toFixed(2)} — and they are one party.</strong>
      ${authorities.join(', ')} have each listed the same person or entity, so this is
      one decision rather than ${tied.length}. The designations still differ: check the
      programme, dates and prohibitions on each.
    </span>`;
  }

  return `<span class="tie-note">
    <strong>${n} hits share the top score of ${Number(data.topScore).toFixed(2)}.</strong>
    The name alone cannot separate them and their order here is not a ranking —
    compare the date of birth, nationality and country on each card, or add a
    year of birth / country above to score the corroborating identifiers.
  </span>`;
}

// Mirror of server.js rankResults — primary name over alias, then id. Anything
// finer would invent a ranking the data does not support.
function rankResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const primary = (r) => (r.matchedField === "primary name" ? 0 : 1);
  if (primary(a) !== primary(b)) return primary(a) - primary(b);
  return String(a.id).localeCompare(String(b.id));
}

function render(data) {
  const list = $('resultList');
  const summary = $('resultSummary');
  const shown = data.results.length;
  renderActiveFilters();
  // The server caps the payload at the top-scoring slice. Report the number of
  // parties that actually cleared the threshold, and say plainly when the list
  // below is only part of it — an under-reported hit count is a compliance
  // problem, not a display detail.
  const total = typeof data.count === 'number' ? data.count : shown;
  const truncated = data.truncated || total > shown;
  $('copyLinkBtn').hidden = false;
  $('exportAllBtn').hidden = !total;
  // Offered on any completed search, including one with no hits — "nothing at
  // 0.95" is exactly when an analyst needs to see whether something sits at 0.92.
  $('btlBtn').hidden = false;
  $('btlPanel').hidden = true;
  $('sortWrap').hidden = total < 2;
  summary.hidden = !total;
  summary.innerHTML = total
    ? `<strong>${total.toLocaleString()}</strong> potential match${total === 1 ? '' : 'es'} for <strong>“${esc(data.query)}”</strong> <span class="summary-sub">· screened against ${(data.snapshot.count || 0).toLocaleString()} listed parties at threshold ${data.threshold}</span>${
        truncated ? `<span class="truncation-note">Showing the ${shown.toLocaleString()} highest-scoring — narrow the query or raise the threshold to see the rest.</span>` : ''}${
        tieNote(data)}`
    : '';

  if (!total) {
    const scope = $('authority').value ? `the ${esc($('authority').value)} list` : 'the sanctions and export-control lists';
    list.innerHTML = `<div class="no-hits clear"><strong>No match</strong> for “${esc(data.query)}” in ${scope} at threshold ${data.threshold}.<br>Absence of a hit is not a clearance — these lists do not cover every regime (other national and dual-use lists are not included), so confirm the snapshot is current before relying on this.</div>`;
    /*
     * A zero-result screen is the one a user is most likely to read as "clean",
     * and it was the one offering the least. The server can already say whether
     * anything scored just under the line, whether any party's name starts with
     * what was typed, and whether the query looks like an identifier the
     * snapshot barely carries — so run that automatically here instead of
     * waiting for someone to think of pressing the button.
     */
    runBelowTheLine({ auto: true });
    return;
  }

  // Card action handlers address rows by index, so the array they index into
  // must be the one that was rendered — sort first, then keep that order.
  const rows = sortResults(data.results);
  lastResults = rows;
  list.innerHTML = $('sortBy').value === 'cluster' ? groupedHtml(rows) : rows.map((r, i) => card(r, i)).join('');
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
    // Write into the label span, not the button: btn.textContent would also
    // delete the icon that sits beside it.
    const label = btn.querySelector('span');
    // The clipboard API rejects without a permission or a trusted gesture, and
    // an unhandled rejection here would look exactly like a successful copy —
    // the user walks away with an empty clipboard. Say which one happened.
    copyText(JSON.stringify(rec, null, 2)).then((ok) => {
      label.textContent = ok ? 'Copied' : 'Copy failed';
      btn.classList.add(ok ? 'is-done' : 'is-failed');
      setTimeout(() => { label.textContent = 'JSON'; btn.classList.remove('is-done', 'is-failed'); }, 1800);
    });
  }));
  list.querySelectorAll('.rc-csv').forEach((btn) => btn.addEventListener('click', () => {
    const r = lastResults[Number(btn.dataset.i)];
    download(`sanctions-search-${r.id}.csv`, toCsv(r), 'text/csv;charset=utf-8');
  }));
  list.querySelectorAll('.rc-print').forEach((btn) => btn.addEventListener('click', () => printMemo(lastResults[Number(btn.dataset.i)])));
}


/*
 * Results under ownership-group headings.
 *
 * The heading says how many of THESE HITS fall in the group and how large the
 * group is in the whole snapshot — because "12 of your hits, out of a 44-party
 * structure" tells the analyst there are 32 more members they have not seen,
 * which is the 50 Percent Rule question wearing a different hat.
 *
 * Card indices must stay aligned with lastResults, so cards are numbered from
 * the flat sorted array rather than restarting per group.
 */
function groupedHtml(rows) {
  const groups = [];
  let cur = null;
  rows.forEach((r, i) => {
    const key = clusterKey(r);
    if (!cur || cur.key !== key) { cur = { key, cluster: r.cluster, items: [] }; groups.push(cur); }
    cur.items.push({ r, i });
  });

  return groups.map((g) => {
    const head = g.cluster
      ? `<div class="grp-head">
           <h3 class="grp-name">${esc(g.cluster.label || 'Ownership group')}</h3>
           <p class="grp-meta">
             ${g.items.length} of your hits ${g.items.length === 1 ? 'is' : 'are'} in this structure ·
             ${g.cluster.size.toLocaleString()} listed ${g.cluster.size === 1 ? 'party' : 'parties'} in it overall${
               g.cluster.size > g.items.length ? ` · ${(g.cluster.size - g.items.length).toLocaleString()} more not matched by this query` : ''}
           </p>
         </div>`
      : `<div class="grp-head grp-head-none">
           <h3 class="grp-name">No ownership link in the list data</h3>
           <p class="grp-meta">${g.items.length} ${g.items.length === 1 ? 'party' : 'parties'} with no ownership relationship published — which is not evidence they have none.</p>
         </div>`;
    return `<section class="grp">${head}${g.items.map(({ r, i }) => card(r, i)).join('')}</section>`;
  }).join('');
}

function card(r, i) {
  const hint = determinationHint(r);
  const idHit = r.matchType === "identifier";
  const primary = (r.names || []).find((n) => n.primary) || { name: r.name };
  return `
  <article class="result-card mt-${esc(r.matchType)}">
    <div class="rc-head">
      <div>
        <h3 class="rc-name"><a class="rc-permalink" href="${permalink(r.id)}" title="Open this record on its own page">${esc(primary.name)}</a></h3>
        <p class="rc-sub">${esc(r.type)} · ID ${esc(r.id)} · matched on <span class="matched-alias">${esc(r.matchedField)}</span>${idHit || r.matchedField.indexOf("primary") === -1 ? ` — “${esc(r.matchedName)}”` : ""}</p>
      </div>
      <div class="score-badge ${scoreClass(r.matchType)}">
        <span class="score-num">${r.score.toFixed(2)}</span>
        <span class="score-type">${esc(r.matchType.replace("_", " "))}</span>
        ${r.corroborated ? '<span class="corrob-flag ok">ID ✓</span>' : ""}
        ${r.conflict ? '<span class="corrob-flag bad">ID ✗</span>' : ""}
      </div>
    </div>

    ${factsHtml(r)}
    ${tagsHtml(r)}

    ${r.explain ? `<p class="rc-explain"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z"/></svg> Matched on ${esc(r.explain)}</p>` : ""}

    <div class="determination"><strong>${esc(hint.label)}:</strong> ${hint.text}</div>

    <div class="rc-detail" hidden>${detailHtml(r)}</div>
    <div class="rc-actions">
      <div class="rc-act-group">
        <button class="rc-act rc-act-view rc-toggle" type="button" aria-expanded="false"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg><span>Show full record</span></button>
        ${(r.relationships || []).length ? `<button class="rc-act rc-act-view rc-graph" type="button" data-id="${esc(r.id)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M17 14a3 3 0 0 0-2.6 1.5l-3.6-2a3 3 0 0 0 0-3l3.6-2A3 3 0 1 0 13.5 6l-3.6 2a3 3 0 1 0 0 8l3.6 2A3 3 0 1 0 17 14Z"/></svg><span>Network</span></button>` : ""}
      </div>
      <div class="rc-act-group rc-act-export">
        <a class="rc-act rc-link" href="${permalink(r.id)}" title="Stable link to this record"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 1 0-1.4l1.4-1.4a1 1 0 0 1 1.4 1.4l-1.4 1.4a1 1 0 0 1-1.4 0Zm-3 4.4a4 4 0 0 1 0-5.7l2.1-2.1 1.4 1.4-2.1 2.1a2 2 0 0 0 2.9 2.9l2.1-2.1 1.4 1.4-2.1 2.1a4 4 0 0 1-5.7 0Zm9-9a4 4 0 0 0-5.7 0l-2.1 2.1 1.4 1.4 2.1-2.1a2 2 0 0 1 2.9 2.9l-2.1 2.1 1.4 1.4 2.1-2.1a4 4 0 0 0 0-5.7Z"/></svg><span>Permalink</span></a>
        <button class="rc-act rc-print" type="button" data-i="${i}" title="Printable screening memo"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 3h10v4H7V3Zm12 6H5a2 2 0 0 0-2 2v6h4v4h10v-4h4v-6a2 2 0 0 0-2-2Zm-4 10H9v-5h6v5Z"/></svg><span>Print</span></button>
        <button class="rc-act rc-csv" type="button" data-i="${i}" title="Download this record as CSV"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 3v10m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path fill="currentColor" d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2h-2v2H6v-2H4Z"/></svg><span>CSV</span></button>
        <button class="rc-act rc-copy" type="button" data-i="${i}" title="Copy the raw record as JSON"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 4H8a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1m6-14h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/></svg><span>JSON</span></button>
      </div>
    </div>
  </article>`;
}

async function refreshLive() {
  const btn = $('refreshBtn');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  try {
    const res = await fetch('api/refresh', { method: 'POST' }).then((r) => r.json());
    if (!res.ok) { alert('Live refresh unavailable: ' + res.error); applyMeta(res.meta); return; }
    applyMeta(res.meta); pollIfLoading(res.meta);
  } catch (e) { alert('Live refresh error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Refresh'; }
}

// ---- export helpers ----

// Resolves true/false rather than throwing, so every caller can report the
// outcome instead of silently assuming the copy worked.
function copyText(text) {
  if (!navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true, () => false);
}

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
    ['Name', r.name], ['Type', r.type], ['Authority', r.authority || 'OFAC'], ['Entity ID', r.id], ['Lists', listsOf(r).join('; ')],
    ['Programs', (r.programs || []).join('; ')], ['Sanctions types', (r.sanctionsTypes || []).join('; ')],
    ['Legal authorities', (r.legalAuthorities || []).join('; ')], ['Date published', r.datePublished || ''],
    ['Aliases', aliases], ['Addresses', (r.addresses || []).map((a) => a.full || a).join(' | ')],
    ['Identifiers', (r.identifiers || []).map((i) => `${i.type} ${i.value}`).join(' | ')],
    ['Relationships', (r.relationships || []).map((x) => `${x.type} ${x.relatedName}`).join(' | ')],
    // The 50% Rule findings belong in the exported record too — this file is
    // what ends up in the compliance folder, and the caveat has to travel with
    // the finding rather than only living in the UI.
    ['Blocked owners in chain', r.derivative ? String(r.derivative.distinctBlockedOwners) : '0'],
    ['50% aggregate test applies', r.derivative && r.derivative.aggregationCandidate ? 'Yes — multiple blocked owners' : 'No'],
    ['50% Rule caveat', 'OFAC publishes no ownership percentages; the threshold cannot be computed from list data. Confirm stakes against corporate registry / KYC records.'],
    ...(r.attributes || []).map((a) => [a.label, a.value]),
    ['Match score', r.score], ['Match type', r.matchType], ['Matched on', `${r.matchedField}${r.explain ? ' — ' + r.explain : ''}`],
    ['Screened at', new Date().toISOString()],
    ['Source', `${r.authority || 'OFAC'} official list via Sanctions Search — educational analysis, not legal advice`],
  ];
  return '﻿' + rows.map((row) => row.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function memoHtml(r) {
  const hint = determinationHint(r);
  const list = (arr, f) => (arr || []).map(f).join('');
  const aliases = (r.names || []).filter((n) => !n.primary);
  return `
    <h1>Sanctions screening record</h1>
    <p class="memo-sub">Generated ${new Date().toLocaleString()} · Sanctions Search · educational analysis, not legal advice</p>
    <h2>${esc(r.name)}</h2>
    <p>${esc(r.type)} · ${esc(r.authority || 'OFAC')} entity ID ${esc(r.id)} · <strong>${esc(listsOf(r).join(' · '))}</strong></p>
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
    <p class="memo-foot">Screening analysis only — not a determination and not legal advice. Confirm against the issuing authority's own list before any compliance decision: ${esc(AUTHORITY_SOURCE[r.authority] || AUTHORITY_SOURCE.OFAC)}. For OFAC designations, apply the 50% Rule to ownership. Export-control listings (BIS/State) impose licence requirements, not asset freezes.</p>`;
}

function printMemo(r) {
  const el = $('printArea');
  el.innerHTML = memoHtml(r);
  // Clear once printing is done so a screened party's record does not sit in
  // the DOM for the rest of the session. afterprint fires in every current
  // browser; the timeout only covers a dialog that never reports back.
  const clear = () => { el.innerHTML = ''; window.removeEventListener('afterprint', clear); };
  window.addEventListener('afterprint', clear);
  setTimeout(clear, 60000);
  window.print();
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
// Re-sorting is a pure reorder of the payload already in hand — no refetch, so
// it cannot change WHICH parties are shown, only their order.
$('sortBy').addEventListener('change', () => { if (lastData) render(lastData); });

/*
 * One CSV covering every result on screen — a row per party rather than the
 * per-party file the card exports. This is the artifact that goes into a
 * screening file, so it carries the query, threshold and snapshot version that
 * produced it: a hit list without the list version it was run against cannot be
 * reproduced later, which is the whole point of keeping it.
 */
function resultsCsv(rows, meta) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Name', 'Type', 'Authority', 'Lists', 'Entity ID', 'Score', 'Match type', 'Matched on',
    'Programs', 'Sanctions types', 'Date published', 'Blocked owners in chain', '50% aggregate test', 'Addresses', 'Identifiers'];
  const body = rows.map((r) => [
    r.name, r.type, r.authority || 'OFAC', listsOf(r).join('; '), r.id,
    r.score.toFixed(4), r.matchType, `${r.matchedField}${r.explain ? ' — ' + r.explain : ''}`,
    (r.programs || []).join('; '), (r.sanctionsTypes || []).join('; '), r.datePublished || '',
    r.derivative ? r.derivative.distinctBlockedOwners : 0,
    r.derivative && r.derivative.aggregationCandidate ? 'Yes' : 'No',
    (r.addresses || []).map((a) => a.full || a).join(' | '),
    (r.identifiers || []).map((i) => `${i.type}: ${i.value}`).join(' | '),
  ]);
  const provenance = [
    [], ['Query', meta.query], ['Threshold', meta.threshold],
    ['Matches above threshold', meta.total], ['Rows in this file', rows.length],
    ['Snapshot', `${meta.snapshot.source || ''} · OFAC publication ${meta.snapshot.publicationId || 'unknown'}`],
    ['Snapshot retrieved', meta.snapshot.retrievedAt || ''],
    ['Authorities screened', (meta.snapshot.authorities || []).join('; ')],
    ['Authorities NOT screened', (meta.snapshot.missingAuthorities || []).join('; ') || 'none'],
    ['Generated', new Date().toISOString()],
    ['Note', 'Screening leads, not determinations. Verify against the issuing authority before any compliance decision.'],
  ];
  return '﻿' + [head, ...body, ...provenance].map((row) => row.map(cell).join(',')).join('\r\n');
}

$('exportAllBtn').addEventListener('click', () => {
  if (!lastData || !lastResults.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (lastData.query || 'search').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  download(`sanctions-search-${slug || 'results'}-${stamp}.csv`, resultsCsv(lastResults, {
    query: lastData.query, threshold: lastData.threshold, total: lastData.count, snapshot: lastData.snapshot || {},
  }), 'text/csv;charset=utf-8');
});

/* ---- below-the-line testing ---- */

/*
 * Show the analyst what their threshold is throwing away.
 *
 * The panel answers two questions the slider alone cannot: how the hit count
 * moves across the whole range, and — the one that matters — WHICH records sit
 * between the floor and the active line. A count tells you the cost of widening;
 * only the records tell you whether the ones being excluded are namesakes or
 * your counterparty.
 *
 * Opt-in because it costs a full scan of the list. The default search keeps
 * using the recall-safe index.
 */
async function runBelowTheLine(opts) {
  const auto = !!(opts && opts.auto);
  const q = $('q').value.trim();
  if (!q) return;
  const btn = $('btlBtn');
  const panel = $('btlPanel');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Scoring…';
  panel.hidden = false;
  // A full scan takes a second or two locally and noticeably longer on a small
  // instance. Say what is happening rather than showing a bare skeleton.
  panel.innerHTML = `<p class="btl-loading">Scoring every listed party down to 0.80 — looking for near-misses, names starting with “${esc(q)}”, and identifier coverage…</p><div class="skeleton"></div>`;

  const params = new URLSearchParams({
    q, authority: $('authority').value, list: $('list').value, program: $('program').value,
    threshold: $('threshold').value, yob: $('yob').value.trim(), country: $('country').value.trim(),
  });
  try {
    const { res, body: d } = await window.SS.getJson('api/below-the-line?' + params);
    if (!res.ok || !Array.isArray(d.steps)) {
      panel.innerHTML = `<div class="no-hits"><strong>Below-the-line check unavailable:</strong> ${esc(d.error || 'server responded ' + res.status)}.</div>`;
      return;
    }
    renderBelowTheLine(d, auto);
  } catch (e) {
    panel.innerHTML = `<div class="no-hits">Below-the-line check failed: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/*
 * Everything the full scan learned, in three sections.
 *
 * `auto` means this ran because the search returned nothing, so the panel leads
 * with what a zero result does and does not mean rather than with threshold
 * mechanics. The sections themselves are identical either way — the evidence
 * does not change depending on why it was asked for.
 */
function renderBelowTheLine(d, auto) {
  const max = Math.max(1, ...d.steps.map((s) => s.count));
  const atActive = (d.steps.find((s) => s.threshold === d.active) || {}).count || 0;

  const bars = d.steps.map((s) => {
    const isActive = s.threshold === d.active;
    const h = Math.max(2, Math.round((s.count / max) * 100));
    return `<div class="btl-bar${isActive ? ' active' : ''}" style="--h:${h}%"
              title="threshold ${s.threshold.toFixed(2)} → ${s.count} hit${s.count === 1 ? '' : 's'}">
              <span class="sr-only">Threshold ${s.threshold.toFixed(2)}: ${s.count} hits</span></div>`;
  }).join('');

  const marginalRows = d.marginal.map((m) => `
    <li class="btl-row">
      <span class="btl-score">${m.score.toFixed(3)}</span>
      <span class="btl-name"><a href="${permalink(m.id)}">${esc(m.name)}</a></span>
      <span class="btl-meta">${esc(m.authority || 'OFAC')} · ${esc(listsOf(m)[0] || '')} · ${esc(m.matchType.replace('_', ' '))}${m.explain ? ` · ${esc(m.explain)}` : ''}</span>
    </li>`).join('');

  const prefixRows = (d.prefix || []).map((p) => `
    <li class="btl-row btl-row-prefix">
      <span class="btl-score">·</span>
      <span class="btl-name"><a href="${permalink(p.id)}">${esc(p.matchedName || p.name)}</a></span>
      <span class="btl-meta">${esc(p.authority || 'OFAC')} · ${esc(listsOf(p)[0] || '')}${p.matchedName && p.matchedName !== p.name ? ` · listed as ${esc(p.name)}` : ''}</span>
    </li>`).join('');

  /*
   * Identifier context. A number that looks like an IMO returning nothing means
   * one of two very different things — the vessel is not listed, or the
   * snapshot barely carries IMOs — and the user cannot tell which without this.
   */
  // "a IMO" / "an MMSI" — the article follows how the abbreviation is READ, not
  // how it is spelled, so go by the initial sound.
  const article = (w) => (/^[AEFHILMNORSX]/i.test(w) ? 'an' : 'a');
  const idBlock = d.identifier ? `
    <h4 class="btl-h4 btl-h4-info">Read as ${esc(d.identifier.shape)}</h4>
    <p class="btl-note">
      This query was screened as ${article(d.identifier.shape)} <strong>${esc(d.identifier.shape)}</strong> against every structured identifier.
      <strong>${d.identifier.carriers.toLocaleString()}</strong> of ${d.identifier.total.toLocaleString()} parties in this snapshot
      carry ${article(d.identifier.shape)} ${esc(d.identifier.shape)}${
        d.identifier.carriers === 0 ? ' — so this search could not have matched one' : ''}.
      A miss here is not evidence the party is unlisted; it may simply be an identifier the authority did not publish.
    </p>
    <details class="btl-details">
      <summary>Identifier coverage in this snapshot</summary>
      <ul class="btl-idlist">
        ${d.identifier.types.map((t) => `<li><span>${esc(t.type)}</span><span>${t.count.toLocaleString()}</span></li>`).join('')}
      </ul>
    </details>` : '';

  const lede = auto
    ? `<p class="btl-lede">
         Nothing cleared ${d.active.toFixed(2)}, so every party was scored down to ${d.floor.toFixed(2)} to show what is
         <em>near</em> the query. <strong>${d.marginalCount}</strong> score between ${d.floor.toFixed(2)} and ${d.active.toFixed(2)}${
           d.prefixCount ? `, and <strong>${d.prefixCount}</strong> ${d.prefixCount === 1 ? 'name starts' : 'names start'} with “${esc(d.query)}”` : ''}.
         Read these before concluding anything — a typo or a shortened name lands here, not in the results above.
       </p>`
    : `<p class="btl-lede">
         Every party scored down to ${d.floor.toFixed(2)}. At your threshold of <strong>${d.active.toFixed(2)}</strong>
         the search returns <strong>${atActive}</strong>; <strong>${d.marginalCount}</strong> more score between
         ${d.floor.toFixed(2)} and ${d.active.toFixed(2)} and are <strong>not shown</strong> in your results.
       </p>`;

  $('btlPanel').innerHTML = `
    <div class="btl-head">
      <h3>${auto ? 'Nothing matched — what was close' : 'Below-the-line check'} <span class="btl-sub">for “${esc(d.query)}”</span></h3>
      <button class="btl-close" type="button" id="btlClose" aria-label="Close this panel">×</button>
    </div>
    ${lede}
    ${idBlock}
    <div class="btl-chart" role="img" aria-label="Hit count by threshold from ${d.floor.toFixed(2)} to 1.00">
      ${bars}
    </div>
    <div class="btl-axis"><span>${d.floor.toFixed(2)}</span><span>lenient ← threshold → strict</span><span>1.00</span></div>
    ${d.marginalCount ? `
      <h4 class="btl-h4">Scoring below ${d.active.toFixed(2)}${d.truncated ? ` — highest ${d.marginal.length} of ${d.marginalCount}` : ''}</h4>
      <ol class="btl-list">${marginalRows}</ol>`
      : `<p class="btl-note">Nothing scores between ${d.floor.toFixed(2)} and ${d.active.toFixed(2)} for this query.</p>`}
    ${d.prefixCount ? `
      <h4 class="btl-h4 btl-h4-prefix">Names starting with “${esc(d.query)}”${d.prefixTruncated ? ` — first ${d.prefix.length} of ${d.prefixCount}` : ''}</h4>
      <p class="btl-note">A literal prefix match, not a score. The matcher has no prefix channel, so a half-typed name never reaches the results above.</p>
      <ol class="btl-list">${prefixRows}</ol>` : ''}
    <p class="btl-note">
      Read these before moving the line. If they are namesakes, the threshold is doing its job;
      if any is a plausible counterparty, the threshold is producing false negatives.
      Document whichever conclusion you reach — that record is the point of the exercise.
    </p>`;

  $('btlClose').addEventListener('click', () => { $('btlPanel').hidden = true; });
}

$('btlBtn').addEventListener('click', runBelowTheLine);

// `/` and Ctrl/Cmd-K focus the query box from anywhere on the page.
window.SS.bindSearchShortcuts('q');

$('copyLinkBtn').addEventListener('click', () => {
  const b = $('copyLinkBtn');
  copyText(location.href).then((ok) => {
    b.textContent = ok ? 'Link copied' : 'Copy failed';
    setTimeout(() => (b.textContent = 'Copy link'), 1800);
  });
});
loadMeta().then(initFromUrl);
