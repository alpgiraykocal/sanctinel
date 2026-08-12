# Sanctinel for iPhone

A native SwiftUI screening tool that runs **entirely on the device**. Searching,
the full record, the ownership network and the statistics are all computed
locally against a list stored on the phone, so the app works with no network at
all and a query is never transmitted anywhere.

The only network request it makes is downloading the list itself.

- **Target:** iOS 17.0+, iPhone and iPad
- **Dependencies:** none — SwiftUI, Foundation, Compression, BackgroundTasks
- **Data source:** `cache/snapshot.json.gz`, rebuilt nightly by
  [refresh-data.yml](../.github/workflows/refresh-data.yml) and served from
  `raw.githubusercontent.com`. No server of ours has to be running.

## Build and run

```bash
open ios/Sanctinel.xcodeproj
```

Pick an iPhone simulator and press ⌘R. From the command line:

```bash
xcodebuild -project ios/Sanctinel.xcodeproj -scheme Sanctinel -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Building needs the iOS platform installed for your Xcode version
(Xcode ▸ Settings ▸ Components, or `xcodebuild -downloadPlatform iOS`). To run on
your own iPhone, set a team under Signing & Capabilities and change
`PRODUCT_BUNDLE_IDENTIFIER` from `com.sanctinel.ios` to a namespace you own.

## How it works

```
raw.githubusercontent.com/…/cache/snapshot.json.gz   (5.4 MB, rebuilt nightly)
        │  conditional GET on the stored ETag — unchanged costs a 304, no body
        ▼
   SnapshotStore.importSnapshot
        │  inflate → parse → build search corpus, candidate index, statistics
        ▼
   Application Support/Snapshot/
        corpus.bin   9.7 MB   search fields + pre-computed tokens
        index.bin     11 MB   CSR posting lists (trigram / bigram / acronym / id)
        records.bin   50 MB   full records, offset-indexed, read on demand
        stats.json    94 KB   Insights, computed once at import
        manifest.json          provenance + ETag
        │
        ▼
   ScreeningEngine · RelationshipGraph · SnapshotStats     ← every screen
