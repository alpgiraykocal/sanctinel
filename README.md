# Sanctinel — Sanctions Screening

Web app that screens a party name / entity / vessel against the U.S. Treasury
**OFAC**, the **EU**, the **UN Security Council**, and the **UK OFSI** consolidated sanctions
lists. Zero external dependencies — pure Node.js.

Each source is fetched directly from the issuing authority (public-domain
government data), tagged with its authority, and merged into one daily snapshot;
the UI lets you filter by authority and shows an authority badge + regime-specific
guidance per hit. Additional-source parsers live in `lib/sources/` (`eu.js`, `un.js`,
`uk.js`) — each is best-effort, so one unreachable feed never sinks the snapshot.

## Free deploy (GitHub + Render)

Included `render.yaml` deploys this as a free Render web service (no card required):

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New + → Blueprint** → select the repo → Apply.
3. Done — Render gives you `https://sanctinel.onrender.com` (TLS included). Add your own
   domain under *Settings → Custom Domains* (CNAME).

Free-tier behavior: the service sleeps after 15 min idle and wakes in ~30s on the next
visit; the disk is ephemeral, so on wake it boots with sample data and pulls the live
snapshot in the background (~2 min, shown as "Updating…" in the UI).

## Deploying publicly

The server is hardened for a single-instance public deployment, but **terminate TLS at a
reverse proxy** (Caddy / nginx / a platform load balancer) in front of it — it speaks
plain HTTP.

