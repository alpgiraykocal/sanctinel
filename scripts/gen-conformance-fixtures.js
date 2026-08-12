'use strict';

/*
 * Generates the fixtures ios/SanctinelCore's tests assert against.
 *
 * The iPhone app scores on-device with a Swift port of lib/matcher.js and
 * lib/searchindex.js. Two scorers that drift apart is the failure this guards:
 * the phone would clear a party the web flags, silently, at the fifth decimal.
 * So the JavaScript implementation is the reference, its outputs are frozen
 * here, and the Swift port has to reproduce them exactly.
 *
 *   node scripts/gen-conformance-fixtures.js
 *
 * Re-run whenever lib/matcher.js, lib/searchindex.js or data/matching.json
 * changes, and commit the result alongside that change.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const matcher = require('../lib/matcher');
const searchindex = require('../lib/searchindex');
const graph = require('../lib/graph');
const stats = require('../lib/stats');
const vocab = require('../lib/vocab');
const dates = require('../lib/dates');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ios/SanctinelCore/Tests/SanctinelCoreTests/Fixtures');
const SNAPSHOT = path.join(ROOT, 'cache/snapshot.json.gz');

// Deterministic PRNG so a regenerated fixture diffs only where behaviour moved.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Queries chosen to exercise every scoring channel, not just the happy path:
// exact, alias, typo, transliteration, homoglyph, acronym, identifier, the weak
// single-token damping, and the corroboration modifiers.
const QUERIES = [
  { q: 'ivanov' },
  { q: 'IVANOV, Dmitri Sergeyevich' },
  { q: 'ivanof dmitry' },
  { q: 'rosneft' },
  { q: 'rosneft trading' },
  { q: 'sberbank' },
  { q: 'gazprom neft' },
  { q: 'mohammed' },
  { q: 'ali' },
  { q: 'abdul aziz' },
  { q: 'yousef' },
  { q: 'yusuf al masri' },
  { q: 'muhammed hassan' },
  { q: 'schmidt' },
  { q: 'smyth' },
  { q: 'CCC' },
  { q: 'CML' },
  { q: 'kim jong' },
  { q: 'islamic revolutionary guard' },
  { q: 'maritime logistics' },
  { q: 'soe win' },
  { q: 'ghsair' },
  { q: 'huawei technologies' },
  { q: 'wagner' },
  { q: 'bank melli iran' },
  { q: 'сompany' },                       // leading Cyrillic С homoglyph
  { q: 'petroleos de venezuela' },
  { q: 'ivanov', mods: { yob: '1968', country: '' } },
  { q: 'ivanov', mods: { yob: '1900', country: '' } },
  { q: 'ivanov', mods: { yob: '', country: 'Russia' } },
  { q: 'ivanov', mods: { yob: '', country: 'Iran' } },
  { q: 'petrov', mods: { yob: '1970', country: 'Russian Federation' } },
  // One jurisdiction written the way each authority writes it. These must all
  // reach the same verdict — before country codes, "North Korea" against a party
  // published as "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" scored as a conflict.
  { q: 'kim', mods: { yob: '', country: 'North Korea' } },
  { q: 'kim', mods: { yob: '', country: 'Korea, North' } },
  { q: 'kim', mods: { yob: '', country: 'DPRK' } },
  { q: 'kim', mods: { yob: '', country: "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" } },
  { q: 'kim', mods: { yob: '', country: 'South Korea' } },
  { q: 'bank melli iran', mods: { yob: '', country: 'IRAN (ISLAMIC REPUBLIC OF)' } },
  // Sovereign expansion: a Hong Kong party is not a contradiction of "China".
  { q: 'trading', mods: { yob: '', country: 'Hong Kong' } },
  { q: 'trading', mods: { yob: '', country: 'China' } },
  // Neither side resolves to a code — the string fallback still has to run.
  { q: 'ivanov', mods: { yob: '', country: 'Transnistria' } },
];

// Token pairs for the primitives, covering the channel boundaries the scorer
// gates on (0.5 fast path, 0.6 translit gate, 0.62 phonetic gate).
const TOKEN_PAIRS = [
  ['IVANOV', 'IVANOV'], ['IVANOV', 'IVANOFF'], ['IVANOV', 'IVANOVA'],
  ['MOHAMMED', 'MUHAMMAD'], ['MOHAMMED', 'MEHMET'], ['SMITH', 'SMYTH'],
  ['PHILIP', 'FILIP'], ['YOUSEF', 'YUSUF'], ['SCHMIDT', 'SMIT'],
  ['MAERSK', 'MASHREK'], ['HUAWEI', 'HUWAYZEH'], ['GHSAIR', 'GHASIR'],
  ['KMK', 'MKM'], ['D', 'DMITRI'], ['DMITRI', 'D'], ['A', 'B'],
  ['ROSNEFT', 'ROSNEFT'], ['ROSNEFT', 'ROSNEF'], ['ROSNEFT', 'TRANSNEFT'],
  ['BANK', 'BANCO'], ['SBERBANK', 'SBERBANKA'], ['ALI', 'ALY'],
  ['XI', 'SHI'], ['ACCESS', 'AXESS'], ['THOMAS', 'TOMAS'],
  ['0MEGA', 'OMEGA'], ['L1BERTY', 'LIBERTY'], ['', 'ANYTHING'],
  ['ZZZZZZ', 'AAAAAA'], ['CASPIAN', 'CASPIENNE'],
];

// End-to-end queries: run through the whole pipeline (prefilter included) and
// compared against the Swift engine's ranked output over the same snapshot.
const END_TO_END = [
  { q: 'ivanov' },
  { q: 'rosneft' },
  { q: 'sberbank' },
  { q: 'mohammed ali' },
  { q: 'kim jong un' },
  { q: 'gazprom' },
  { q: 'wagner group' },
  { q: 'huawei' },
  { q: 'CCC' },
  { q: 'ghsair' },
  { q: 'soe win' },
  { q: 'petroleos de venezuela' },
  { q: 'yusuf' },
  { q: 'schmidt', threshold: 0.9 },
  { q: 'ivanov', threshold: 0.85 },
  { q: 'ivanov', authority: 'OFAC' },
  { q: 'ivanov', list: 'SDN List' },
  { q: 'bank', program: 'IRAN' },
  { q: 'ivanov', mods: { yob: '1968', country: 'Russia' } },
  { q: '751234567' },
  { q: 'сompany' },
];

const RAW_STRINGS = [
  'IVANOV, Dmitri Sergeyevich',
  '  Mr.  José  Müller-Löwe ',
  'ОАО Роснефть',
  'сompany',                              // Cyrillic С
  'Al-Qaida (AQ)',
  'ПАО «Газпром нефть»',
  'Ünlü Şirket A.Ş.',
  'Nguyễn Văn Đức',
  'ABC 123-456/789',
  'Dr Prof Hans Zimmermann GmbH & Co. KG',
  '',
  'X',
  'ЖУКОВ',
  '株式会社トヨタ',
  'passport 751234567',
];

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(`Missing ${SNAPSHOT}. Run: node scripts/build-cache.js`);
    process.exit(1);
  }
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT)));
}

// The scorer's IDF weighting is corpus-wide, so it must be set from the whole
// snapshot exactly as lib/ingest.js does — a fixture built without it would
// freeze the wrong numbers.
function setCorpus(entities) {
  const df = new Map();
  for (const e of entities) {
    const seen = new Set();
    const names = (e.names && e.names.length) ? e.names : [{ name: e.name }];
    for (const n of names) for (const t of matcher.tokens(n.name || '')) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  matcher.setCorpus(df, entities.length);
  return df;
}

// Only what the scorer reads. Keeping the raw attributes and addresses (rather
// than the derived birth years and country tokens) means the Swift side derives
// them through its own code, so that derivation is under test too.
function slimRecord(e) {
  return {
    id: String(e.id),
    name: e.name || '',
    authority: e.authority || '',
    list: e.list || '',
    type: e.type || '',
    programs: e.programs || [],
    datePublished: e.datePublished || '',
    names: (e.names || []).map((n) => ({
      name: n.name || '', type: n.type || '', primary: !!n.primary, lowQuality: !!n.lowQuality,
    })),
    identifiers: (e.identifiers || []).map((i) => ({ type: i.type || '', value: String(i.value == null ? '' : i.value) })),
    attributes: (e.attributes || []).map((a) => ({ label: a.label || '', value: String(a.value == null ? '' : a.value) })),
    addresses: (e.addresses || []).map((a) => ({ country: a.country || '', full: a.full || '' })),
    relationships: (e.relationships || []).map(() => ({})),
  };
}

function main() {
  const snapshot = loadSnapshot();
  const entities = snapshot.entities;
  setCorpus(entities);
  const index = searchindex.build(entities);
  const rand = mulberry32(20260728);

  // --- record sample: every query's real candidates, plus a random baseline so
  // low-scoring and non-matching pairs are covered too.
  const chosen = new Map(); // entity index -> entity
  for (const { q } of QUERIES) {
    const cand = searchindex.candidates(index, q) || [];
    for (const i of cand.slice(0, 60)) chosen.set(i, entities[i]);
  }
  for (let k = 0; k < 400; k++) {
    const i = Math.floor(rand() * entities.length);
    chosen.set(i, entities[i]);
  }
  const sampleIndices = [...chosen.keys()].sort((a, b) => a - b);
  const records = sampleIndices.map((i) => slimRecord(entities[i]));
  const indexOfSample = new Map(sampleIndices.map((v, k) => [v, k]));

  // --- expected screening output for every (query, sampled record) pair.
  // Stratified: everything that scores, plus a slice of the rest, so the fixture
  // stays small without dropping the interesting end of the range.
  const SCORING_PER_QUERY = 120;   // pairs that actually score
  const LOW_PER_QUERY = 40;        // and a slice of the noise floor
  const cases = [];
  for (const spec of QUERIES) {
    const mods = spec.mods && (spec.mods.yob || spec.mods.country) ? spec.mods : null;
    let scoring = 0, low = 0;
    for (const gi of sampleIndices) {
      const result = matcher.screenEntity(spec.q, entities[gi], 0, mods);
      let keep = false;
      if (result && result.score >= 0.5) {
        keep = scoring < SCORING_PER_QUERY;
        if (keep) scoring++;
      } else if (low < LOW_PER_QUERY && rand() < 0.05) {
        keep = true;
        low++;
      }
      if (!keep) continue;
      cases.push({
        query: spec.q,
        yob: mods ? (mods.yob || '') : '',
        country: mods ? (mods.country || '') : '',
        record: indexOfSample.get(gi),
        result: result ? {
          score: result.score,
          matchType: result.matchType,
          matchedName: result.matchedName,
          matchedField: result.matchedField,
          explain: result.explain || '',
          corroborated: !!result.corroborated,
          conflict: !!result.conflict,
        } : null,
      });
    }
  }

  // Only ship records a case actually references — the sample is drawn wide so
  // the candidate pools are realistic, but most of it never gets asserted on.
  const usedSampleIndices = [...new Set(cases.map((c) => c.record))].sort((a, b) => a - b);
  const remap = new Map(usedSampleIndices.map((v, k) => [v, k]));
  const usedRecords = usedSampleIndices.map((i) => records[i]);
  for (const c of cases) c.record = remap.get(c.record);

  // --- IDF inputs. tokenSetScore only ever calls idf() on QUERY tokens, so the
  // fixture needs document frequencies for those and nothing else.
  const dfNeeded = {};
  for (const { q } of QUERIES) {
    for (const t of matcher.tokens(q)) {
      if (dfNeeded[t] === undefined) {
        // Recompute from the corpus via idf(): df = (N+1)/exp(idf-1) - 1.
        dfNeeded[t] = Math.round((entities.length + 1) / Math.exp(matcher.idf(t) - 1) - 1);
      }
    }
  }

  /*
   * Vocabulary and date parity, over the REAL inventory rather than a sample.
   *
   * Every distinct attribute label and identifier type in the snapshot, and
   * every distinct birth-date value, goes in. That is what makes the Swift port
   * checkable instead of assumed: these two derivations decide which attribute
   * is a birth date and which year corroborates a hit, so a port that quietly
   * disagrees would move scores on the phone and nowhere else.
   */
  const attributeLabels = [...new Set(entities.flatMap((e) => (e.attributes || []).map((a) => a.label)))].sort();
  const identifierTypes = [...new Set(entities.flatMap((e) => (e.identifiers || []).map((i) => i.type)))].sort();
  const dateValues = [...new Set(entities.flatMap((e) =>
    (e.attributes || []).filter((a) => vocab.attributeKind(a.label) === 'dob').map((a) => a.value)))].sort();
  const vocabulary = {
    attributeKind: attributeLabels.map((label) => ({ input: label, output: vocab.attributeKind(label) })),
    identifierKind: identifierTypes.map((type) => ({ input: type, output: vocab.identifierKind(type) })),
    dates: dateValues.map((value) => ({ input: value, output: dates.parseDateValue(value) })),
  };

  const primitives = {
    vocabulary,
    normalize: RAW_STRINGS.map((s) => ({ input: s, output: matcher.normalize(s) })),
    tokens: RAW_STRINGS.map((s) => ({ input: s, output: matcher.tokens(s) })),
    idKey: RAW_STRINGS.map((s) => ({ input: s, output: matcher.idKey(s) })),
    metaphone: TOKEN_PAIRS.flatMap(([a, b]) => [a, b]).filter((v, i, a) => a.indexOf(v) === i)
      .map((s) => ({ input: s, output: matcher.metaphone(s) })),
    foldTranslit: TOKEN_PAIRS.flatMap(([a, b]) => [a, b]).filter((v, i, a) => a.indexOf(v) === i)
      .map((s) => ({ input: s, output: matcher.foldTranslit(s) })),
    pairs: TOKEN_PAIRS.map(([a, b]) => ({
      a, b,
      jaroWinkler: matcher.jaroWinkler(a, b),
      editSim: matcher.editSim(a, b),
      dice: matcher.dice(a, b),
      jaccard3: matcher.jaccard3(a, b),
      tokenSim: matcher.tokenSim(a, b),
      sharesFoldedGram: matcher.sharesFoldedGram(matcher.foldTranslit(a), matcher.foldTranslit(b)),
    })),
  };

  // The Swift engine reads the same reference data the JS does, so keep the
  // package's copy in lockstep with data/matching.json rather than letting the
  // two drift into different strip lists.
  const resources = path.join(ROOT, 'ios/SanctinelCore/Sources/SanctinelCore/Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data/matching.json'), path.join(resources, 'matching.json'));
  console.log('synced ios/SanctinelCore/Sources/SanctinelCore/Resources/matching.json');

  // --- end-to-end: the ranked result list server.js would return. This is what
  // catches an index that quietly drops a hit, since the Swift side runs the
  // same queries over the same full snapshot through its own prefilter.
  const searchCases = END_TO_END.map((spec) => {
    const threshold = spec.threshold === undefined ? 0.95 : spec.threshold;
    const mods = spec.mods && (spec.mods.yob || spec.mods.country) ? spec.mods : null;
    const cand = threshold >= 0.95 ? searchindex.candidates(index, spec.q) : null;
    const pool = cand ? cand.map((i) => entities[i]) : entities;
    const results = [];
    for (const e of pool) {
      if (spec.authority && e.authority !== spec.authority) continue;
      if (spec.list && e.list !== spec.list) continue;
      if (spec.program && !e.programs.includes(spec.program)) continue;
      const m = matcher.screenEntity(spec.q, e, threshold, mods);
      if (!m) continue;
      results.push({ id: String(e.id), score: m.score, matchType: m.matchType });
    }
    results.sort((a, b) => b.score - a.score);
    return {
      query: spec.q,
      threshold,
      authority: spec.authority || '',
      list: spec.list || '',
      program: spec.program || '',
      yob: mods ? (mods.yob || '') : '',
      country: mods ? (mods.country || '') : '',
      count: results.length,
      truncated: results.length > 200,
      results: results.slice(0, 200),
    };
  });

  // --- ego networks. The graph is a display aid rather than a determination,
  // but a port that silently drops an ownership edge would understate 50%-Rule
  // exposure, so the node and edge sets are frozen too.
  const graphCentres = pickGraphCentres(entities);
  const graphCases = graphCentres.map((id) => {
    const g = graph.egoNetwork(entities, id, 2);
    return {
      center: id,
      depth: 2,
      nodes: g.nodes.map((n) => ({ id: n.id, hop: n.hop, inSnapshot: n.inSnapshot, degree: n.degree, weightedDegree: n.weightedDegree })),
      edges: g.edges.map((e) => ({ source: e.source, target: e.target, type: e.type, ownership: e.ownership, role: e.role, hier: e.hier })),
      nodeCount: g.metrics.nodeCount,
      edgeCount: g.metrics.edgeCount,
      ownershipEdges: g.metrics.ownershipEdges,
    };
  });

  // --- snapshot statistics. `now` is pinned so the added30/90/365 windows are
  // reproducible; the Swift side is handed the same instant.
  const NOW = Date.parse('2026-07-28T00:00:00Z');
  const realNow = Date.now;
  Date.now = () => NOW;
  const st = stats.snapshotStats({ entities, count: entities.length, source: '', publicationId: '', publishedDate: '', retrievedAt: '' });
  Date.now = realNow;
  const statsCase = {
    now: new Date(NOW).toISOString(),
    totals: st.totals,
    byAuthority: st.byAuthority,
    byList: st.byList,
    byType: st.byType,
    byMeasure: st.byMeasure,
    byProgram: st.byProgram,
    byCountry: st.byCountry,
    years: st.timeline.years,
    recent: st.recent.map((r) => ({ id: String(r.id), date: r.date, authority: r.authority, country: r.country, aliases: r.aliases, measures: r.measures })),
  };

  fs.mkdirSync(OUT, { recursive: true });
  write(path.join(OUT, 'graph.json'), { cases: graphCases });
  write(path.join(OUT, 'stats.json'), statsCase);
  write(path.join(OUT, 'search.json'), { cases: searchCases });
  write(path.join(OUT, 'primitives.json'), primitives);
  write(path.join(OUT, 'screening.json'), {
    generatedFrom: {
      publicationId: String((snapshot.meta && snapshot.meta.publicationId) || ''),
      entities: entities.length,
    },
    corpusCount: entities.length,
    documentFrequencies: dfNeeded,
    records: usedRecords,
    cases,
  });

  console.log(`primitives: ${primitives.pairs.length} pairs, ${primitives.normalize.length} strings`);
  console.log(`screening:  ${usedRecords.length} records, ${cases.length} cases`);
  console.log(`search:     ${searchCases.length} end-to-end queries`);
  console.log(`graph:      ${graphCases.length} ego networks`);
  console.log(`stats:      ${statsCase.recent.length} recent designations`);
}

// Centres worth freezing: the richest networks, plus one with an unlisted
// related party so the synthetic-node path is covered.
function pickGraphCentres(entities) {
  const scored = entities
    .filter((e) => (e.relationships || []).length)
    .map((e) => ({ id: String(e.id), n: e.relationships.length, external: e.relationships.some((r) => !r.relatedId) }));
  scored.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const out = scored.slice(0, 6).map((s) => s.id);
  const external = scored.find((s) => s.external);
  if (external && !out.includes(external.id)) out.push(external.id);
  return out;
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`wrote ${path.relative(ROOT, file)} (${kb} KB)`);
}

main();
