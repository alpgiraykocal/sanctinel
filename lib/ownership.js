'use strict';

/*
 * Derivative blocking — OFAC's 50 Percent Rule.
 *
 * The rule: an entity owned 50 percent or more, directly or indirectly,
 * individually or IN THE AGGREGATE, by one or more blocked persons is itself
 * blocked, whether or not it appears on any list. Two parts of that sentence are
 * what screening systems usually miss — "indirectly", which requires walking the
 * chain rather than checking direct parents, and "in the aggregate", which
 * requires summing across several blocked owners instead of testing each alone.
 *
 * WHAT THIS MODULE CANNOT DO, AND WHY IT SAYS SO LOUDLY.
 *
 * OFAC's Sanctions List Service publishes no ownership percentages at all —
 * literally zero occurrences of a percentage across the ~108MB SDN entity feed.
 * The relationship vocabulary is qualitative ("Owned or Controlled By",
 * "Property in the interest of"). So the 50 percent threshold CANNOT be computed
 * from this data, and any number claiming to be an aggregate ownership stake
 * derived from it would be invented.
 *
 * What the data does support, and what this module therefore produces, is the
 * step before the arithmetic: identify the parties whose ownership chain reaches
 * a blocked person, show the chain, and count how many distinct blocked owners
 * sit above them — the aggregation dimension. That is a lead requiring corporate
 * registry evidence to resolve, and it is labelled as one.
 *
 * Control without ownership is tracked separately. Control alone does not
 * trigger derivative blocking, but OFAC has told firms to weigh it as risk, so
 * it is reported in its own field rather than blended into the ownership chain.
 */

const { ownershipRole } = require('./graph');

// A party whose own listing imposes full blocking. Non-SDN listings (CMIC,
// SSI, CAPTA, NS-PLC) impose narrower prohibitions and do NOT propagate under
// the 50 Percent Rule, so they must not seed a derivative-blocking chain.
function isBlockingListed(e) {
  if (!e) return false;
  const lists = (e.lists && e.lists.length) ? e.lists : [e.list].filter(Boolean);
  if (lists.includes('SDN List')) return true;
  return (e.sanctionsTypes || []).some((t) => /^block$/i.test(String(t)));
}

const CONTROL_RE = /control|acting for|on behalf of|leader|official of|director|manag/i;

/*
 * Index the ownership graph once per snapshot.
 *
 *   owners.get(id)  → ids that OWN id   (walk these upward to find blocked owners)
 *   owned.get(id)   → ids that id OWNS  (its subsidiaries)
 *   controllers     → control-only links, kept apart from ownership
 *
 * Edge direction comes from graph.ownershipRole, which already resolves OFAC's
 * inconsistent phrasing ("Owned or Controlled By" vs "Owns, controls, or
 * operates"). Getting that backwards would invert every chain and point the
 * analyst at the wrong party.
 */
function buildIndex(entities) {
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  const owners = new Map();
  const owned = new Map();
  const controllers = new Map();
  const nameOf = new Map();

  const add = (map, k, v) => { const a = map.get(k); if (a) { if (!a.includes(v)) a.push(v); } else map.set(k, [v]); };

  for (const e of entities) {
    const from = String(e.id);
    for (const rel of e.relationships || []) {
      const to = rel.relatedId ? String(rel.relatedId) : '';
      if (!to) continue;
      if (rel.relatedName && !nameOf.has(to)) nameOf.set(to, rel.relatedName);
      const role = ownershipRole(rel.type);
      if (role === 'owned_by') { add(owners, from, to); add(owned, to, from); }
      else if (role === 'owns') { add(owners, to, from); add(owned, from, to); }
      else if (CONTROL_RE.test(String(rel.type || ''))) { add(controllers, from, to); }
    }
  }
  return { byId, owners, owned, controllers, nameOf };
}

let indexFor = null, indexCache = null;
function indexOf(entities) {
  if (indexFor !== entities) { indexCache = buildIndex(entities); indexFor = entities; }
  return indexCache;
}

const MAX_DEPTH = 6;

