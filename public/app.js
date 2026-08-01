'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const GROUP_ORDER = ['Identity', 'Documents', 'Vessel / Aircraft', 'Digital & Contact', 'Program', 'Other'];

// Where a user must verify a hit, per issuing authority.
const AUTHORITY_SOURCE = {
  OFAC: 'OFAC Sanctions List Search (sanctionssearch.ofac.treas.gov)',
  EU: 'the EU Consolidated Financial Sanctions List (webgate.ec.europa.eu/fsd/fsf)',
  UN: 'the UN Security Council Consolidated List (un.org/securitycouncil)',
  UK: 'the UK OFSI Consolidated List (gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets)',
  BIS: "BIS's own list in EAR Supplement No. 4 to Part 744 (bis.gov/regulations/ear/744)",
  State: 'the State Department / DDTC debarred and nonproliferation notices (pmddtc.state.gov)',
};

// Verification links live in chrome.js so the banner renders identically on the
// insights and about pages, which have no app.js.
const AUTHORITY_URL = window.SS.AUTHORITY_URL;

/*
 * The identity facts that decide whether a hit is your party or a namesake, put
 * where triage happens: on the collapsed card.
 *
 * These all existed already, three clicks deep in the attribute groups. On a
 * query like "Muhammad Ali" that returns dozens of real people, a card showing
 * only name + score forces the analyst to expand every one of them to find the
 * date of birth, which is the field that actually separates them.
 */
const IDENTITY_FIELDS = [
  [/^date of birth$/i, 'DOB'],
  [/^place of birth$/i, 'POB'],
  [/^nationality$/i, 'Nationality'],
  [/^citizenship$/i, 'Citizenship'],
  [/^gender$/i, 'Gender'],
  [/^established date$/i, 'Established'],
];

