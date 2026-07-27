# Serving Sanctinel at `yourdomain.com/sanctinel`

## Why this needs more than a DNS record

A DNS record points a **hostname** at a server. It carries no path, so there is
no CNAME or A record that can put an app at `/sanctinel` — DNS never sees that
part of the URL. Something has to sit in front of the request and rewrite it.
On Cloudflare that something is a **Worker**.

Two things are therefore required:

1. **The app must not assume it lives at `/`.** Every same-origin reference in
   `public/` is relative (`styles.css`, `api/search`, `./`), so the pages work
   at the domain root *and* under any prefix. This is already done.
2. **A Worker strips the prefix** before forwarding to Render, so the origin
   still sees the paths it was written for.

If you would accept `sanctinel.yourdomain.com` instead, skip all of this: add a
CNAME to `sanctinel.onrender.com`, add the custom domain in Render, done. The
path version is the one that needs a Worker.

---

## Step 1 — make sure the apex resolves through Cloudflare

Cloudflare only runs a Worker on a hostname it proxies.

1. Cloudflare dashboard → your domain → **DNS → Records**.
2. If `alpgiraykocal.com` already has an A/AAAA/CNAME record, make sure its
   proxy status is **Proxied** (orange cloud), not "DNS only".
3. If the apex has no record at all, add a placeholder so the name resolves:
   - Type `AAAA`, Name `@`, IPv6 address `100::`, Proxy status **Proxied**.
   - `100::` is the IPv6 discard prefix. Nothing is hosted there; the Worker
     answers before the origin is ever contacted.

## Step 2 — create the Worker

1. Cloudflare dashboard → **Workers & Pages → Create → Create Worker**.
2. Name it e.g. `sanctinel-proxy` → **Deploy** (it deploys the placeholder).
3. **Edit code**, delete what is there, paste the contents of
   [`cloudflare-worker.js`](./cloudflare-worker.js), then **Deploy**.
4. If your Render URL or desired path differ, change the two constants at the
   top of that file:
   ```js
   const ORIGIN = 'sanctinel.onrender.com';
   const PREFIX = '/sanctinel';
   ```

## Step 3 — route the path to the Worker

1. Still in the Worker → **Settings → Domains & Routes → Add → Route**.
2. Zone: `alpgiraykocal.com`
3. Route: `alpgiraykocal.com/sanctinel*`
   - The trailing `*` matters: it must cover `/sanctinel/app.js`,
     `/sanctinel/api/search`, and everything else under the prefix.
   - Add `www.alpgiraykocal.com/sanctinel*` as a second route if you serve
     `www` as well.
4. Save.

## Step 4 — check SSL mode

**SSL/TLS → Overview** must be **Full** or **Full (strict)**. On *Flexible*,
Cloudflare talks to Render over plain HTTP; Render redirects to HTTPS, and the
result is a redirect loop.

## Step 5 — verify

```bash
curl -sI https://alpgiraykocal.com/sanctinel | grep -i location   # → /sanctinel/
curl -s -o /dev/null -w '%{http_code}\n' https://alpgiraykocal.com/sanctinel/
curl -s 'https://alpgiraykocal.com/sanctinel/api/search?q=Sberbank' | head -c 120
```

Then open `https://alpgiraykocal.com/sanctinel/` and confirm the page is styled
(CSS loaded), the status pill says **Live**, a search returns hits, and
**Insights** and **View network** both work.

---

## Notes

- **Rate limiting still works.** The Worker forwards the visitor's IP as
  `X-Forwarded-For`, which is what `server.js` keys its per-IP limits on. Without
  it every request would look like one client and legitimate users would be
  throttled together.
- **The trailing slash is load-bearing.** `/sanctinel` without it makes the
  browser resolve `styles.css` against `/`, not `/sanctinel/`. The Worker 301s
  to add it.
- **`robots.txt` is not proxied.** Crawlers only read it at the domain root, so
  add the disallow line to your apex `robots.txt` if you serve one:
  ```
  Disallow: /sanctinel/api/
  ```
- **Free plan limits.** Workers allow 100,000 requests/day, which this app will
  not approach. Render's free instance still sleeps after inactivity, so the
  first request after a quiet period takes 30–60s regardless of Cloudflare.
- **Testing locally.** `deploy/pathproxy.js` in this directory mimics the Worker
  against a local server, so the prefixed build can be checked before any DNS
  change:
  ```bash
  node server.js &          # origin on :3000
  node deploy/pathproxy.js  # prefixed on :3200
  open http://127.0.0.1:3200/sanctinel/
  ```
