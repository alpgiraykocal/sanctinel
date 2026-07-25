'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (iso) => { const t = Date.parse(iso); return t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };

(async () => {
  let m;
  try { m = await fetch('/api/meta').then((r) => r.json()); }
  catch { document.getElementById('pubs').textContent = 'Coverage data unavailable.'; return; }

  const stat = (n, l) => `<div class="stat"><span class="stat-num">${n}</span><span class="stat-lbl">${l}</span></div>`;
  document.getElementById('stats').innerHTML =
    stat((m.count || 0).toLocaleString(), 'sanctioned parties') +
    stat((m.lists || []).length, 'OFAC lists') +
    stat((m.programs || []).length, 'sanctions programs') +
    stat(m.publicationId && m.publicationId !== 'unknown' ? m.publicationId : '—', 'current publication');

  const pubs = m.publications || [];
  document.getElementById('pubs').innerHTML = pubs.length
    ? `<table class="pub-table"><thead><tr><th>Publication</th><th>Date</th></tr></thead><tbody>${pubs.map((p) =>
        `<tr><td>#${esc(p.id)}</td><td>${esc(fmtDate(p.date))}</td></tr>`).join('')}</tbody></table>`
    : '<p>Publication history unavailable in this snapshot.</p>';

  document.getElementById('listCov').innerHTML = (m.lists || []).map((l) => `<li>${esc(l)}</li>`).join('');
  document.getElementById('progCov').innerHTML = (m.programs || []).map((p) => `<span class="prog-chip">${esc(p)}</span>`).join(' ');
})();
