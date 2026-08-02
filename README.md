# Sanctions Search

Web app that screens a party name / entity / vessel against the U.S. Treasury
**OFAC**, the **EU**, the **UN Security Council** and the **UK OFSI** consolidated sanctions
lists, plus the U.S. **BIS** and **State Department** export-control restricted-party lists. Zero external dependencies — pure Node.js.

Each source is fetched directly from the issuing authority (public-domain
government data), tagged with its authority, and merged into one daily snapshot;
the UI lets you filter by authority and shows an authority badge + regime-specific
guidance per hit. Additional-source parsers live in `lib/sources/` (`eu.js`, `un.js`,
`uk.js`, `csl.js`) — each is best-effort, so one unreachable feed never sinks the snapshot.

## Free deploy (GitHub + Render)

Included `render.yaml` deploys this as a free Render web service (no card required):

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New + → Blueprint** → select the repo → Apply.
3. Done — Render gives you `https://sanctinel.onrender.com` (TLS included).

To put it on your own domain, [`deploy/README.md`](deploy/README.md) walks through both
shapes step by step: a **subdomain** (`sanctinel.yourdomain.com` — one CNAME, no code)
and a **path** (`yourdomain.com/sanctinel` — needs a reverse proxy, since DNS cannot
route a path; a ready Cloudflare Worker is in `deploy/`).

Free-tier behavior: the service sleeps after 15 min idle and wakes in ~30s on the next
visit; the disk is ephemeral, so on wake it boots with sample data and pulls the live
snapshot in the background (~2 min, shown as "Updating…" in the UI).

## Deploying publicly

The server is hardened for a single-instance public deployment, but **terminate TLS at a
reverse proxy** (Caddy / nginx / a platform load balancer) in front of it — it speaks
plain HTTP.

**No third-party requests.** The CSP is `default-src 'self'` with no external host allowed —
fonts are served from `public/fonts/` rather than fonts.googleapis.com, which used to hand
Google the IP and User-Agent of everyone who opened the tool. On a screening app, *who is
searching* is the sensitive part, so a typeface was the wrong thing to leak it for.
IBM Plex is SIL OFL 1.1 (`public/fonts/LICENSE.txt`).

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
| `SANCTIONS_SEARCH_CONTACT` | *(unset)* | mailbox put in the outgoing `User-Agent`. OFAC asks data consumers to identify themselves; set this to an address you read, so a publisher can reach you instead of silently throttling |
| `ALLOW_AUTHORITY_DROP` | *(unset)* | build-cache escape hatch: publish a snapshot even if it lost an authority. Only for an authority that is genuinely retired — see "Coverage guard" below |
| `ALLOW_QUALITY_DROP` | *(unset)* | build-cache escape hatch: publish even if a measured field regressed. Only for a field a publisher genuinely stopped providing — see "Field-level quality gate" below |

### Cold start and refresh recovery

**Booting no longer looks like an outage.** `server.listen` opened the port and then, in
the same tick, gunzipped and parsed the snapshot and built the trigram index — ~2.5s here
and closer to 18s on a small instance. Requests arriving in that window were accepted and
answered by nobody, so the platform proxy returned **502**: on a free tier that sleeps
after 15 idle minutes, every first visitor saw one.

The load is now deferred off the listen callback, and `searchindex.buildAsync` builds the
index in 2,000-entity slices with the event loop free between them (proved byte-identical
to `build()`). Throughout, `/healthz` answers 200 with `booting: true` — liveness, so a
platform health check does not kill the container mid-boot — while `/api/*` returns
**503 + Retry-After**. That distinction is deliberate: until the snapshot is parsed the
process still holds the fictional sample data it starts with, and screening against that
and returning it as a result would be far worse than a short wait. Every page fetches
through `SS.getJson`, which waits out a 503 rather than reporting an error the user can
do nothing about.

**A second refresh pass recovers from upstream outages.** On 2026-08-01 the EU list served
HTTP 500 for hours; the coverage guard correctly refused to publish, and because the
workflow ran once a day that unrelated outage froze OFAC, UN and UK data for a full 24
hours too. An 11:00 UTC pass runs with `ONLY_IF_DEGRADED=1`, which exits before fetching
anything when the published snapshot already has full coverage — so on a normal day it
costs seconds and adds no commit, and on a bad day it halves the staleness.

### Coverage guard

