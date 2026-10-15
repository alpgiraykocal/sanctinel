'use strict';

/*
 * HTTP plumbing with no knowledge of the snapshot: security headers, JSON
 * responses, and path-traversal-safe static serving. Split out of server.js,
 * which keeps the state (snapshot, index, caches) and the routes over it.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function securityHeaders() {
  return {
    // No third-party origins at all. The fonts used to come from
    // fonts.googleapis.com / fonts.gstatic.com, which handed Google the IP and
    // User-Agent of everyone who opened a sanctions-screening tool. They are
    // served from public/fonts/ now, so the policy has no external host left to
    // allow — and anything that tries to add one fails loudly instead of
    // quietly phoning home.
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

// JSON responses are gzipped when the client accepts it and the body is worth
// compressing — /api/stats alone is ~96KB of highly repetitive JSON, and it is
// fetched on every insights page load.
function sendJson(res, code, obj, extra, req) {
  let body = Buffer.from(JSON.stringify(obj));
  const headers = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    securityHeaders(), extra || {},
  );
  if (req && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(code, headers);
  res.end(body);
}

/*
 * A JSON body serialized once, for responses that are sent more than once.
 *
 * Bodies worth compressing are kept ONLY gzipped: a 200-row search result is
 * ~450KB of JSON and ~50KB compressed, so a cache of encoded responses holds a
 * tenth of what a cache of the plain text would, and far less than the result
 * objects themselves. The rare client that does not accept gzip gets it
 * decompressed on the way out.
 */
function encodeJson(obj) {
  const json = Buffer.from(JSON.stringify(obj));
  if (json.length <= 1024) return { json, gz: null, bytes: json.length };
  const gz = zlib.gzipSync(json);
  return { json: null, gz, bytes: gz.length };
}

function sendEncoded(res, code, enc, extra, req) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    securityHeaders(), extra || {},
  );
  let body = enc.json;
  if (enc.gz) {
    if (req && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = enc.gz;
      headers['Content-Encoding'] = 'gzip';
    } else body = zlib.gunzipSync(enc.gz);
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(code, headers);
  res.end(body);
}

/*
 * Static files, path-traversal safe, with cache headers and gzip.
 *
 * Each file is read and compressed once and kept until its mtime changes. It
 * used to be read from disk and gzipSync'd on every request — synchronous
 * compression of the same stylesheet and scripts on the event loop for every
 * page view, which is exactly the work a cache exists to not repeat.
 */
function createStaticHandler(publicDir) {
  const cache = new Map(); // filePath -> { mtimeMs, data, gz }

  return function serveStatic(req, res, pathname) {
    let rel = pathname;
    if (rel === '/') rel = '/index.html';
    if (rel.includes('\0')) { res.writeHead(400, securityHeaders()); return res.end('Bad request'); }
    const filePath = path.resolve(publicDir, '.' + path.posix.normalize(rel));
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(403, securityHeaders()); return res.end('Forbidden');
    }
    fs.stat(filePath, (statErr, st) => {
      if (statErr || !st.isFile()) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders())); return res.end('Not found'); }
      const ext = path.extname(filePath);
      // HTML/CSS/JS revalidate each load (unhashed filenames → avoid stale-after-deploy).
      // Font files never change under a given name (family-weight-subset), so
      // they can be cached hard; other static assets for a day.
      const cacheControl = ['.html', '.css', '.js'].includes(ext) ? 'no-cache'
        : ext === '.woff2' ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400';
      const type = MIME[ext] || 'application/octet-stream';
      const send = (entry) => {
        const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': cacheControl }, securityHeaders());
        if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
          headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
          res.writeHead(200, headers); return res.end(req.method === 'HEAD' ? undefined : entry.gz);
        }
        res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : entry.data);
      };
      const hit = cache.get(filePath);
      if (hit && hit.mtimeMs === st.mtimeMs) return send(hit);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders())); return res.end('Not found'); }
        const gz = /text|javascript|json|svg/.test(type) && data.length > 1024 ? zlib.gzipSync(data) : null;
        const entry = { mtimeMs: st.mtimeMs, data, gz };
        // Fonts are large and served with an immutable cache header, so the
        // browser keeps them; holding them here too would be memory for nothing.
        if (ext !== '.woff2') cache.set(filePath, entry);
        send(entry);
      });
    });
  };
}

module.exports = { MIME, securityHeaders, sendJson, encodeJson, sendEncoded, createStaticHandler };