/*
 * Walk upward from `id` collecting every blocked owner reachable through
 * ownership edges, with the path that got there.
 *
 * Breadth-first with a visited set: OFAC's data contains reciprocal edges and
 * genuine ownership cycles (cross-holdings), and an unguarded walk would not
 * terminate. Depth is capped because a chain longer than a handful of hops is
 * evidentially worthless without registry data behind it.
 */
function blockedOwnersOf(idx, id) {
  const start = String(id);
  const seen = new Set([start]);
  const out = [];
  let frontier = [{ id: start, path: [] }];

  for (let hop = 1; hop <= MAX_DEPTH && frontier.length; hop++) {
    const next = [];
    for (const { id: cur, path } of frontier) {
      for (const owner of idx.owners.get(cur) || []) {
        if (seen.has(owner)) continue;
        seen.add(owner);
        const e = idx.byId.get(owner);
        const step = { id: owner, name: (e && e.name) || idx.nameOf.get(owner) || `Entity ${owner}`, inSnapshot: !!e };
        const nextPath = path.concat([step]);
        if (isBlockingListed(e)) {
          out.push({ id: owner, name: step.name, hops: hop, direct: hop === 1, path: nextPath });
        }
        next.push({ id: owner, path: nextPath });
      }
    }
    frontier = next;
  }
  return out;
}

/*
 * Derivative-blocking profile for one entity.
 *
 * `aggregationCandidate` is the flag that matters operationally: more than one
 * distinct blocked owner means the aggregate test could be met even where no
 * single owner reaches 50 percent — the case systems most often miss. It says
 * "go get the cap table", not "this is blocked".
 */
function profile(entities, id) {
  const idx = indexOf(entities);
  const key = String(id);
  const self = idx.byId.get(key);
  if (!self) return null;

  const blockedOwners = blockedOwnersOf(idx, key);
  const directBlocked = blockedOwners.filter((o) => o.direct);
  const subsidiaries = (idx.owned.get(key) || []).map((sid) => {
    const e = idx.byId.get(sid);
    return { id: sid, name: (e && e.name) || idx.nameOf.get(sid) || `Entity ${sid}`, inSnapshot: !!e, listed: isBlockingListed(e) };
  });
  const controlLinks = (idx.controllers.get(key) || []).map((cid) => {
    const e = idx.byId.get(cid);
    return { id: cid, name: (e && e.name) || idx.nameOf.get(cid) || `Entity ${cid}`, blocked: isBlockingListed(e) };
  });

  return {
    id: key,
    selfBlocked: isBlockingListed(self),
    blockedOwners,
    distinctBlockedOwners: blockedOwners.length,
    directBlockedOwners: directBlocked.length,
    indirectBlockedOwners: blockedOwners.length - directBlocked.length,
    aggregationCandidate: blockedOwners.length > 1,
    subsidiaries,
    controlOnlyLinks: controlLinks,
    // Stated on every profile, not buried in docs: the threshold is not
    // computable from this source, so the output is a lead, not a determination.
    percentagesAvailable: false,
    basis: 'OFAC SLS relationship edges (Owned or Controlled By / Owns). OFAC publishes no ownership percentages.',
    note: blockedOwners.length
      ? 'Ownership chain reaches a blocked person. The 50 Percent Rule threshold cannot be evaluated from OFAC list data alone — confirm the actual stakes, aggregated across all blocked owners, against corporate registry or KYC records before treating this party as blocked.'
      : 'No ownership chain to a blocked person in the list data. This does not clear the party: OFAC lists only designated parties, so an unlisted intermediate owner would not appear here.',
  };
}

// Compact form for search results — the flags a reviewer needs to see on the
// row, without the paths.
function summary(entities, id) {
  const p = profile(entities, id);
  if (!p || !p.blockedOwners.length) return null;
  return {
    distinctBlockedOwners: p.distinctBlockedOwners,
    directBlockedOwners: p.directBlockedOwners,
    aggregationCandidate: p.aggregationCandidate,
    topOwner: p.blockedOwners[0] ? { id: p.blockedOwners[0].id, name: p.blockedOwners[0].name, hops: p.blockedOwners[0].hops } : null,
    percentagesAvailable: false,
  };
}

module.exports = { profile, summary, buildIndex, isBlockingListed };