`scripts/build-cache.js` (and the background refresh worker) checks that the new
snapshot still covers every authority it should, and treats two cases differently:

| Case | Publish? | Exit |
|---|---|---|
| **Regression** — the previous snapshot had this authority, this build lost it | **No.** The snapshot on disk covers more; keep serving it | `1` |
| **Standing gap** — the authority was already missing last build too | **Yes.** The other authorities are fresh and withholding them just adds missed designations on top of a known gap | `3`, after the commit step, so the run still goes red |

This exists because of a real incident: the `api.trade.gov` TLS certificate
expired on 2026-07-28, the CSL fetch threw, the daily build reported success, and
**6,256 BIS + State export-control records silently disappeared** from the
published snapshot while the UI still offered both as filters. A screening list
that quietly gets smaller produces false negatives, and an empty result reads
identically to a clean one.

The standing-gap check compares against the source list in `lib/ingest.js`, not
against the last snapshot — comparing only to the last one *ratchets*, since a
single degraded publish makes the shrunken set the new floor and the alarm goes
quiet forever. Retiring an authority is therefore a code change (remove its entry
from `EXTRA_SOURCES`), which is reviewable.

When the snapshot is missing an authority, the app shows a red banner naming it
and linking to the authority's own list. `GET /api/meta` reports it as
`missingAuthorities` with `sourceFailures` explaining why.

Note that the fix for an expired certificate is for the publisher to renew it.
Do not disable TLS verification to work around this: these responses **are** the
screening list, so an unverified one invites list tampering.

### Field-level quality gate

The coverage guard catches an authority vanishing. It cannot catch the failure one level
down: the authority is still there, the entity count is normal, and **a field has gone
quiet**. Every feed here is parsed from a format its publisher can change without telling
anyone, and this app reads those fields for real decisions:

- if OFAC renamed `Birthdate`, every birth date would stop being one, the year-of-birth
  modifier would silently stop corroborating anything, and the build would go green;
- if the EU reordered its XML, addresses could empty out while names kept parsing;
- if the relationship block moved, the 50 Percent Rule module would report *"no ownership
  chain to a blocked person"* for every party in the list — which reads exactly like a
  clean result.

None of those shrink the snapshot enough to trip a count floor. So `lib/quality.js`
profiles each build — per authority: parties, alias / address / identifier / birth-date /
nationality fill rates, relationship edges; globally: date-parse rate, country-resolution
rate, and how much of the vocabulary went unclassified — writes it to
`cache/quality.json` next to the snapshot, and compares the next build against it.

| Case | Publish? | Exit |
|---|---|---|
| **Regression** — a measure fell materially against the published profile (>10% for a party count, >25% for a rate) | **No.** The snapshot on disk is fuller; keep serving it | `1` |
| **Below floor** — worse than a minimum written down in `lib/quality.js`, but no worse than last time | **Yes.** The rest of the data is fresh | `3`, after the commit step |

The floors are constants in code rather than a high-water mark taken from the last
profile, for the same reason the standing-gap check compares against `EXTRA_SOURCES`:
comparing only to last time ratchets, and one degraded publish would become the new
normal. Moving a floor is a reviewable diff. `ALLOW_QUALITY_DROP=1` overrides, for a
field a publisher genuinely stopped providing.

Exercised against six synthetic degradations — a renamed label, an emptied address block,
a vanished ownership graph, an unparseable date format, country fields replaced with
internal codes, and an ordinary day of churn. The first five block or alarm; the ordinary
day passes clean.

```bash
node scripts/quality-report.js
```

prints the current profile and the verdict without a rebuild — the question "did that
parser change move any field" should be one command, not a fetch of every upstream list.
`--write` adopts the current numbers as the baseline, which is for seeding or for a
reviewed change; using it to silence a finding disables the alarm rather than answering
it.

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

**Data & legal.** All list data (OFAC, EU, UN, UK OFSI, BIS, State Dept) is government
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

## iPhone app

`ios/` holds a native SwiftUI app that screens **entirely on the device** — no
server, no query leaving the phone, works with no network at all. It downloads
`cache/snapshot.json.gz` (the same file the GitHub Action rebuilds nightly),
builds its own search index on the device, and does the rest locally.

```bash
open ios/Sanctinel.xcodeproj
```