// Authorities publish dates in several shapes (ISO, "2020-11-12", free text).
// Show a short form when it parses, the raw string when it does not — never an
// "Invalid Date", and never silently drop a date we were given.
function shortDate(v) {
  const t = Date.parse(v);
  if (!t) return String(v);
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function identityFacts(r) {
  const out = [];
  const seen = new Set();
  for (const [re, label] of IDENTITY_FIELDS) {
    for (const a of r.attributes || []) {
      if (!re.test(a.label) || seen.has(label)) continue;
      seen.add(label);
      out.push({ label, value: a.value });
    }
  }
  // Country comes from an address when the authority states no nationality —
  // for entities and vessels that is the only jurisdiction signal there is.
  if (!seen.has('Nationality') && !seen.has('Citizenship')) {
    const c = (r.addresses || []).map((a) => a.country).find(Boolean);
    if (c) out.push({ label: 'Country', value: c });
  }
  return out;
}

// Every list a party sits on. Most specific first, so the umbrella Consolidated
// List never leads — it is the least informative of the memberships.
function listsOf(r) {
  const ls = (r.lists && r.lists.length) ? r.lists : [r.list || ''].filter(Boolean);
  return ls.slice().sort((a, b) => (a === 'Consolidated List') - (b === 'Consolidated List'));
}

/*
 * Derivative-blocking panel. Says two things the row above cannot: how many
 * DISTINCT blocked owners sit over this party (the aggregate limb of the rule,
 * which a direct-parent check misses entirely), and that OFAC publishes no
 * percentages — so this is where the analyst goes to the cap table, not where
 * the tool concludes.
 */
function derivativeHtml(r) {
  const d = r.derivative;
  if (!d) return '';
  const owner = d.topOwner;
  return `
    <div class="attr-group deriv-group">
      <h4 class="attr-group-title">50% Rule — derivative blocking</h4>
      <p class="deriv-head">
        <strong>${d.distinctBlockedOwners}</strong> blocked ${d.distinctBlockedOwners === 1 ? 'owner' : 'owners'} in the ownership chain
        (${d.directBlockedOwners} direct${d.distinctBlockedOwners > d.directBlockedOwners ? `, ${d.distinctBlockedOwners - d.directBlockedOwners} indirect` : ''})${owner ? ` — nearest: ${esc(owner.name)} (${owner.hops} hop${owner.hops === 1 ? '' : 's'})` : ''}.
      </p>
      ${d.aggregationCandidate ? '<p class="deriv-agg"><strong>Aggregate test applies.</strong> More than one blocked owner: the 50% threshold can be met by their combined stakes even if no single owner reaches it.</p>' : ''}
      <p class="deriv-limit">OFAC publishes <strong>no ownership percentages</strong>, so the 50% threshold cannot be computed from list data. Confirm the actual stakes, aggregated across all blocked owners, against corporate registry or KYC records. This is a lead, not a determination.</p>
    </div>`;
}

// Action guidance keyed to authority + list type. Triage hint, not a determination.
// Matches against EVERY list the party sits on, not just the display label: the
// non-SDN lists always come paired with the Consolidated List, and it is the
// specific one that names the prohibition.
function determinationHint(r) {
  const l = listsOf(r).join(' | ');
  // U.S. export-control lists: the obligation is a licence requirement or loss
  // of export privileges — NOT an asset freeze. Never blend these with the
  // financial-sanctions doctrine above.
  if (r.authority === 'BIS' || r.authority === 'State') {
    if (/Denied Persons/i.test(l)) return { label: 'Export privileges denied', text: 'BIS Denied Persons List: the party’s export privileges are <strong>denied</strong> — do not participate in any export, reexport or transfer subject to the EAR involving them. This is export control, <strong>not</strong> an asset freeze; funds are not blocked.' };
    if (/Unverified/i.test(l)) return { label: 'Unverified end-user', text: 'BIS Unverified List: BIS could not verify the party’s bona fides. <strong>No licence exceptions</strong> may be used and a UVL statement is required before shipping items subject to the EAR. Export control only — not an asset freeze.' };
    if (/Military End-User/i.test(l)) return { label: 'Military end-user licence', text: 'BIS Military End-User List: a <strong>licence is required</strong> for the items specified in EAR §744.21 destined for this party. Export control only — not an asset freeze.' };
    if (/ITAR Debarred/i.test(l)) return { label: 'ITAR debarred', text: 'State/DDTC debarment: the party is <strong>barred from participating in defence-article exports</strong> under the AECA/ITAR. Export control only — not an asset freeze. Confirm the current debarment status with DDTC.' };
    if (/Nonproliferation/i.test(l)) return { label: 'Nonproliferation measures', text: 'State Department nonproliferation sanctions: <strong>measures vary by determination</strong> (procurement/import bans, licence denials). Read the specific measures imposed; this is not an asset freeze.' };
    return { label: 'Export licence required', text: 'BIS Entity List: a <strong>licence is required</strong> for exports, reexports or in-country transfers subject to the EAR, usually with a presumption of denial. This is export control, <strong>not</strong> a financial sanction — funds are not blocked and this is separate from any OFAC designation.' };
  }
  if (r.authority === 'EU') return { label: 'EU asset freeze', text: 'EU designation: <strong>freeze funds and economic resources</strong> and make none available, directly or indirectly, to or for the listed person. Applies under the cited Council Regulation across all member states — EU regime, not OFAC doctrine.' };
  if (r.authority === 'UN') return { label: 'UN asset freeze', text: 'UN Security Council listing: member states must <strong>freeze funds and economic resources</strong> and bar their provision. Apply the implementing national/EU regulation; this is not OFAC doctrine.' };
  if (r.authority === 'UK') return { label: 'UK asset freeze', text: 'UK OFSI designation: <strong>freeze funds/economic resources</strong> and do not make them available to or for the designated person; report to OFSI. UK regime, not OFAC.' };
  /*
   * Full blocking dominates. Now that we keep every membership, a party can be
   * on the SDN List AND a non-SDN list at once — hundreds of the SSI entries
   * are — and reading only the narrower one would tell the user "restricted,
   * not blocked" about a party whose assets must actually be frozen. The
   * asymmetry is deliberate: over-freezing is a reversible error, failing to
   * freeze a blocked party is a strict-liability violation.
   */
  const blocked = listsOf(r).includes('SDN List') || (r.sanctionsTypes || []).some((t) => /^block$/i.test(t));
  if (blocked) return { label: 'Potential block', text: 'On the <strong>SDN List</strong> (alongside any non-SDN listing shown): if confirmed, <strong>block and freeze</strong>, then file the blocking report within the OFAC deadline. Where a narrower restriction also applies, the blocking obligation governs. Apply the 50% Rule to owned entities.' };
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
    const m = await fetch('api/meta').then((r) => r.json());
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

// While a background live refresh runs, poll until it completes, then swap in
// the real snapshot metadata + filters without a page reload.
function pollIfLoading(m) {
  clearTimeout(pollTimer);
  if (!m.loading) return;
  pollTimer = setTimeout(async () => {
    try { const mm = await fetch('api/meta').then((r) => r.json()); applyMeta(mm); pollIfLoading(mm); }
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
    const res = await fetch('api/search?' + params, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
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
function sortResults(rows) {
  const mode = $('sortBy').value;
  const copy = rows.slice();
  if (mode === 'name') copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === 'date') copy.sort((a, b) => (Date.parse(b.datePublished) || 0) - (Date.parse(a.datePublished) || 0));
  else copy.sort((a, b) => b.score - a.score);
  return copy;
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
  $('sortWrap').hidden = total < 2;
  summary.hidden = !total;
  summary.innerHTML = total
    ? `<strong>${total.toLocaleString()}</strong> potential match${total === 1 ? '' : 'es'} for <strong>“${esc(data.query)}”</strong> <span class="summary-sub">· screened against ${(data.snapshot.count || 0).toLocaleString()} listed parties at threshold ${data.threshold}</span>${
        truncated ? `<span class="truncation-note">Showing the ${shown.toLocaleString()} highest-scoring — narrow the query or raise the threshold to see the rest.</span>` : ''}`
    : '';

  if (!total) {
    const scope = $('authority').value ? `the ${esc($('authority').value)} list` : 'the sanctions and export-control lists';
    list.innerHTML = `<div class="no-hits clear"><strong>No match</strong> for “${esc(data.query)}” in ${scope} at threshold ${data.threshold}.<br>Absence of a hit is not a clearance — these lists do not cover every regime (other national and dual-use lists are not included), so confirm the snapshot is current and consider lowering the threshold for a below-the-line check.</div>`;
    return;
  }

  // Card action handlers address rows by index, so the array they index into
  // must be the one that was rendered — sort first, then keep that order.
  const rows = sortResults(data.results);
  lastResults = rows;
  list.innerHTML = rows.map((r, i) => card(r, i)).join('');
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
    download(`sanctions-search-${r.id}.csv`, toCsv(r), 'text/csv;charset=utf-8');
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
    </div>` : '';

  const derivHtml = derivativeHtml(r);

  const idsHtml = (r.identifiers || []).length
    ? `<div class="rc-tags ids">${r.identifiers.map((id) => `<span class="tag tag-id"><span class="id-type">${esc(id.type)}</span> ${esc(id.value)}</span>`).join('')}</div>`
    : '';

  const facts = identityFacts(r);
  // The 50% Rule tag is driven by the computed ownership chain, not by whether
  // the record happens to carry an ownership relationship: a party can have a
  // blocked owner three hops up with no direct edge of its own, and a party can
  // have ownership edges that reach nobody blocked at all.
  const deriv = r.derivative;

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

    ${facts.length ? `<dl class="rc-facts">${facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}${
        aliases.length ? `<div><dt>Aliases</dt><dd>${aliases.length}</dd></div>` : ''}${
        r.datePublished ? `<div><dt>Listed</dt><dd>${esc(shortDate(r.datePublished))}</dd></div>` : ''}</dl>` : ''}

    <div class="rc-tags">
      <span class="tag tag-auth auth-${esc((r.authority || 'OFAC').toLowerCase())}">${esc(r.authority || 'OFAC')}</span>
      ${listsOf(r).map((l) => `<span class="tag tag-list">${esc(l)}</span>`).join('')}
      ${sanctionsTypes.map((t) => `<span class="tag tag-type">${esc(t)}</span>`).join('')}
      ${deriv ? `<span class="tag tag-own" title="${esc(deriv.distinctBlockedOwners)} blocked owner${deriv.distinctBlockedOwners === 1 ? '' : 's'} in the ownership chain">50% Rule · ${deriv.distinctBlockedOwners}${deriv.aggregationCandidate ? ' · aggregate' : ''}</span>` : ''}
    </div>

    ${(r.programs || []).length ? `<div class="rc-tags rc-programs">${(r.programs || []).map((p) => `<span class="tag tag-prog">${esc(p)}</span>`).join('')}</div>` : ''}

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
      ${derivHtml}
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
    const res = await fetch('api/refresh', { method: 'POST' }).then((r) => r.json());
    if (!res.ok) { alert('Live refresh unavailable: ' + res.error); applyMeta(res.meta); return; }
    applyMeta(res.meta); pollIfLoading(res.meta);
  } catch (e) { alert('Live refresh error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Refresh'; }
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

// `/` and Ctrl/Cmd-K focus the query box from anywhere on the page.
window.SS.bindSearchShortcuts('q');

$('copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => {
    const b = $('copyLinkBtn'); b.textContent = 'Link copied'; setTimeout(() => (b.textContent = 'Copy link'), 1500);
  });
});
loadMeta().then(initFromUrl);
