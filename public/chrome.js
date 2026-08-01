'use strict';

/*
 * Shared page chrome — the parts that must look and behave identically on the
 * search page, the insights page and the about page.
 *
 * The coverage banner lives here rather than in app.js because it was only ever
 * shown on the search page, and the other two are exactly where a missing
 * authority reads as a fact: insights renders "4 issuing authorities" and about
 * renders a list count, both with no hint that two more are supposed to be
 * there. A number that is quietly wrong is worse than one that is absent.
 */

window.SS = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Where a user goes to verify against the issuing authority itself.
  const AUTHORITY_URL = {
    OFAC: 'https://sanctionssearch.ofac.treas.gov',
    EU: 'https://webgate.ec.europa.eu/fsd/fsf',
    UN: 'https://www.un.org/securitycouncil/content/un-sc-consolidated-list',
    UK: 'https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets',
    BIS: 'https://www.bis.gov/regulations/ear/744',
    State: 'https://www.pmddtc.state.gov',
  };

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.round(m)} min ago`;
    const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  /*
   * Name the authorities that are NOT being screened right now, and say what a
   * search can therefore not conclude. Without this the authority simply drops
   * out of the filter list and a search returns nothing for it — which reads
   * exactly like a clean result.
   */
  function renderCoverage(m) {
    const bar = document.getElementById('coverageBar');
    if (!bar) return;
    const missing = (m && m.missingAuthorities) || [];
    if (!missing.length) { bar.hidden = true; return; }
    const why = ((m && m.sourceFailures) || []).map((f) => `${f.label}: ${f.error}`).join(' · ');
    const plural = missing.length > 1;
    const text = document.getElementById('coverageText');
    text.innerHTML =
      `<strong>Incomplete coverage — ${esc(missing.join(' and '))} ${plural ? 'lists are' : 'list is'} not being screened.</strong> ` +
      `A search cannot clear a party against ${plural ? 'these authorities' : 'this authority'} right now; check ` +
      missing.map((a) => `<a href="${esc(AUTHORITY_URL[a] || AUTHORITY_URL.OFAC)}" rel="noreferrer noopener" target="_blank">${esc(a)}</a>`).join(' and ') +
      ` directly.${why ? ` <span class="coverage-why">(${esc(why)})</span>` : ''}`;
    bar.hidden = false;
  }

  // Pages other than the search page have no meta of their own to piggyback on,
  // so they fetch it once themselves. app.js passes in the meta it already has.
  async function autoCoverage() {
    if (!document.getElementById('coverageBar')) return;
    try { renderCoverage(await fetch('api/meta').then((r) => r.json())); } catch { /* banner stays hidden */ }
  }

  /*
   * Keyboard affordances, applied to every page that has a search field.
   *   /  or  Ctrl/Cmd-K   focus the query box (skipped while typing elsewhere)
   *   Escape              leave the field without submitting
   */
  function bindSearchShortcuts(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
      if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === 'Escape' && document.activeElement === input) {
        input.blur();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', autoCoverage);

  return { esc, AUTHORITY_URL, relTime, renderCoverage, bindSearchShortcuts };
})();
