'use strict';

/*
 * Permalink page for one listed party.
 *
 * A search URL is not a citation. It re-runs the matcher, so `?q=sberbank`
 * resolves to a different set as the snapshot moves or the threshold changes,
 * and it can never point at one party unambiguously. This page addresses the
 * record by the authority's own entity id, which is what a compliance file
 * needs to reference and what a colleague needs to be sent.
 *
 * The record body is rendered by record.js — the same code the search results
 * use — so the two views cannot disagree about which prohibition applies.
 */

const $ = (id) => document.getElementById(id);
const esc = window.SS.esc;
const R = window.SSRecord;

const id = new URLSearchParams(location.search).get('id') || '';

function provenanceLine(m) {
  const bits = [];
  if (m.publicationId && m.publicationId !== 'unknown') bits.push(`OFAC publication #${m.publicationId}`);
  if (m.retrievedAt) bits.push(`snapshot retrieved ${window.SS.relTime(m.retrievedAt)}`);
  if ((m.authorities || []).length) bits.push(`authorities: ${m.authorities.join(', ')}`);
  return bits.join(' · ');
}

function render(data) {
  const r = data.entity;
  const m = data.snapshot || {};
  const hint = R.determinationHint(r);
  document.title = `${r.name} — Sanctions Search`;

  $('entityBody').innerHTML = `
    <p class="entity-breadcrumb"><a href="./">Screening</a> › Record ${esc(r.id)}</p>
    <h1 class="entity-name">${esc(r.name)}</h1>
    <p class="entity-sub">${esc(r.type)} · ${esc(r.authority || 'OFAC')} entity ID ${esc(r.id)}</p>

    ${R.factsHtml(r)}
    ${R.tagsHtml(r)}

    <div class="determination entity-determination"><strong>${esc(hint.label)}:</strong> ${hint.text}</div>

    <div class="entity-actions">
      ${(r.relationships || []).length ? '<button id="netBtn" class="btn-ghost" type="button">View network</button>' : ''}
      <button id="copyLinkBtn" class="btn-ghost" type="button">Copy link</button>
      <button id="csvBtn" class="btn-ghost" type="button">CSV</button>
      <button id="jsonBtn" class="btn-ghost" type="button">Copy JSON</button>
    </div>

    <div class="entity-detail">${R.detailHtml(r)}</div>

    <p class="entity-provenance">${esc(provenanceLine(m))}</p>
    <p class="entity-foot">
      Screening analysis only — <strong>not a determination and not legal advice</strong>.
      Confirm against the issuing authority's own list before any compliance decision:
      ${esc(R.AUTHORITY_SOURCE[r.authority] || R.AUTHORITY_SOURCE.OFAC)}.
      This record reflects the snapshot named above, which may lag the authority by up to a day.
    </p>`;

  $('entityBody').hidden = false;
  wireActions(r);
}

function wireActions(r) {
  const net = $('netBtn');
  // The graph module lives on the search page; loading it here would pull the
  // whole canvas/WebGL renderer onto a page that is mostly text. Hand the user
  // back to the search page with the network already requested instead.
  if (net) net.addEventListener('click', () => { location.href = `./?q=${encodeURIComponent(r.name)}&network=${encodeURIComponent(r.id)}`; });

  $('copyLinkBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => {
      const b = $('copyLinkBtn'); b.textContent = 'Link copied'; setTimeout(() => (b.textContent = 'Copy link'), 1500);
    });
  });
  $('jsonBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(() => {
      const b = $('jsonBtn'); b.textContent = 'Copied JSON'; setTimeout(() => (b.textContent = 'Copy JSON'), 1500);
    });
  });
  $('csvBtn').addEventListener('click', () => {
    const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [
      ['Field', 'Value'],
      ['Name', r.name], ['Type', r.type], ['Authority', r.authority || 'OFAC'],
      ['Entity ID', r.id], ['Lists', R.listsOf(r).join('; ')],
      ['Programs', (r.programs || []).join('; ')], ['Sanctions types', (r.sanctionsTypes || []).join('; ')],
      ['Legal authorities', (r.legalAuthorities || []).join('; ')], ['Date published', r.datePublished || ''],
      ['Aliases', (r.names || []).filter((n) => !n.primary).map((n) => `${n.type}: ${n.name}`).join(' | ')],
      ['Addresses', (r.addresses || []).map((a) => a.full || a).join(' | ')],
      ['Identifiers', (r.identifiers || []).map((i) => `${i.type}: ${i.value}`).join(' | ')],
      ['Relationships', (r.relationships || []).map((x) => `${x.type}: ${x.relatedName}`).join(' | ')],
      ['Blocked owners in chain', r.derivative ? String(r.derivative.distinctBlockedOwners) : '0'],
      ['50% aggregate test applies', r.derivative && r.derivative.aggregationCandidate ? 'Yes — multiple blocked owners' : 'No'],
      ['50% Rule caveat', 'OFAC publishes no ownership percentages; the threshold cannot be computed from list data. Confirm stakes against corporate registry / KYC records.'],
      ['Permalink', location.href],
      ['Exported', new Date().toISOString()],
      ['Note', 'Screening lead, not a determination. Verify against the issuing authority.'],
    ];
    const csv = '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
    const b = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = `sanctions-search-${r.id}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
  });
}

function fail(msg) {
  $('entityError').textContent = msg;
  $('entityError').hidden = false;
}

(async () => {
  $('entityLoading').hidden = false;
  if (!/^[\w:.-]+$/.test(id)) { $('entityLoading').hidden = true; return fail('No record id in this link.'); }
  try {
    const res = await fetch('api/entity?id=' + encodeURIComponent(id));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.entity) {
      // A 404 here is meaningful: the party is not in the snapshot at all, which
      // is different from "not designated" and must not be read as a clearance.
      return fail(res.status === 404
        ? `No party with id ${id} in this snapshot. It may have been delisted, or the link may predate the current list version — check the issuing authority directly.`
        : `Could not load this record: ${data.error || 'server responded ' + res.status}.`);
    }
    window.SS.renderCoverage(data.snapshot);
    render(data);
  } catch (e) {
    fail(`Could not load this record: ${e.message}`);
  } finally {
    $('entityLoading').hidden = true;
  }
})();
