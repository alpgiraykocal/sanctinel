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

module.exports = { createLimiter };