Built-in protections: strict security headers (CSP, `X-Frame-Options: DENY`, nosniff,
`no-referrer`), per-IP rate limiting (API + a tighter search limit), input length caps,
a 60s query-result cache, path-traversal-safe static serving, gzip, top-level error
handling (a bad request can't crash the process), and graceful shutdown. Search queries
are **never logged** (access log records the path only).

Environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | bind address |
| `ADMIN_TOKEN` | *(unset)* | when set, enables `POST /api/refresh` (via `?token=` or `X-Admin-Token`); unset ⇒ manual refresh is disabled and the UI hides the button (auto-refresh on TTL still runs) |
| `CACHE_TTL_MS` | `43200000` (12h) | background refresh when the cache is older than this |
| `RATE_MAX` / `SEARCH_RATE_MAX` | `120` / `30` per min | per-IP limits |
| `TRUST_PROXY` | `true` | read client IP from `X-Forwarded-For` (set `false` if not behind a proxy) |

Example behind Caddy:

```
sanctions.example.com {
  reverse_proxy localhost:3000
}
```

Health check: `GET /healthz`. Scaling note: screening is CPU-bound and single-threaded
(~0.9s per cold uncached query over ~20k entities). One instance + rate limiting suits a
demo; for heavy traffic run multiple instances behind the proxy (each keeps its own
cache) or move matching to a worker pool.

**Data & legal.** All list data (OFAC, EU, UN Security Council, UK OFSI) is government
public-domain; the authoritative source for each hit is the issuing authority's own
list. This app is an **educational/analysis tool, not legal advice**, and its snapshot
may lag an authority by up to a day — the UI says so. Regimes carry different legal
obligations, so each result is tagged with the authority that listed it. Do not present
it as a system of record for compliance decisions.

## Run

```bash
node server.js
```

Then open http://localhost:3000. **Live by default** — the server boots instantly from
the on-disk cache (`cache/snapshot.json`) when present, and refreshes in the background
(worker thread) when the cache is missing or older than 12h, so a restart shows real
data immediately instead of waiting ~2 min for the parse. A blue pulsing dot + "loading
live…" shows while a refresh runs; the UI polls and swaps in the fresh snapshot with no
reload. `Refresh live` forces a background refresh.

Offline / fictional-demo mode (no network):

```bash
node server.js --demo
```

## Why a backend (not a browser-only page)

The SLS API has **no name-search endpoint** — you can only fetch entities by
`entity-id`, `list`, or `program`. To screen a *name* you must download the full
list and match locally. The server also solves what a browser cannot:

- **CORS** — the SLS host does not serve browser CORS headers.
- **`User-Agent`** — required by the SLS.
- **Immutable snapshot** — the list is pinned to a publication id so any alert is
  reproducible against the exact list state at decision time.
- **Poison-pill guards** — refuses to promote a snapshot with too few entities; a
  silently truncated parse (clean run, zero hits) is the worst failure in screening.

## Matching

Not naive exact string matching. `lib/matcher.js` normalizes (uppercase, ASCII-fold,
strip corporate suffixes) and matches on primary names **and every alias** (with alias
type and low-quality flag). Token similarity is **multi-algorithm** — the max of:

- **Jaro-Winkler** (typo/prefix),
- **Damerau-Levenshtein** edit similarity (adjacent transpositions cost one edit),
- **Sørensen–Dice** bigram + **trigram Jaccard** overlap,
- **Metaphone** phonetic key (Mohammed↔Muhammad, Smith↔Smyth, Philip↔Filip),
- **IDF term weighting** (rare surnames outweigh words like "Company"),
- **multilingual legal-form stripping** + **Cyrillic homoglyph folding**,
- **transliteration folding** (Kadyrov↔Kadirov, Phillip↔Filip — gated so lossy folds
  can't match unrelated tokens),
- **initial/abbreviation** (J ↔ John).

Tokens are assigned **greedily 1:1** (no token reused, order-independent), with a
whole-string channel and **acronym/initialism** matching (CML ↔ Caspian Maritime
Logistics). Strength is classified `exact → strong → fuzzy → weak`; common single given
names (Ali, Mohammed…) are downgraded to cut noise.

**Secondary-identifier corroboration:** optional year-of-birth and country/nationality
inputs act as **score modifiers** — they raise a fuzzy hit they confirm and lower one
they contradict (a green `ID ✓` / red `ID ✗` badge shows which), never as a hard filter.
This is the standard screening control of using secondary identifiers to resolve fuzzy
name matches.

**Non-name identifier screening:** the query is also matched exactly (case/space/
punctuation-insensitive) against every structured identifier — passport, national/tax/
registration IDs, IMO, MMSI, call sign, aircraft tail, digital-currency address, email,
phone — producing an `identifier` match type. Screening the full identifier surface,
not just names, is required by OFAC guidance.

## Complete record

Each hit surfaces the full entity: all names/aliases (typed), addresses, and every
extractable attribute grouped as **Identity** (DOB, POB, nationality, citizenship,
gender), **Documents** (passport, national/tax/registration IDs), **Vessel / Aircraft**
(IMO, MMSI, call sign, flag, type, tonnage, tail no.), **Digital & Contact** (crypto
address, email, phone, website), and **Program & Provenance** (programs, sanctions type,
legal authority, date published, raw remarks). `lib/ingest.js` extracts these from the
OFAC remarks blob + dedicated vessel columns. Each card exposes a **Copy JSON** of the
full structured record for case files / downstream systems.

## Full OFAC object model

Live refresh prefers the **advanced `/entities` XML** (`lib/advanced.js`, parsed by the
zero-dep `lib/xml.js`) — the complete OFAC model — and falls back to flat files, then
demo data. Surfaced in full:

- **Names**: primary + every alias, alias type (A.K.A./F.K.A./N.K.A.), low-quality flag,
  script, **native-script rendering** (Cyrillic/Arabic/Chinese…), and name parts.
- **Identity documents**: type, number, **issuing country, issue + expiration dates**.
- **Relationships & ownership**: linked-to and **50%+ ownership chains** (drives the
  50 Percent Rule; a red "50% Rule" flag + trace note appears on owned entities).
- **Features (generic)**: any OFAC feature type is captured — DOB (with approximate /
  date-range handling), POB, nationality, citizenship, gender, LEI, VAT, SWIFT/BIC,
  organization type/date, vessel + aircraft data, digital-currency addresses, contact —
  known types are grouped, unknown types fall through to "Other" so nothing is dropped.
- **Multiple** sanctions types and legal authorities, plus programs, list, date published.

## Relationship network (ego graph)

Any hit with relationships shows a **View network** button that opens a radial ego-graph
(`lib/graph.js` + `public/graph.js`, `GET /api/graph/ego-network?id=&depth=`):

- **Local network only** — BFS around the center entity, default depth 2 (max 3), never
  the full graph. Center in the middle, 1-hop in ring one, 2-hop in ring two.
- **Direction + type + ownership preserved.** 50%+ ownership edges are drawn red and
  thick; the panel flags them because they drive the 50 Percent Rule. External/unlisted
  related parties appear as dashed nodes (an unlisted 50%+ owner still blocks its chain).
- **Explainable metrics** — degree + weighted degree (ownership weighted double), top-5
  ranked in the side panel. Deterministic layout (sorted by name), hover for detail,
  click a node to recenter.
- **Hybrid rendering** — Canvas 2D for small/medium graphs (curved edges, direction
  arrows, shadows, haloed labels); **WebGL** geometry (GL points + lines) for large
  graphs (> 140 nodes) with a 2D overlay for hop guides, culled labels and tooltip, so
  a 300-node live ego-network stays smooth. A badge shows the active renderer + counts.
- **Audit line** — center, depth, node/edge counts, ownership-edge count, timestamp.
- Framed as a **triage/display aid, not a suspicious-activity or blocking determination.**

## Data

- Ships with **fictional demo data** (`sample-data/sample.json`) so the UI runs offline
  with every field type populated. The header shows an amber **DEMO** dot.
- Live snapshots merge **OFAC + EU + UN + UK** (~31.8k parties). A green **LIVE** dot shows
  the merged source and OFAC publication id; the **Authority** filter and per-result
  badge tell you which regime listed a party.

## Compliance boundary

This tool produces **screening analysis, not legal advice or a determination**. A name
hit is a lead. The obligations differ by regime — an OFAC blocking designation, a UN
asset freeze and a UK OFSI designation are not interchangeable — so each result states
its authority. Blocking vs. rejecting, the 50% Rule on ownership (OFAC-specific), and
license analysis must be confirmed against the issuing authority and routed to
sanctions compliance.

## Files

| Path | Role |
|------|------|
| `server.js` | HTTP server, static hosting, `/api/search`, `/api/meta`, `/api/refresh` |
| `lib/ingest.js` | SLS fetch, CSV parse, snapshot build, poison-pill guard |
| `lib/matcher.js` | Normalization + fuzzy scoring + match classification |
| `public/` | Frontend (HTML / CSS / JS) |
| `sample-data/` | Fictional offline demo dataset |
