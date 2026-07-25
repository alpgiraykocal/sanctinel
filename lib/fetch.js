'use strict';

// Minimal redirect-following HTTPS GET → string. UN/UK endpoints 302 to
// time-signed blob URLs, so following Location is required.
const https = require('https');

function fetchText(url, { headers = {}, depth = 0, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 sanctinel/1.0 (compliance screening)', Accept: '*/*' }, headers),
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, { headers, depth: depth + 1, timeout }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout for ${url}`)));
    req.on('error', reject);
  });
}

module.exports = { fetchText };
