'use strict';
// Local stand-in for the Cloudflare Worker (deploy/cloudflare-worker.js): same
// app can be exercised at http://127.0.0.1:3200/sanctinel/ before touching DNS.
const http = require('http');
const PREFIX = '/sanctinel';
const ORIGIN = { host: '127.0.0.1', port: 3000 };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === PREFIX) {
    res.writeHead(301, { Location: `${PREFIX}/${url.search}` });
    return res.end();
  }
  if (!url.pathname.startsWith(`${PREFIX}/`)) {
    res.writeHead(404); return res.end('Not found');
  }
  const path = (url.pathname.slice(PREFIX.length) || '/') + url.search;
  const p = http.request({ ...ORIGIN, path, method: req.method, headers: { ...req.headers, host: '127.0.0.1:3000' } }, (up) => {
    const headers = { ...up.headers };
    if (headers.location && headers.location.startsWith('/')) headers.location = PREFIX + headers.location;
    res.writeHead(up.statusCode, headers);
    up.pipe(res);
  });
  p.on('error', (e) => { res.writeHead(502); res.end('proxy: ' + e.message); });
  req.pipe(p);
}).listen(3200, () => console.log('path proxy on http://127.0.0.1:3200' + PREFIX + '/'));