`ios/SanctinelCore` is a line-by-line Swift port of `lib/matcher.js`,
`lib/searchindex.js`, `lib/graph.js`, `lib/stats.js` and `lib/countries.js`. Two
scorers that drift apart would let the phone clear a party the web app flags, so
the JavaScript is the reference and CI proves the port reproduces it exactly —
4,909 frozen screening cases, 21 end-to-end queries over the full snapshot, and
the recall invariant. Change the JS scorer without regenerating the fixtures and
[the build fails](.github/workflows/ios-conformance.yml).

```bash
node scripts/gen-conformance-fixtures.js   # freeze the JS output
cd ios/SanctinelCore && swift test         # prove Swift reproduces it
```

See [ios/README.md](ios/README.md).

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
- **multilingual legal-form stripping** + **script-aware normalization** (below),
- **transliteration folding** (Kadyrov↔Kadirov, Phillip↔Filip — gated so lossy folds
  can't match unrelated tokens),
- **initial/abbreviation** (J ↔ John).

Tokens are assigned **greedily 1:1** (no token reused, order-independent), with a
whole-string channel and **acronym/initialism** matching (CML ↔ Caspian Maritime
Logistics). Strength is classified `exact → strong → fuzzy → weak`; common single given
names (Ali, Mohammed…) are downgraded to cut noise.

Scoring is where essentially all search time goes — candidate selection is ~1ms — so the
hot path is kept tight: per-token derivations (transliteration fold, metaphone key,
bigram and trigram sets) are **memoized on the token string**, since the same tokens
recur relentlessly across 38k records; Damerau-Levenshtein runs on three rolling typed
rows instead of allocating a matrix per call; and the edit and Dice channels are skipped
when their own exact upper bounds cannot beat the score already in hand. None of this
changes a single score — verified pair-by-pair against the previous implementation.

### Non-Latin scripts

A name is normalized **per token, by script**, and own-script names are searchable:

- **Cyrillic, Greek, Arabic and Hebrew are transliterated**, not deleted. Cyrillic
  follows BGN/PCGN — the scheme OFAC, the EU and the UK themselves romanize with — so
  `ГУСЕВ` lands on `GUSEV`, the list's own spelling. Arabic and Hebrew romanize to a
  consonant skeleton (`مصرف` → `MSRF`), which the existing transliteration fold then
  collapses onto the list's vowelled spelling.
- **Han, kana and hangul are kept and matched as characters.** There is no romanization
  without a pronunciation dictionary, and deleting them meant a CJK query matched
  nothing at all.
- **Homoglyph folding is applied only to mixed-script tokens.** Folding Cyrillic
  lookalikes to Latin defeats `сompany`-style evasion, but applied to a genuinely
  Cyrillic name it was destroying it: `ГУСЕВ` became `YCEB`, and `Сбербанк` scored a
  perfect **1.00 against `Альфа-Банк`** because both collapsed to noise. Per-token script
  detection keeps the evasion defence while leaving real names intact.
- **`names[].native` is indexed.** The own-script forms published alongside the romanized
  ones — 9k of them — were parsed, stored and rendered, but never handed to the scorer or
  the index, so pasting a name in its own script returned nothing.

Self-recall across the snapshot is **100% on all 15,424 non-Latin name strings** and
unchanged on the 86,792 Latin ones. `scripts/verify-recall.js` carries a `native` query
family so this stays covered — the other families run through a `[A-Za-z ]` filter and
could never have caught a script being dropped.

**Secondary-identifier corroboration:** optional year-of-birth and country/nationality
inputs act as **score modifiers** — they raise a fuzzy hit they confirm and lower one
they contradict (a green `ID ✓` / red `ID ✗` badge shows which), never as a hard filter.
This is the standard screening control of using secondary identifiers to resolve fuzzy
name matches.

The country modifier compares **ISO-3166 codes, not strings**. Four authorities write one
jurisdiction four ways — OFAC `Korea, North`, the EU `KOREA, DEMOCRATIC PEOPLE'S REPUBLIC
OF`, plus `DPRK` and `North Korea` — and the string comparison shared no token between
them, so a user typing "North Korea" against a party OFAC publishes under the long form
got the **red contradiction badge and a score penalty for a corroborating identifier**.
Across the snapshot that was 2,254 wrong verdicts on a twelve-country probe. `lib/countries.js`
now resolves 99.96% of the 41,726 country-bearing values to a code (up from 97.8% before
its table was completed to full ISO-3166), and three details earn their keep:

- **Sovereign expansion.** `HK`, `MO`, the British and French overseas territories carry a
  parent, and codes are expanded on both sides, so a Hong Kong party does not contradict
  "China" — and typing "Hong Kong" against a party listed in China does not either. The
  cost is that two territories of one sovereign corroborate each other; on a ±0.04 nudge,
  not penalizing an ambiguous jurisdiction signal is the safe direction.
- **Address lines are read where the country field is empty.** 3,582 addresses in the
  snapshot say `Located in Syria` with no structured country, and the string comparison
  this replaces did see them. The rightmost jurisdiction in the line wins, which is postal
  convention — `Atlanta, Georgia, United States` is in the US, not in Georgia.
- **Unresolved values fall back to the old string comparison** rather than silently
  skipping the check, so a region or disputed territory the table does not know is still
  screened the way it always was.

Entity records keep the authority's own wording throughout — the codes are a comparison
surface, not a rewrite of the published data.

The year-of-birth modifier compares **intervals, not a list of years**. The lists publish
a birth date twelve different ways, and 140 of those values state a multi-year range
("1975 to 1979"). Pulling every `\b(19|20)\d\d\b` out of the string and testing the user's
year for membership caught the two endpoints and nothing between them, so **162 years that
the list itself places inside a stated range scored as contradictions**. `lib/dates.js`
parses all 16,975 birth-date values (100%) into inclusive `from … to` bounds plus the
precision they were stated at — day, month, year or range — and the modifier tests
overlap. Precision is kept rather than discarded: "born 1990" and "born 26 Mar 1990" are
different evidence, and a reviewer comparing a passport to a hit needs to see which the
list actually gave.

### Canonical field vocabulary

One snapshot carries **92 distinct attribute labels and 131 identifier types** for maybe
two dozen real concepts, because each authority uses its own wording. A birth date is
`Birthdate` under OFAC and `Date of Birth` everywhere else — 8,254 against 8,721. A
national identity number is `National ID` (6,906), `National ID No.` (1,699) and
`National Identification Number` (149).

Consumers used to pattern-match their way around that, and it had already gone wrong
where nobody was looking: the statistics page selected nationality with
`label === 'Nationality' || label === 'Citizenship'`, which **never matched OFAC's own
`Nationality Country` (5,821 attributes) or `Citizenship Country` (1,142)**. For every
OFAC party the country chart quietly fell back to the address country, so it described
where a party is located rather than what it is a national of.

`lib/vocab.js` tags each attribute and identifier with a canonical `kind` at ingest —
100% of attribute labels and 95.8% of identifier types resolve, and the 4.2% that do not
are values the publisher itself declined to type ("Identification Number", "Other
identification number"). The authority's own label and value are untouched; the kind is
what code compares, so the screening modifier now selects `kind === 'dob'` rather than
`/birth|born|dob/i` (which also matched "Place of Birth" and would read a year out of a
birthplace).

The annotations are **derived at read time, not stored**: rebuilding them costs 112ms
across the whole snapshot, while persisting them would add 7.3% to a 5MB blob this repo
commits every single day. It also keeps `cache/snapshot.json.gz` exactly what the
authorities published, with this layer's opinions correctable by shipping code rather
than by a rebuild.

Both derivations are frozen in the iOS conformance fixture over the **real inventory** —
every distinct label, type and birth-date value in the snapshot, 11,688 cases — because
they decide which attribute *is* a birth date and which year corroborates a hit, and a
port that quietly disagreed would move scores on the phone and nowhere else.

**Non-name identifier screening:** the query is also matched exactly (case/space/
punctuation-insensitive) against every structured identifier — passport, national/tax/
registration IDs, IMO, MMSI, call sign, aircraft tail, digital-currency address, email,
phone — producing an `identifier` match type. Screening the full identifier surface,
not just names, is required by OFAC guidance.

### Candidate prefilter and its recall invariant

Scoring a query against all 38k entities takes ~2s, so at the default threshold
`lib/searchindex.js` narrows the field to entities that share enough trigrams with the
query (~5–10% of the list, 5-10× faster). That optimisation is only safe if it can never
hide a hit a full scan would have found — a false negative is the failure mode that
matters in screening — so every scoring channel that can reach 0.95 is reproducible
from the index:

| Channel | Why trigrams alone miss it | Index lane |
|---|---|---|
| transliteration variants | Kadyrov/Kadirov differ throughout | trigrams of the **folded** form, and the scorer only applies the boost when the folded forms actually share one |
| acronyms | "CCC" shares nothing with China Communications Construction Company | **acronym** index of each name's initials |
| short-token typos | one transposition in GHSAIR/GHASIR breaks every trigram | **bigram** lane for tokens ≤ 7 chars, ≥ 2 shared |
| exact identifiers | an IMO number shares nothing with a name | identifier index |

Below the default threshold — an analyst deliberately widening the net — `server.js`
full-scans instead, because no cheap index covers what the scorer accepts down there.
`node scripts/verify-recall.js [n]` checks the invariant against the real snapshot by
running typo, acronym and verbatim queries down both paths and failing on any
divergence.

**Cost of the index.** Postings are stored CSR-style — one flat `Int32Array` per lane
plus an offset table — not as a `Map` of per-key arrays. Over the live 38k snapshot that
is 2.3M postings in 70k lists: **36MB** as arrays-of-arrays, **9MB** flat. On a 512MB
container that difference decides whether the process survives, and the flat form scans
faster besides (candidate selection is ~1ms; effectively all search time is scoring).
The index is built a few seconds after boot rather than inside the first query — it
takes ~1.5s, and making the first visitor of a cold instance pay for it was most of why
the app felt slow after a restart — and deliberately *after* the snapshot-parse garbage
has been collected, so the two peaks do not stack.

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

## 50 Percent Rule (derivative blocking)

`lib/ownership.js`, `GET /api/ownership?id=`, plus a panel on every hit whose ownership
chain reaches a blocked person.

- **Walks the chain, not just the parent.** The rule reaches entities owned 50%+
  *indirectly*, so ownership edges are traversed breadth-first (cycle-guarded, depth
  capped at 6) rather than checked one hop deep. In the current snapshot 4,860 parties
  have a blocked owner somewhere above them and **661 of those are reachable only
  through a multi-hop chain** — invisible to a direct-parent check.
- **Counts distinct blocked owners**, because the rule aggregates. 808 parties have more
  than one, and those are flagged `aggregationCandidate`: the threshold can be met by
  combined stakes even where no single owner reaches 50%. This is the limb screening
  systems most often miss.
- **Only full blocking propagates.** A CMIC, SSI, CAPTA or NS-PLC listing imposes a
  narrower prohibition and does not seed a derivative chain, so it never does.
- **Control is tracked separately** from ownership. Control alone does not trigger
  derivative blocking; it is reported in its own field as a risk factor rather than
  blended into the chain.
- **It does not invent percentages.** OFAC's list service publishes *no* ownership
  percentages — zero occurrences across the ~108MB SDN feed — so the 50% threshold
  **cannot be computed from list data**, and the tool says so on every panel and in every
  export. What it produces is the step before the arithmetic: the chain, the owner count,
  and a prompt to confirm actual stakes against corporate-registry or KYC records.
  Absence of a chain is likewise not a clearance — OFAC lists only designated parties, so
  an unlisted intermediate owner never appears.

## Ranking, near-misses and ownership groups

**Ties are disclosed, not faked.** A single-token query is capped at exactly 0.96 by the
scorer, so `Putin` returns 16 hits of which 15 share that one score — every one a
three-token name matching on one token. Only one tiebreak is real evidence (a hit on the
party's own primary name beats a hit on an alias); beyond that the remaining differences
are 21 characters versus 29 and a patronymic spelled -itj rather than -ich, which are not
relevance. Sorting on them would manufacture a ranking the reader believes, so the order
falls back to id — stable and reproducible — and the UI says outright that the leaders are
indistinguishable and points at the date of birth, nationality and corroborating-identifier
inputs that do separate them.

**A zero result now shows its evidence.** `Gasprom` — one character off one of the most
sanctioned names in the world — returned nothing, while the server already knew 5 parties
scored ≥0.88 and 80 ≥0.80. That screen is the one users most readily read as "clean", so
the below-the-line scan now runs *automatically* when a search returns no hits, and reports
three things from the single pass:

- **near-misses** — everything scoring between 0.80 and the active threshold;
- **prefix matches** — a literal "starts with" test, because the matcher has no prefix
  channel and `Gazpr` therefore scores nothing against GAZPROM. Deliberately outside the
  score, so it cannot disturb the threshold or the candidate index's recall invariant;
- **identifier context** — if the query reads as an IMO, MMSI or wallet address, how many
  parties in the snapshot carry that identifier at all. An IMO search returning nothing
  means something very different when 41 of 31,954 parties have an IMO, and the user
  cannot tell without being told.

**Results group by ownership structure.** `Gazprom` returns 67 hits; the count alone will
not say whether that is 67 companies or one group. Connected components over ownership
edges (`lib/ownership.clusters`, ~70ms over the snapshot) collapse them to 6 — 42 under
PJSC Gazprom. Components are undirected on purpose: direction answers "who owns whom",
but the question here is only "same structure", and siblings sharing a parent belong
together. Each heading also says how many group members the query did *not* match, which
is the 50 Percent Rule question in another form.

## What changed (snapshot delta)

`cache/changes.json`, `GET /api/changes`, page at `/changes.html`.

`scripts/build-cache.js` already reads the snapshot it is about to replace (for the
coverage baseline), so it diffs the two and writes the added/removed parties beside the
new snapshot. Both files are committed together.

The delta is computed **at build time on purpose**. "Designated since date X" can be read
off a single snapshot, but a **delisting leaves no trace in it** — the party is simply
gone — and a delisting is the event that lets a firm release blocked funds. A view that
could only ever show additions would be telling half the story, and the missing half is
the one with money attached.

- Added parties link to their record; removed ones do not, because their permalink would
  404 — the page says so rather than offering a dead link.
- A removal is **not self-executing**: the page says to confirm the delisting with the
  issuing authority before releasing anything.
- If an authority drops out of the snapshot entirely its parties appear as a mass
  removal. The coverage banner is what distinguishes that from a real delisting.

## Threshold testing (below the line)

`GET /api/below-the-line?q=&threshold=`, panel on the search page.

This README told analysts that below-the-line testing was required before any threshold
change, and the app gave them no way to do it. One full scan at the slider floor returns
the hit count at every 0.01 step **and the actual records** scoring between the floor and
the active threshold — because a count tells you the cost of widening, but only the
records tell you whether what you are excluding is a namesake or your counterparty.

Opt-in: it cannot use the recall-safe candidate index (that invariant only holds at
≥0.95), so the default search stays on the fast path.

## Record permalinks

`GET /api/entity?id=`, page at `/entity.html?id=`.

A search URL is not a citation — it re-runs the matcher, so it resolves differently as
the snapshot moves or the threshold changes, and it can never point at one party
unambiguously. Records are addressed by the authority's own entity id. Related-party ids
inside a record link through to their own pages, so an ownership chain can be walked by
clicking. The record body is rendered by `public/record.js`, shared with the search
results, so the two views cannot give different compliance guidance for the same party.

## Relationship network (ego graph)

Any hit with relationships shows a **View network** button that opens a radial ego-graph
(`lib/graph.js` + `public/graph.js`, `GET /api/graph/ego-network?id=&depth=`):

- **Local network only** — BFS around the center entity, default depth 2 (max 3), never
  the full graph. Center in the middle, 1-hop in ring one, 2-hop in ring two.
- **Direction + type + ownership preserved.** 50%+ ownership edges are drawn red and
  thick; the panel flags them because they drive the 50 Percent Rule. External/unlisted
  related parties appear as dashed nodes (an unlisted 50%+ owner still blocks its chain).
- **Two views of the same ego-network.** *Radial* rings every relationship by hop
  distance. *Hierarchy* stacks them — **principals above, subordinates below** — so a
  chain reads top-down: ownership chains, but equally the support chain
  `TURKMEN → TALIB → AL QA'IDA`, which contains no ownership edge at all. The ring
  cannot show either: fifty subsidiaries of one bank land as fifty equidistant dots.
- **Direction is resolved per relationship type** (`lib/graph.relationDirection`), not
  inferred from the picture. OFAC phrases a relationship outward from the listed party —
  *"Providing support **to**"*, *"Acting for or on behalf **of**"*, *"Owned or Controlled
  **By**"* — so the named party is the principal and goes above; the exceptions are the
  types phrased the other way (*"Owns, controls, or operates"* → below) and the symmetric
  ones (family, association → level). Node position shows who is superior; the **arrow
  points at the target of the stated relationship**, which is not always downward — a
  support link drawn downward would claim the principal supports its subordinate.
- **Ownership stays distinct** — solid red, its own legend entry, and a side-panel line
  saying how many of the links on screen it covers — because only ownership drives the
  50 Percent Rule. Beneficial interest is dashed amber, support/agency/office dashed
  grey, family/association dotted and level.
- **Explainable metrics** — degree + weighted degree (ownership weighted double), top-5
  ranked in the side panel. Deterministic layout (sorted by name), hover for detail,
  click a node to recenter.
- **Hybrid rendering** — Canvas 2D for small/medium graphs (curved edges, direction
  arrows, shadows, haloed labels); **WebGL** geometry (GL points + lines) for large
  graphs (> 140 nodes) with a 2D overlay for hop guides, culled labels and tooltip, so
  a 300-node live ego-network stays smooth. A badge shows the active renderer + counts.
- **Audit line** — center, depth, node/edge counts, ownership-edge count, timestamp.
- Framed as a **triage/display aid, not a suspicious-activity or blocking determination.**

## List insights page

`/insights.html` (`lib/stats.js` + `public/insights.js`, `GET /api/stats`) summarizes the
snapshot you are actually screening against:

- **Headline figures** — parties, authorities, and how many were designated in the last
  30 / 90 / 365 days.
- **Composition** — counts by issuing authority, list, party type and *operative
  restriction* (block vs asset freeze vs export licence requirement), plus top programs
  and top countries.
- **Designation timeline** — per year (16 years) and per month (24 months), from the
  designation date each authority publishes. Dates are normalized across authorities
  (OFAC/EU/UN/BIS ISO, UK OFSI `DD/MM/YYYY`), country labels too (`lib/countries.js`),
  so one jurisdiction is not split across four rows.
- **Most recent designations** — the newest parties across all lists *plus* each
  authority's own newest, filterable by authority, party type and free text, each linking
  straight into a screening query.

Statistics come from the same immutable snapshot as `/api/search`, and are memoized per
snapshot (a full pass is ~150ms over 38k entities, recomputed only after a refresh).

## Data

- Ships with **fictional demo data** (`sample-data/sample.json`) so the UI runs offline
  with every field type populated. The header shows an amber **DEMO** dot.
- Live snapshots merge **OFAC + EU + UN + UK + BIS/State** (~38k parties). A green **LIVE** dot shows
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
| `server.js` | HTTP server, static hosting, `/api/search`, `/api/entity`, `/api/changes`, `/api/below-the-line`, `/api/ownership`, `/api/meta`, `/api/stats`, `/api/refresh` |
| `lib/ingest.js` | SLS fetch, CSV parse, snapshot build, poison-pill + authority-coverage guards |
| `lib/fetch.js` | Redirect-following, retrying HTTPS GET (TLS verification never bypassed) |
| `lib/matcher.js` | Script-aware normalization + fuzzy scoring + match classification |
| `lib/searchindex.js` | Candidate prefilter (trigram / bigram / acronym / identifier lanes) |
| `lib/ownership.js` | 50% Rule: ownership chains to a blocked person, and the aggregate-test flag |
| `lib/stats.js` | Snapshot analytics: composition, timeline, recent designations |
| `lib/countries.js` | Cross-authority country normalization (ISO codes, sovereign map, free-text jurisdictions) |
| `lib/vocab.js` | Canonical `kind` for every attribute label and identifier type |
| `lib/dates.js` | Birth dates parsed into comparable intervals with their stated precision |
| `lib/quality.js` | Field-level quality profile and the gate that blocks a build which emptied one |
| `scripts/quality-report.js` | Prints that profile and the gate verdict without a rebuild |
| `scripts/verify-recall.js` | Proves the prefilter returns what a full scan would, non-Latin scripts included |
| `cache/changes.json` | What the last rebuild added and removed; written beside the snapshot |
| `cache/quality.json` | Field fill rates the last published build measured; the next build's baseline |
| `public/record.js` | How a listed party renders — shared by the results and the permalink page so they cannot disagree |
| `public/chrome.js` | Shared chrome: missing-authority banner, keyboard shortcuts |
| `public/entity.html` · `entity.js` | Permalink page for one record |
| `public/changes.html` · `changes.js` | What changed between snapshot builds |
| `public/fonts/` | Self-hosted IBM Plex (SIL OFL 1.1) — no third-party font requests |
| `public/` | Frontend (HTML / CSS / JS) |
| `ios/` | Native SwiftUI iPhone app; screens on-device via `ios/SanctinelCore`, a Swift port of `lib/` |
| `scripts/gen-conformance-fixtures.js` | Freezes the JS scorer's output so the Swift port can be proved identical |
| `sample-data/` | Fictional offline demo dataset |
