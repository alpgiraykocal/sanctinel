# Putting Sanctinel on your own domain

Two ways, depending on the URL you want:

| Goal | How | Effort |
|---|---|---|
| `sanctinel.yourdomain.com` | CNAME + Render custom domain | ~10 min, no code |
| `yourdomain.com/sanctinel` | Cloudflare Worker reverse proxy | more moving parts |

A **subdomain** is a hostname, and hostnames are exactly what DNS resolves — so
a single CNAME does it. A **path** is not visible to DNS at all, so it needs
something in front to rewrite the request. Start with the subdomain unless you
specifically need the path; the path recipe is in [the appendix](#appendix-serving-under-a-path).

---

# Subdomain: `sanctinel.yourdomain.com`

You will touch two dashboards. Do them in this order — Render needs to see the
DNS record before it can issue a certificate.

## Step 1 — tell Render the domain exists

1. Go to [dashboard.render.com](https://dashboard.render.com) → click your
   **sanctinel** web service. The address bar now reads
   `https://dashboard.render.com/web/srv-…`.
2. Open the service's **Settings** page — the tab along the top of the service,
   not the account settings in the top-right avatar menu. If you cannot find it,
   append `/settings` to that URL directly.
3. Scroll to the **Custom Domains** section. It sits well down a long page; use
   ⌘F / Ctrl+F for "Custom Domains" rather than hunting for it.
4. Click **+ Add Custom Domain**, type `sanctinel.yourdomain.com` → **Save**.
5. Render now shows the domain as **unverified** along with the DNS record it
   expects — a **CNAME** pointing at your service's `onrender.com` hostname.
   **Copy that value exactly as Render displays it.** Do not assume it; use
   what is on screen.

Leave this tab open — you come back to it in step 3.

## Step 2 — add the DNS record in Cloudflare

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → click
   **yourdomain.com**.
2. Left sidebar → **DNS** → **Records** → **Add record**.
3. Fill it in:
   - **Type**: `CNAME`
   - **Name**: `sanctinel` — just the label, not the full domain. Cloudflare
     appends the rest, so this becomes `sanctinel.yourdomain.com`.
   - **Target**: the value Render gave you in step 1
     (e.g. `sanctinel.onrender.com`)
   - **Proxy status**: click the cloud so it is **grey — "DNS only"**
   - **TTL**: Auto
4. **Save**.

> **The grey cloud matters.** Render issues its own free TLS certificate, and to
> do that it must reach your domain directly. With Cloudflare's orange-cloud
> proxy on, Render cannot complete the certificate challenge and the domain
> stays unverified. Keep it grey at least until the certificate is issued —
> see [Optional](#optional-turn-cloudflares-proxy-on-later) below if you want
> the proxy afterwards.

## Step 3 — verify in Render

1. Back in the Render tab → **Custom Domains** → click **Verify** next to the
   domain.
2. It may say the DNS is not visible yet. That is normal; give it a few minutes
   and click again. DNS changes take time to propagate.
3. Once verified, Render issues the TLS certificate automatically. The domain
   shows a green **Certificate Issued** state. This usually lands within a few
   minutes of verification.

## Step 4 — check it

From a terminal:

```bash
dig +short sanctinel.yourdomain.com
```
Expect to see your `onrender.com` hostname (and the IPs behind it).

```bash
curl -sI https://sanctinel.yourdomain.com | head -1
curl -s https://sanctinel.yourdomain.com/healthz
```
Expect `HTTP/2 200` and `{"status":"ok",...}`.

Then open `https://sanctinel.yourdomain.com` in a browser and confirm:
- the padlock is there and there is no certificate warning
- the page is **styled** (CSS loaded)
- the status pill reads **Live**
- a search returns hits, **Insights** loads, **View network** opens

## If something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Render will not verify | proxy is on | set the record to **DNS only** (grey cloud) |
| `ERR_TOO_MANY_REDIRECTS` | Cloudflare SSL mode is *Flexible* | **SSL/TLS → Overview → Full** |
| No **Custom Domains** section | on the account settings page, or on Overview | it is on the *service's* Settings page — `dashboard.render.com/web/srv-…/settings` |
| Certificate warning | cert not issued yet | wait; re-check Render's Custom Domains panel |
| `dig` returns nothing | record not saved, or wrong name | Name must be just `sanctinel`, not the full domain |
| 30–60s first load | Render free instance was asleep | expected on the free plan; a paid instance does not sleep |

## Optional: turn Cloudflare's proxy on later

Once Render shows the certificate as issued, you *may* switch the record to
**Proxied** (orange cloud) to get Cloudflare's CDN and DDoS protection. If you
do, set **SSL/TLS → Overview** to **Full** first (Render's own guide specifies
Full; Full (strict) also works once its certificate is issued) — on *Flexible*,
Cloudflare talks to Render over plain HTTP, Render redirects to HTTPS, and you
get a redirect loop.

Nothing in the app needs changing either way: `server.js` reads the client IP
from `X-Forwarded-For` for its per-IP rate limiting, which both Render and
Cloudflare set correctly.

---

# Appendix: serving under a path

`yourdomain.com/sanctinel` cannot be done with DNS. A record points a *hostname*
at a server and never sees the path, so a proxy has to sit in front and rewrite
the request. On Cloudflare that is a Worker.

The app itself is already path-agnostic — every same-origin reference in
`public/` is relative (`styles.css`, `api/search`, `./`), so the pages work at a
domain root and under any prefix.

1. **DNS**: the apex must resolve through Cloudflare — an existing **Proxied**
   record, or a placeholder `AAAA @ 100::` set to **Proxied**.
2. **Worker**: Workers & Pages → Create Worker → paste
   [`cloudflare-worker.js`](./cloudflare-worker.js) → Deploy. Adjust the two
   constants at the top if your origin or prefix differ.
3. **Route**: Worker → Settings → Domains & Routes → Add Route →
   `yourdomain.com/sanctinel*`. The trailing `*` is required so it covers
   `/sanctinel/app.js`, `/sanctinel/api/search` and the rest.
4. **SSL/TLS → Overview**: **Full** or **Full (strict)**.

The Worker handles two things that are easy to miss: it redirects `/sanctinel`
to `/sanctinel/` (without the trailing slash the browser resolves relative URLs
one level too high) and forwards `CF-Connecting-IP` as `X-Forwarded-For` so
per-IP rate limiting still sees individual visitors rather than one.

Test it locally before touching DNS:

```bash
node server.js &          # origin on :3000
node deploy/pathproxy.js  # prefixed on :3200
open http://127.0.0.1:3200/sanctinel/
```
