/*
 * Cloudflare Worker: serve Sanctinel under a PATH on your own domain, e.g.
 *   https://alpgiraykocal.com/sanctinel/  →  https://sanctinel.onrender.com/
 *
 * Why a Worker at all: DNS records point a HOSTNAME at a server. They cannot
 * route a path, so no CNAME can put an app at /sanctinel. Something has to sit
 * in front and rewrite the request, and on Cloudflare that is a Worker.
 *
 * What it does:
 *   - strips the /sanctinel prefix before forwarding, so the origin still sees
 *     the paths it was written for (/, /api/search, /styles.css …);
 *   - redirects /sanctinel to /sanctinel/ — without the trailing slash the
 *     browser resolves the app's relative URLs one level too high;
 *   - sends the origin's own Host header, so Render routes to the right service
 *     without needing a custom domain configured there;
 *   - passes the visitor's IP through, so the app's per-IP rate limiting keeps
 *     working instead of seeing every request as one client.
 *
 * Deploy: Workers & Pages → Create Worker → paste → Deploy, then add the route
 * alpgiraykocal.com/sanctinel* to it. See deploy/README.md.
 */

const ORIGIN = 'sanctinel.onrender.com';
const PREFIX = '/sanctinel';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Relative URLs in the page resolve against the directory of the current
    // document. At /sanctinel (no slash) that directory is "/", so every asset
    // and API call would be requested from the domain root and 404.
    if (url.pathname === PREFIX) {
      return Response.redirect(`${url.origin}${PREFIX}/${url.search}`, 301);
    }
    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      return new Response('Not found', { status: 404 });
    }

    const upstream = new URL(url);
    upstream.hostname = ORIGIN;
    upstream.protocol = 'https:';
    upstream.port = '';
    upstream.pathname = url.pathname.slice(PREFIX.length) || '/';

    const headers = new Headers(request.headers);
    headers.set('Host', ORIGIN);
    // server.js trusts X-Forwarded-For for rate limiting (TRUST_PROXY).
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) headers.set('X-Forwarded-For', ip);

    const response = await fetch(new Request(upstream, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    }));

    // If the origin redirects, keep the visitor inside /sanctinel.
    const location = response.headers.get('Location');
    if (location && location.startsWith('/')) {
      const out = new Headers(response.headers);
      out.set('Location', PREFIX + location);
      return new Response(response.body, { status: response.status, headers: out });
    }
    return response;
  },
};
