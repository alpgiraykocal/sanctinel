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
const { index: crossIndex } = require('./crosslist');

// A party whose own listing imposes full blocking. Non-SDN listings (CMIC,
// SSI, CAPTA, NS-PLC) impose narrower prohibitions and do NOT propagate under
// the 50 Percent Rule, so they must not seed a derivative-blocking chain.
function isBlockingListed(e) {
  if (!e) return false;
  const lists = (e.lists && e.lists.length) ? e.lists : [e.list].filter(Boolean);
  if (lists.includes('SDN List')) return true;
  return (e.sanctionsTypes || []).some((t) => /^block$/i.test(String(t)));
}

/*
 * Is the PARTY blocking-listed — under any of its listings?
 *
 * The node in this graph is a party, and a party is blocked if any authority
 * blocked it. Asking only the canonical record would make the answer depend on
 * which listing happened to become the cluster root, so a company blocked by
 * OFAC would look unblocked whenever its EU listing won the tie.
 */
function nodeIsBlocking(idx, nodeId) {
  const group = idx.membersOf(nodeId);
  for (const memberId of group) if (isBlockingListed(idx.byId.get(memberId))) return true;
  return false;
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
/*
 * The graph is built over PARTIES, not over listings.
 *
 * Only OFAC publishes relationships — 9,143 edges, and zero from the EU, the UN
 * or the UK. So for the 12,385 parties whose only listing is non-OFAC this
 * module reported "no ownership chain to a blocked person", which reads exactly
 * like a clean result and was really an absence of data.
 *
 * Cross-authority resolution (lib/crosslist) already establishes which listings
 * are one party. Collapsing each cluster to a single node here means the EU
 * listing of a company sees the ownership OFAC published for that same company.
 * Nothing is invented: the edge is OFAC's, stated about a party the EU listed
 * under another name, and the identity between them is evidenced.
 *
 * It also lets a chain cross authorities — an EU-listed parent above an
 * OFAC-listed subsidiary is one chain, and neither list contains all of it.
 */
function buildIndex(entities) {
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  const owners = new Map();
  const owned = new Map();
  const controllers = new Map();
  const nameOf = new Map();

  const { rootOf } = crossIndex(entities);
  // A cluster's canonical node. Unclustered listings are their own node, so a
  // snapshot with no clustering behaves exactly as before.
  const canon = (id) => rootOf.get(String(id)) || String(id);

  const add = (map, k, v) => { const a = map.get(k); if (a) { if (!a.includes(v)) a.push(v); } else map.set(k, [v]); };

  for (const e of entities) {
    const from = canon(e.id);
    for (const rel of e.relationships || []) {
      if (!rel.relatedId) continue;
      const to = canon(rel.relatedId);
      if (to === from) continue;   // a listing pointing at its own other listing
      if (rel.relatedName && !nameOf.has(to)) nameOf.set(to, rel.relatedName);
      const role = ownershipRole(rel.type);
      if (role === 'owned_by') { add(owners, from, to); add(owned, to, from); }
      else if (role === 'owns') { add(owners, to, from); add(owned, from, to); }
      else if (CONTROL_RE.test(String(rel.type || ''))) { add(controllers, from, to); }
    }
  }
  const { groups } = crossIndex(entities);
  const membersOf = (nodeId) => {
    const group = groups.get(String(nodeId));
    return group ? group.ids : [String(nodeId)];
  };
  return { byId, owners, owned, controllers, nameOf, canon, rootOf, membersOf };
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
        if (nodeIsBlocking(idx, owner)) {
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
  // The graph is keyed by party. A question asked about one listing is answered
  // for the party it belongs to.
  const node = idx.canon(key);

  const blockedOwners = blockedOwnersOf(idx, node);
  const directBlocked = blockedOwners.filter((o) => o.direct);
  const subsidiaries = (idx.owned.get(node) || []).map((sid) => {
    const e = idx.byId.get(sid);
    return { id: sid, name: (e && e.name) || idx.nameOf.get(sid) || `Entity ${sid}`, inSnapshot: !!e, listed: nodeIsBlocking(idx, sid) };
  });
  const controlLinks = (idx.controllers.get(node) || []).map((cid) => {
    const e = idx.byId.get(cid);
    return { id: cid, name: (e && e.name) || idx.nameOf.get(cid) || `Entity ${cid}`, blocked: nodeIsBlocking(idx, cid) };
  });

  return {
    id: key,
    selfBlocked: nodeIsBlocking(idx, node),
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
    basis: node === key
      ? 'OFAC SLS relationship edges (Owned or Controlled By / Owns). OFAC publishes no ownership percentages.'
      : 'OFAC SLS relationship edges, reached through this party\'s other listings (see the cross-authority links on the record). OFAC publishes no ownership percentages.',
    note: blockedOwners.length
      ? 'Ownership chain reaches a blocked person. The 50 Percent Rule threshold cannot be evaluated from OFAC list data alone — confirm the actual stakes, aggregated across all blocked owners, against corporate registry or KYC records before treating this party as blocked.'
      : 'No ownership chain to a blocked person in the list data. This does not clear the party: OFAC lists only designated parties, so an unlisted intermediate owner would not appear here.',
  };
}

/*
 * Ownership clusters — connected components over ownership edges.
 *
 * A search for "Gazprom" returns 67 hits and the count alone will not say
 * whether that is 67 unrelated companies or one group's subsidiaries. Those are
 * different amounts of work: a group collapses to one decision about the
 * parent, while 67 unrelated parties are 67 decisions.
 *
 * Components are undirected on purpose. Direction matters when you are asking
 * "who owns whom" (that is what blockedOwnersOf does); here the question is
 * only "do these belong to the same structure", and a sibling pair sharing a
 * parent belongs together even though neither owns the other.
 *
 * The label is the member with the widest ownership reach — usually the group
 * parent, and never invented: it is always one of the parties in the cluster.
 */
let clusterFor = null, clusterCache = null;
function clusters(entities) {
  if (clusterFor === entities) return clusterCache;
  const idx = indexOf(entities);

  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };

  for (const e of entities) ensure(String(e.id));
  for (const [child, owners] of idx.owners) {
    ensure(child);
    for (const o of owners) { ensure(o); union(child, o); }
  }

  // Size and degree per component, so the label can be the best-connected member.
  const size = new Map();
  const members = new Map();
  for (const e of entities) {
    const root = find(String(e.id));
    size.set(root, (size.get(root) || 0) + 1);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(e);
  }

  const label = new Map();
  for (const [root, list] of members) {
    if (list.length < 2) continue;
    const reach = (e) => (idx.owned.get(String(e.id)) || []).length;
    label.set(root, list.slice().sort((a, b) => reach(b) - reach(a) || String(a.name).localeCompare(String(b.name)))[0]);
  }

  clusterCache = { rootOf: (id) => find(String(id)), size, label };
  clusterFor = entities;
  return clusterCache;
}

// Cluster summary for one party, or null when it stands alone — a cluster of
// one is not a group and labelling it as one would be noise.
function clusterOf(entities, id) {
  const c = clusters(entities);
  const root = c.rootOf(id);
  const n = c.size.get(root) || 1;
  if (n < 2) return null;
  const lead = c.label.get(root);
  return { id: root, size: n, label: lead ? lead.name : '', labelId: lead ? String(lead.id) : '' };
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

module.exports = { profile, summary, buildIndex, isBlockingListed, clusters, clusterOf };
