'use strict';

/*
 * How a listed party is rendered — shared by the search results and the
 * permalink page.
 *
 * These two views must never disagree about a party. The determination hint in
 * particular decides whether the reader is told to freeze assets or to apply a
 * narrower restriction, and two copies of that logic drifting apart would mean
 * the same record gives different compliance guidance depending on which page
 * you opened. One implementation, both callers.
 */

window.SSRecord = (function () {
  const esc = window.SS.esc;

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

  // Every list a party sits on. Most specific first, so the umbrella
  // Consolidated List never leads — it is the least informative membership.
  function listsOf(r) {
    const ls = (r.lists && r.lists.length) ? r.lists : [r.list || ''].filter(Boolean);
    return ls.slice().sort((a, b) => (a === 'Consolidated List') - (b === 'Consolidated List'));
  }

  // Authorities publish dates in several shapes. Show a short form when it
  // parses and the raw string when it does not — never "Invalid Date", and
  // never silently drop a date we were given.
  function shortDate(v) {
    const t = Date.parse(v);
    if (!t) return String(v);
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /*
   * The identity facts that decide whether a hit is your party or a namesake.
   * Surfaced before the record is expanded: on a query like "Muhammad Ali" that
   * returns dozens of real people, the date of birth is what separates them and
   * it used to be three clicks deep on every single card.
   */
  const IDENTITY_FIELDS = [
    [/^date of birth$/i, 'DOB'],
    [/^place of birth$/i, 'POB'],
    [/^nationality$/i, 'Nationality'],
    [/^citizenship$/i, 'Citizenship'],
    [/^gender$/i, 'Gender'],
    [/^established date$/i, 'Established'],
  ];

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

  function attrGroups(attributes) {
    const groups = {};
    for (const a of attributes || []) (groups[a.group] ||= []).push(a);
    return GROUP_ORDER.filter((g) => groups[g]).map((g) => ({ group: g, rows: groups[g] }));
  }

  /*
   * Action guidance keyed to authority + list. A triage hint, not a
   * determination. Matches against EVERY list the party sits on, not just the
   * display label: non-SDN lists always come paired with the Consolidated List,
   * and it is the specific one that names the prohibition.
   */
  function determinationHint(r) {
    const l = listsOf(r).join(' | ');
    // U.S. export-control lists: the obligation is a licence requirement or
    // loss of export privileges — NOT an asset freeze. Never blend these with
    // the financial-sanctions doctrine below.
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
     * Full blocking dominates. A party can be on the SDN List AND a non-SDN
     * list at once — hundreds of the SSI entries are — and reading only the
     * narrower one would tell the user "restricted, not blocked" about a party
     * whose assets must actually be frozen. The asymmetry is deliberate:
     * over-freezing is reversible, failing to freeze is strict liability.
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

  /*
   * "Also listed by" — the same real party under another authority.
   *
   * On the collapsed row because it changes the arithmetic before anything is
   * opened: four authorities designate independently, so one shipowner can
   * occupy four rows under four spellings, and a reviewer who cannot see that
   * counts four parties and works four times.
   */
  function crossTag(r) {
    const c = r.crossListed;
    if (!c || !(c.alsoListedBy || []).length) return '';
    const how = c.basis === 'identifier' ? 'a shared identity document or registration number'
      : c.basis === 'name+dob' ? 'an identical name and an agreeing year of birth'
      : 'an identical name and a shared jurisdiction — unconfirmed';
    return `<span class="tag tag-cross${c.confidence === 'medium' ? ' tag-cross-weak' : ''}" title="Linked by ${esc(how)}">Also listed by ${c.alsoListedBy.map(esc).join(' · ')}</span>`;
  }

  /*
   * The other listings themselves, with the evidence for the link.
   *
   * Never merged into one record: the prohibitions differ by regime, so a
   * merged party would have to pick one and would be wrong for the others.
   * What this does is point at them — the EU record often carries a date of
   * birth OFAC does not publish, and OFAC carries ownership edges the EU does
   * not, and neither used to be reachable from the other.
   */
  function crossListedHtml(r) {
    const c = r.crossListed;
    if (!c || !(c.others || []).length) return '';
    return `
      <div class="attr-group cross-group${c.confidence === 'medium' ? ' cross-weak' : ''}">
        <h4 class="attr-group-title">Also listed by ${c.alsoListedBy.map(esc).join(' · ') || 'another authority'}</h4>
        <p class="cross-note">${esc(c.note)}</p>
        <ul class="cross-list">
          ${c.others.map((o) => `<li>
            <span class="tag tag-auth auth-${esc((o.authority || '').toLowerCase())}">${esc(o.authority)}</span>
            <a href="entity.html?id=${encodeURIComponent(o.id)}">${esc(o.name)}</a>
            <span class="cross-list-name">${esc(o.list || '')}</span>
          </li>`).join('')}
        </ul>
        <p class="cross-limit">These are separate designations and are <strong>not merged</strong> — each authority's prohibitions, programme and dates stand on their own record. Confirm each one you rely on.</p>
      </div>`;
  }

  /*
   * Derivative-blocking panel. Says two things the tag cannot: how many
   * DISTINCT blocked owners sit over this party (the aggregate limb of the
   * rule, which a direct-parent check misses entirely), and that OFAC publishes
   * no percentages — so this is where the analyst goes to the cap table, not
   * where the tool concludes.
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

  // The identity strip shown before the record is expanded.
  function factsHtml(r) {
    const facts = identityFacts(r);
    const aliases = (r.names || []).filter((n) => !n.primary);
    if (!facts.length && !aliases.length && !r.datePublished) return '';
    return `<dl class="rc-facts">${facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}${
      aliases.length ? `<div><dt>Aliases</dt><dd>${aliases.length}</dd></div>` : ''}${
      r.datePublished ? `<div><dt>Listed</dt><dd>${esc(shortDate(r.datePublished))}</dd></div>` : ''}</dl>`;
  }

  function tagsHtml(r) {
    const d = r.derivative;
    return `
      <div class="rc-tags">
        <span class="tag tag-auth auth-${esc((r.authority || 'OFAC').toLowerCase())}">${esc(r.authority || 'OFAC')}</span>
        ${listsOf(r).map((l) => `<span class="tag tag-list">${esc(l)}</span>`).join('')}
        ${(r.sanctionsTypes || []).map((t) => `<span class="tag tag-type">${esc(t)}</span>`).join('')}
        ${d ? `<span class="tag tag-own" title="${esc(d.distinctBlockedOwners)} blocked owner${d.distinctBlockedOwners === 1 ? '' : 's'} in the ownership chain">50% Rule · ${d.distinctBlockedOwners}${d.aggregationCandidate ? ' · aggregate' : ''}</span>` : ''}
        ${crossTag(r)}
      </div>
      ${(r.programs || []).length ? `<div class="rc-tags rc-programs">${(r.programs || []).map((p) => `<span class="tag tag-prog">${esc(p)}</span>`).join('')}</div>` : ''}`;
  }

  // Everything below the fold on a result card — and the whole body of the
  // permalink page, which simply shows it expanded.
  function detailHtml(r) {
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
        <h4 class="attr-group-title">Relationships &amp; Ownership</h4>
        <ul class="name-list">
          ${r.relationships.map((x) => `<li><span class="rel-type">${esc(x.type)}</span> ${esc(x.relatedName)}${x.relatedId ? ` <a class="rel-id" href="entity.html?id=${encodeURIComponent(x.relatedId)}">#${esc(x.relatedId)}</a>` : ''}</li>`).join('')}
        </ul>
      </div>` : '';

    const idsHtml = (r.identifiers || []).length
      ? `<div class="rc-tags ids">${r.identifiers.map((id) => `<span class="tag tag-id"><span class="id-type">${esc(id.type)}</span> ${esc(id.value)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="attr-group">
        <h4 class="attr-group-title">Names &amp; Aliases</h4>
        <dl class="attr-grid">
          ${nativeLine}${partsLine}
          <div class="detail-row"><dt>Aliases</dt><dd>${aliasHtml}</dd></div>
        </dl>
      </div>
      ${groupsHtml}
      ${docsHtml}
      ${crossListedHtml(r)}
      ${derivativeHtml(r)}
      ${relHtml}
      ${idsHtml ? `<div class="attr-group"><h4 class="attr-group-title">Screening Identifiers</h4>${idsHtml}</div>` : ''}
      <div class="attr-group">
        <h4 class="attr-group-title">Program &amp; Provenance</h4>
        <dl class="attr-grid">
          ${r.title ? `<div class="detail-row"><dt>Title</dt><dd>${esc(r.title)}</dd></div>` : ''}
          <div class="detail-row"><dt>Programs</dt><dd>${(r.programs || []).map(esc).join(', ') || '—'}</dd></div>
          ${sanctionsTypes.length ? `<div class="detail-row"><dt>Sanctions Type</dt><dd>${sanctionsTypes.map(esc).join(', ')}</dd></div>` : ''}
          ${(r.legalAuthorities || []).length ? `<div class="detail-row"><dt>Legal Authority</dt><dd>${r.legalAuthorities.map(esc).join('; ')}</dd></div>` : ''}
          ${r.datePublished ? `<div class="detail-row"><dt>Date Published</dt><dd>${esc(r.datePublished)}</dd></div>` : ''}
          <div class="detail-row"><dt>Addresses</dt><dd>${addrHtml}</dd></div>
          ${r.remarks ? `<div class="detail-row"><dt>Raw Remarks</dt><dd class="raw">${esc(r.remarks)}</dd></div>` : ''}
        </dl>
      </div>`;
  }

  // Stable link to one party. Query-string rather than a path segment so the
  // app keeps working under a path prefix (see deploy/ — every in-app URL is
  // relative for exactly this reason).
  const permalink = (id) => `entity.html?id=${encodeURIComponent(id)}`;

  return {
    GROUP_ORDER, AUTHORITY_SOURCE,
    listsOf, shortDate, identityFacts, attrGroups, determinationHint,
    derivativeHtml, crossListedHtml, crossTag, factsHtml, tagsHtml, detailHtml, permalink,
  };
})();
