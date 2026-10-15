'use strict';

/*
 * Fixed-window per-key rate limiter (in-memory, zero-dep). Adequate for a
 * single-instance public demo. For multi-instance deployments put a shared
 * limiter (Redis) or a reverse proxy in front instead.
 */
function createLimiter({ windowMs = 60000, max = 120 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (now > e.resetAt) hits.delete(k);
  }, windowMs).unref();

  function check(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    e.count++;
    return { ok: e.count <= max, remaining: Math.max(0, max - e.count), retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  }

  return { check, _timer: timer };
}

/*
 * The client address, for rate limiting.
 *
 * Read from the RIGHT of X-Forwarded-For. Each proxy appends the address it
 * received the connection from, so the trustworthy entries are the last ones;
 * the first is whatever the client chose to send. Taking the first meant any
 * client could put a fresh random address in the header on every request,
 * get a fresh rate-limit bucket each time — the limits simply did not apply —
 * and grow the limiter's map without bound while doing it.
 *
 * `hops` is how many proxies append to the header (1 for Render alone, 2 with
 * Cloudflare in front of it).
 */
function clientAddress(req, { trustProxy = true, hops = 1 } = {}) {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) {
      const chain = String(xf).split(',').map((x) => x.trim()).filter(Boolean);
      if (chain.length) return chain[Math.max(0, chain.length - Math.max(1, hops))];
    }
  }
  return (req.socket && req.socket.remoteAddress) || '?';
}

module.exports = { createLimiter, clientAddress };
