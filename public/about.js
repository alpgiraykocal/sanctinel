'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (iso) => { const t = Date.parse(iso); return t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };

(async () => {
  let m;
  try { m = await fetch('api/meta').then((r) => r.json()); }
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

  const pubs = m.publications || [];
  document.getElementById('pubs').innerHTML = pubs.length
    ? `<table class="pub-table"><thead><tr><th>Publication</th><th>Date</th></tr></thead><tbody>${pubs.map((p) =>
        `<tr><td>#${esc(p.id)}</td><td>${esc(fmtDate(p.date))}</td></tr>`).join('')}</tbody></table>`
    : '<p>Publication history unavailable in this snapshot.</p>';

  document.getElementById('listCov').innerHTML = (m.lists || []).map((l) => `<li>${esc(l)}</li>`).join('');
  document.getElementById('progCov').innerHTML = (m.programs || []).map((p) => `<span class="prog-chip">${esc(p)}</span>`).join(' ');
})();
