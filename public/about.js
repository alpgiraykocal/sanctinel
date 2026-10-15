'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (iso) => { const t = Date.parse(iso); return t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };

(async () => {
  let m;
  try { m = (await window.SS.getJson('api/meta')).body; }
  catch { document.getElementById('pubs').textContent = 'Coverage data unavailable.'; return; }

  const stat = (n, l) => `<div class="stat"><span class="stat-num">${n}</span><span class="stat-lbl">${l}</span></div>`;
  // "listed parties", not "sanctioned parties": a BIS/State export-control
  // listing is a licence restriction, not a sanction, and the same distinction
  // applies to the list and programme counts.
  document.getElementById('stats').innerHTML =
    stat((m.count || 0).toLocaleString(), 'listed parties') +
    stat((m.authorities || []).length || 1, 'issuing authorities') +
    stat((m.lists || []).length, 'lists covered') +
    stat((m.programs || []).length, 'programs & regimes');

  const authEl = document.getElementById('authCov');
  if (authEl) authEl.innerHTML = (m.authorities || []).map((a) => `<span class="prog-chip">${esc(a)}</span>`).join(' ');

  /*
   * Freshness per authority: when its data was retrieved, and whether the
   * last build fetched it fresh or carried it forward because its source was
   * down. Read from the snapshot itself, so it describes exactly what search
   * is using right now.
   */
  const fresh = m.authorityFreshness || {};
  const failed = new Map();
  for (const f of m.sourceFailures || []) for (const a of f.authorities || []) failed.set(a, f);
  const stale = new Set(m.staleAuthorities || []);
  const order = ['OFAC', 'EU', 'UN', 'UK', 'BIS', 'State'];
  const auths = [...new Set([...(m.authorities || []), ...Object.keys(fresh)])]
    .sort((a, b) => ((order.indexOf(a) + 99) % 99) - ((order.indexOf(b) + 99) % 99) || a.localeCompare(b));
  const missing = m.missingAuthorities || [];
  document.getElementById('freshness').innerHTML = m.isLive && auths.length ? `<table class="doc-table">
    <thead><tr><th scope="col">Authority</th><th scope="col">Retrieved</th><th scope="col">Status</th></tr></thead>
    <tbody>${auths.map((a) => {
      const f = failed.get(a);
      const status = f ? (f.partial ? 'Fresh, but a list was carried forward' : `Carried forward — source unavailable${f.error ? ` (${esc(String(f.error).slice(0, 80))})` : ''}`)
        : stale.has(a) ? 'Older than the rest of the snapshot' : 'Fresh';
      return `<tr><th scope="row">${esc(a)}</th><td>${esc(fresh[a] ? fmtDate(fresh[a]) : '—')}</td><td><span class="dq-status ${f || stale.has(a) ? 'warn' : 'ok'}">${status}</span></td></tr>`;
    }).join('')}${missing.map((a) => `<tr><th scope="row">${esc(a)}</th><td>—</td><td><span class="dq-status warn">Missing from this snapshot</span></td></tr>`).join('')}</tbody></table>`
    : '<p>This is the offline sample — fictional data with no source freshness.</p>';

  const pubs = m.publications || [];
  document.getElementById('pubs').innerHTML = pubs.length
    ? `<table class="pub-table"><thead><tr><th>Publication</th><th>Date</th></tr></thead><tbody>${pubs.map((p) =>
        `<tr><td>#${esc(p.id)}</td><td>${esc(fmtDate(p.date))}</td></tr>`).join('')}</tbody></table>`
    : '<p>Publication history unavailable in this snapshot.</p>';

  document.getElementById('listCov').innerHTML = (m.lists || []).map((l) => `<li>${esc(l)}</li>`).join('');
  document.getElementById('progCov').innerHTML = (m.programs || []).map((p) => `<span class="prog-chip">${esc(p)}</span>`).join(' ');
})();

/*
 * Table of contents for the left pane, built from the page's own section
 * headings so it can never list a section that is not there. The current
 * section is highlighted as the content pane scrolls.
 */
(function buildToc() {
  const toc = document.getElementById('toc');
  const pane = document.getElementById('docPane');
  if (!toc || !pane) return;
  // Link to the SECTION's id where it has one: those ids are what other pages
  // link to (insights → about.html#sec-quality), so they must stay the anchors.
  const heads = [...pane.querySelectorAll('section > h2')];
  const anchorOf = (h) => h.parentElement.id || h.id;
  heads.forEach((h, i) => { if (!anchorOf(h)) h.id = 'sec-' + (i + 1); });
  toc.innerHTML = '<p class="toc-title">On this page</p>' + heads.map((h) => `<a href="#${anchorOf(h)}">${window.SS.esc(h.textContent)}</a>`).join('');
  const links = [...toc.querySelectorAll('a')];
  const mark = () => {
    const top = pane.getBoundingClientRect().top;
    let cur = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top - top < 80) cur = h;
    for (const a of links) {
      if (a.getAttribute('href') === '#' + anchorOf(cur)) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    }
  };
  pane.addEventListener('scroll', mark, { passive: true });
  mark();
})();
