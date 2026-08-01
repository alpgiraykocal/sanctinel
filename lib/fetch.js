'use strict';

/*
 * Redirect-following, retrying HTTPS GET → string.
 *
 * Redirects are not optional here: the UN and UK endpoints 302 to time-signed
 * blob URLs, and OFAC's own /api/download/*.CSV files answer 302 as well — a
 * client that treats 3xx as an error can never reach the flat files at all.
 *
 * Retries exist because the whole daily snapshot hangs off a handful of
 * requests to one host. On 2026-07-30 OFAC answered 403 to the scheduled build;
 * both the advanced path and the flat-file fallback hit the same host within
 * the same second, both got 403, and the run died 17 seconds in with no
 * snapshot produced. Backing off and trying again costs a minute and saves the
 * day's data.
 *
 * Only transient classes are retried — throttling, timeouts, connection resets
 * and server errors. A 404 or a TLS failure is not going to fix itself, and
 * retrying it just delays an error the operator needs to see. TLS verification
 * is never bypassed: these responses are the screening list itself, so an
 * unverified one is worse than none.
 */
const https = require('https');

const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRIES = 4;
const BASE_DELAY_MS = 1500;
const MAX_DELAY_MS = 30000;

// Identify the client to the publisher. OFAC asks for a contact in the
// User-Agent; set SANCTIONS_SEARCH_CONTACT to a mailbox you actually read, so a
// publisher can reach you instead of silently throttling.
const CONTACT = process.env.SANCTIONS_SEARCH_CONTACT || 'sanctions-search (set SANCTIONS_SEARCH_CONTACT)';
const USER_AGENT = `sanctions-search/1.0 (sanctions screening; contact: ${CONTACT})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with jitter, so a retry storm from several sources does
// not re-converge on the same instant it just got throttled at.
function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function once(url, { headers = {}, depth = 0, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: Object.assign({ 'User-Agent': USER_AGENT, Accept: '*/*' }, headers),
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(once(next, { headers, depth: depth + 1, timeout }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode} for ${url}`);
        err.statusCode = res.statusCode;
        err.retryAfter = res.headers['retry-after'];
        return reject(err);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { const e = new Error(`timeout for ${url}`); e.transient = true; req.destroy(e); });
    req.on('error', (e) => {
      // Connection-level faults are transient; a bad certificate is not.
      if (!e.transient) e.transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|ENETUNREACH|socket hang up/i.test(e.message);
      reject(e);
    });
  });
}

function isTransient(e) {
  return !!(e && (e.transient || (e.statusCode && RETRY_STATUS.has(e.statusCode))));
}

async function fetchText(url, opts = {}) {
  const retries = opts.retries === undefined ? DEFAULT_RETRIES : opts.retries;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(url, opts);
    } catch (e) {
      last = e;
      if (attempt === retries || !isTransient(e)) break;
      const wait = backoffMs(attempt, e.retryAfter);
      console.warn(`fetch retry ${attempt + 1}/${retries} in ${(wait / 1000).toFixed(1)}s — ${e.message}`);
      await sleep(wait);
    }
  }
  throw last;
}

async function fetchJson(url, opts = {}) {
  const body = await fetchText(url, opts);
  return JSON.parse(body);
}

module.exports = { fetchText, fetchJson, USER_AGENT };
