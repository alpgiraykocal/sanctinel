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

  /*
   * Fetch JSON, waiting out a cold start.
   *
   * The server answers 503 with {booting:true} while it parses the snapshot —
   * it would rather say "not ready" than screen against the sample data it
   * holds until then. On a free tier that sleeps after fifteen idle minutes,
   * a visitor hits this on the first request, so every page retries quietly
   * instead of reporting an error the user can do nothing about.
   */
  async function getJson(path, opts) {
    const o = opts || {};
    const tries = o.tries || 12;
    for (let i = 0; i < tries; i++) {
      const res = await fetch(path, o.init);
      if (res.status !== 503) return { res, body: await res.json().catch(() => ({})) };
      const body = await res.json().catch(() => ({}));
      if (!body.booting) return { res, body };
      if (typeof o.onWait === 'function') o.onWait(i);
      await new Promise((r) => setTimeout(r, Math.min(1000 + i * 500, 4000)));
    }
    return { res: { ok: false, status: 503 }, body: { error: 'server still starting up — try again in a moment' } };
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
    const blocked = m && m.refreshBlocked;
    const ageHours = m && m.snapshotAgeHours;

    /*
     * Two independent ways the screen in front of you covers less than it looks
     * like it does, and they are ADDITIVE rather than exclusive. An earlier
     * version showed only the first, which in practice meant the second was
     * never seen: BIS and State have been missing since a certificate expired,
     * so a missing-authority message is almost always on screen and would have
     * hidden the staleness one behind it indefinitely.
     */
    const parts = [];

    if (missing.length) {
      const why = ((m && m.sourceFailures) || []).map((f) => `${f.label}: ${f.error}`).join(' · ');
      const plural = missing.length > 1;
      parts.push(
        `<strong>Incomplete coverage — ${esc(missing.join(' and '))} ${plural ? 'lists are' : 'list is'} not being screened.</strong> ` +
        `A search cannot clear a party against ${plural ? 'these authorities' : 'this authority'} right now; check ` +
        missing.map((a) => `<a href="${esc(AUTHORITY_URL[a] || AUTHORITY_URL.OFAC)}" rel="noreferrer noopener" target="_blank">${esc(a)}</a>`).join(' and ') +
        ` directly.${why ? ` <span class="coverage-why">(${esc(why)})</span>` : ''}`
      );
    }

    /*
     * One authority can be much older than the rest. When a source is down its
     * records are carried forward from the last good build so the others can
     * still publish, which is the right trade — but it means the snapshot date
     * no longer describes every authority in it, and a reviewer relying on the
     * EU list deserves to know its data stopped two days ago.
     */
    const stale = (m && m.staleAuthorities) || [];
    if (stale.length) {
      parts.push(
        `<strong>${stale.map((x) => `${esc(x.authority)} data is ${esc(String(x.ageHours))}h old`).join(', ')}.</strong> ` +
        `That source was unreachable when this snapshot was built, so its last good records were kept. ` +
        `Anything ${stale.length > 1 ? 'those authorities have' : 'that authority has'} designated since is not screened here.`
      );
    }

    /*
     * A snapshot that has stopped updating is its own coverage problem, and it
     * was invisible: this instance is too small to run the runtime refresh, so
     * it declines rather than being OOM-killed mid-fetch, and without this line
     * the only symptom is data that quietly stops moving. Shown past a day,
     * since the pipeline republishes daily and a few hours of lag is normal.
     */
    if (blocked && ageHours != null && ageHours >= 24) {
      parts.push(
        `<strong>This snapshot is ${esc(String(ageHours))} hours old and is not refreshing on this instance.</strong> ` +
        'Anything designated since then is not screened here. ' +
        `<span class="coverage-why">(${esc(blocked.reason)})</span>`
      );
    }

    if (!parts.length) { bar.hidden = true; return; }
    document.getElementById('coverageText').innerHTML = parts.join('<br>');
    bar.hidden = false;
  }

  /*
   * Pages other than the search page have no meta of their own to piggyback on,
   * so they fetch it once themselves. The search page already fetches meta to
   * populate its filters and calls renderCoverage with that response — it sets
   * `ownsMeta` so this does not issue a second identical request per page load.
   */
  async function autoCoverage() {
    if (!document.getElementById('coverageBar') || window.SS.ownsMeta) return;
    try { const { body } = await getJson('api/meta'); renderCoverage(body); } catch { /* banner stays hidden */ }
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

  return { esc, AUTHORITY_URL, relTime, renderCoverage, bindSearchShortcuts, getJson };
})();