```

First launch imports the copy of the list shipped inside the app, so the phone
can screen before it has ever reached the network. Every launch after that reads
the archives back and is ready immediately; the import only reruns when a new
list is downloaded.

## The conformance requirement

`SanctinelCore` is a line-by-line Swift port of `lib/matcher.js`,
`lib/searchindex.js`, `lib/graph.js`, `lib/stats.js` and `lib/countries.js`. Two
scorers that drift apart is the failure mode that matters here: the phone would
clear a party the web app flags, silently, at the fourth decimal.

So the JavaScript is the reference and the port is tested against it:

```bash
node scripts/gen-conformance-fixtures.js   # freeze the JS output
cd ios/SanctinelCore && swift test         # prove Swift reproduces it
```

| Test | What it proves |
| --- | --- |
| `ConformanceTests.testPrimitives` | normalize, tokens, idKey, metaphone, foldTranslit, Jaro-Winkler, Damerau, Dice, Jaccard, tokenSim all match |
| `ConformanceTests.testScreeningMatchesJavaScript` | 4,909 (query × record) cases match on score, matchType, matchedName, matchedField, explain and both modifier flags |
| `SnapshotTests.testEndToEndSearchMatchesJavaScript` | 21 queries over the full 38k snapshot produce the same ranked list, hit count and truncation flag |
| `SnapshotTests.testFastPathMatchesFullScan` | the recall invariant: the candidate index surfaces everything a full scan would |
| `GraphStatsTests` | ego networks and every statistic match the JS |
| `StoreTests.testRoundTripPreservesScreening` | a reloaded archive screens identically to a freshly built one |

[ios-conformance.yml](../.github/workflows/ios-conformance.yml) regenerates the
fixtures on every change to `lib/`, `data/` or `ios/` and **fails if they moved**
— a change to the JS scorer that was not mirrored into Swift breaks the build
rather than shipping a divergence.

Two deliberate quirks are reproduced rather than tidied, and are commented where
they live: JavaScript's `'AEIOU'.includes('')` being `true` (which is why HIGH
keys to "HK"), and homoglyph folding running over UTF-16 code units rather than
grapheme clusters (which is why a Cyrillic letter carrying a combining accent
still folds).

## Staying current

- **Conditional GET.** The stored ETag is sent as `If-None-Match`; an unchanged
  list costs a 304 with no body, so a daily check is nearly free.
- **Background refresh.** A `BGAppRefreshTask` is scheduled every 12h. iOS
  decides when these actually run, so it is a best-effort top-up.
- **Foreground catch-up.** Opening the app checks the list if the stored one has
  had time to age. This is what actually guarantees a check happens.
- **Staleness is enforced, not just displayed.** Past 7 days the list is treated
  as stale and every screen says so, with the age measured from the authority's
  publication date rather than the download. A list that silently ages is worse
  than one that is visibly missing: the analyst gets the same confident-looking
  hits from a list that no longer matches what the authority published.
- **A failed update never removes the working list**, and a snapshot that parsed
  almost nothing is refused outright (the same poison-pill floor `lib/ingest.js`
  applies) — a clean run with zero hits is the worst screening failure there is.

## Screens

| Screen | What it does |
| --- | --- |
| **Screen** | Debounced local search, with the screen given over to results. Every query control — threshold, authority/list/program, the year-of-birth and country corroborators — lives in one Query sheet; anything non-default is reported back in the results header as a tappable chip, so a widened threshold is never invisible. The header also breaks the hits down the way an analyst triages them (identifier / exact / strong / fuzzy / weak) and carries a one-line disclaimer that expands on tap. Each row: score, the scorer's own strength label, authority as a colour bar, what matched if it was not the primary name, and a 50% Rule flag. |
| **Detail** | The full listed record, read from the on-device blob: every alias with its native script and low-quality flag, identifiers, identity documents, addresses, grouped attributes, listed relationships, measures and legal authorities. |
| **Ownership** | Answers the directional question first: how many parties own or control this one, how many it owns, and what the 50 Percent Rule makes of that. Parties are split into "Owned or controlled by", "Owns or controls", other listed ties, and further out — every row opening its record. Where the relationship wording comes from the counterparty's listing it is prefixed "their listing:", so a subsidiary's "Owned or Controlled By" never reads as a contradiction under a heading that says "Owns or controls". The concentric-ring diagram sits below that for shape and hub detection, with 1–3 hop depth and an ownership-only filter that hides the parties it orphans. |
| **Insights** | An overview that fits a phone: how big the list is and how it splits across authorities, what has been designated in the last 30/90/365 days, designations by year, and the five newest listings. Everything else is one tap away — **Composition** (lists, party types, measures, programs, countries, structural counts, each showing five rows with "show all") and **Recent designations** (the full feed with an authority filter). Every designation opens its record. |
| **List** | Answers "can I rely on what I just searched?" first, in colour: current or out of date, with the age measured from the authority's publication date, record count, disk use and the update button. Below it: how the list stays current (and honestly, which mechanism actually fires) with the last-checked time, collapsed provenance for citing an alert later, what does and does not leave the device, direct links to each issuing authority's own list, and the rebuild-from-bundled escape hatch. |

## Layout

```
ios/
  Sanctinel.xcodeproj/          file-system synchronized — new .swift files are picked up automatically
  Sanctinel/
    SanctinelApp.swift          entry point, background-task registration
    SnapshotService.swift       owns the device's list: import, load, refresh, staleness
    AppState.swift              SearchModel, RecentStore
    Models.swift                the full record, decoded for the detail screen only
    Theme.swift                 the web app's design tokens, ported
    Resources/
      seed-snapshot.json.gz     the list shipped with the app, so first launch works offline
    Views/                      RootView, SearchView, EntityDetailView, NetworkView, InsightsView, SettingsView, Components
  SanctinelCore/                Foundation-only engine + its conformance tests
    Sources/SanctinelCore/
      Text.swift                normalize, tokenize, intern
      Similarity.swift          metaphone, transliteration fold, Jaro-Winkler, Damerau, Dice, Jaccard
      Matcher.swift             IDF corpus, tokenSim, token-set score, modifiers, screenEntity
      SearchIndex.swift         CSR candidate index and the recall invariant
      Engine.swift              the search path, ported from server.js
      Graph.swift               ego network, ownership direction
      Stats.swift               snapshot analytics
      Countries.swift           cross-authority country normalization
      SnapshotLoader.swift      snapshot JSON → records + metadata, poison-pill guard
      Gzip.swift                gzip container + streaming inflate
      Archives.swift            on-disk corpus and index formats
      SnapshotStore.swift       import, atomic promotion, load, full-record reads
      SnapshotFetcher.swift     the one network call in the app
    Tests/SanctinelCoreTests/   conformance, end-to-end, recall, graph/stats, storage
```

## Known differences from the web app

- The Insights timeline shows designations **by year**; the web page also has a
  per-month, per-authority stacked chart, which does not fit a phone and was
  never in this app.
- Tie ordering in a few display lists (equal-count buckets, equal-date recent
  designations) uses a pinned `en_US` collation so it is identical on every
  device. The web app uses the browser's locale, so a non-English browser can
  order ties differently. Counts and membership are identical.
