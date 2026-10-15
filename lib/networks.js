'use strict';

/*
 * The networks the published relationships draw.
 *
 * OFAC publishes ~9,400 links between listed parties: who owns whom, who acts
 * for whom, who supports, leads or is family of whom. lib/graph answers "what
 * is around this one party"; this module answers the question the other way
 * round — which groups do those links form across the whole list, and which of
 * them matter most.
 *
 * Two steps:
 *
 *  1. Connected components of the undirected relationship graph. Most are
 *     small and coherent: a company and its subsidiaries, a cartel and its
 *     fronts, an airline and its aircraft.
 *
 *  2. One component is not. Hizballah, the IRGC, Iranian shipping and
 *     procurement and their facilitators are chained together by "providing
 *     support to" links into a single component of ~2,700 parties — true, but
 *     not a network anyone can read. Components above SPLIT_ABOVE are divided
 *     into communities with the Louvain method (modularity maximisation),
 *     which finds the groups that are far more densely linked inside than to
 *     each other. Each community is reported as a network of its own, with the
 *     links to its sibling communities kept, so nothing about the larger
 *     structure is hidden.
 *
 * Louvain runs in a fixed node order with deterministic tie-breaking, so the
 * same snapshot always yields the same networks; ids are the hub's own record
 * id, so a link to a network survives a rebuild as long as its hub does.
 *
 * Edge weights: an ownership link counts 2, any other link 1 — ownership is
 * what the 50 Percent Rule reaches, and it is the stronger tie.
 *
 * A network is a picture of published relationships, not a finding: it says
 * the authority linked these parties, not that they act together today.
 */

const { OWNERSHIP_RE } = require('./graph');
const { index: crossIndex } = require('./crosslist');
const { countriesOf } = require('./stats');

const SPLIT_ABOVE = 400;   // components larger than this are divided into communities
const MIN_SIZE = 3;        // pairs are listed as a count, not as networks

function relKey(rel) {
  if (rel.relatedId) return String(rel.relatedId);
  if (rel.relatedName) return 'name:' + rel.relatedName.toLowerCase().replace(/\s+/g, '_');
  return '';
}

function buildGraph(entities) {
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  const ids = [];
  const at = new Map();
  const synth = new Map();
  const node = (id, name) => {
    let i = at.get(id);
    if (i === undefined) {
      i = ids.length; ids.push(id); at.set(id, i);
      if (!byId.has(id)) synth.set(id, name || id);
    }
    return i;
  };
  // Undirected, one entry per unordered pair: summed weight, the relationship
  // types in either direction, and whether any of them is ownership.
  const pairs = new Map();
  for (const e of entities) {
    const rels = e.relationships || [];
    if (!rels.length) continue;
    const a = node(String(e.id));
    for (const rel of rels) {
      const to = relKey(rel);
      if (!to || to === String(e.id)) continue;
      const b = node(to, rel.relatedName);
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const k = lo * 0x200000 + hi;
      let p = pairs.get(k);
      if (!p) { p = { a: lo, b: hi, w: 0, types: new Set(), ownership: false }; pairs.set(k, p); }
      const own = OWNERSHIP_RE.test(rel.type || '');
      p.w += own ? 2 : 1;
      p.ownership = p.ownership || own;
      if (rel.type) p.types.add(rel.type);
    }
  }
  const adj = ids.map(() => []);
  const edges = [...pairs.values()];
  for (const p of edges) { adj[p.a].push([p.b, p.w]); adj[p.b].push([p.a, p.w]); }
  return { byId, ids, synth, adj, edges };
}

function components(n, adj) {
  const comp = new Int32Array(n).fill(-1);
  const out = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const members = [s];
    comp[s] = out.length;
    for (let q = 0; q < members.length; q++) {
      for (const [t] of adj[members[q]]) if (comp[t] === -1) { comp[t] = out.length; members.push(t); }
    }
    members.sort((x, y) => x - y);
    out.push(members);
  }
  return out;
}

/*
 * Louvain community detection on one component.
 *
 * `local` is the component's adjacency re-indexed 0..n-1. Returns the
 * community of each local node. Standard two-phase method: move single nodes
 * to the neighbouring community with the best modularity gain until no move
 * helps, then collapse each community into one node and repeat on the
 * smaller graph. Nodes are visited in index order and ties keep the current
 * community (then the lowest id), so the result is reproducible.
 */
function louvain(local) {
  let graph = local.map((nb) => nb.slice());
  let loops = new Float64Array(graph.length);
  let membership = Int32Array.from(graph.map((_, i) => i));

  for (let level = 0; level < 12; level++) {
    const n = graph.length;
    const k = new Float64Array(n);
    let m2 = 0;
    for (let i = 0; i < n; i++) {
      let s = 2 * loops[i];
      for (const [, w] of graph[i]) s += w;
      k[i] = s; m2 += s;
    }
    if (!m2) break;
    const comm = Int32Array.from(graph.map((_, i) => i));
    const tot = Float64Array.from(k);
    let moved = false;
    const wTo = new Map();
    for (let sweep = 0; sweep < 30; sweep++) {
      let changed = 0;
      for (let i = 0; i < n; i++) {
        const ci = comm[i];
        wTo.clear();
        for (const [j, w] of graph[i]) {
          if (j === i) continue;
          wTo.set(comm[j], (wTo.get(comm[j]) || 0) + w);
        }
        tot[ci] -= k[i];
        let best = ci;
        let bestGain = (wTo.get(ci) || 0) - (tot[ci] * k[i]) / m2;
        for (const [c, w] of wTo) {
          const gain = w - (tot[c] * k[i]) / m2;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best && best !== ci)) {
            best = c; bestGain = gain;
          }
        }
        tot[best] += k[i];
        if (best !== ci) { comm[i] = best; changed++; moved = true; }
      }
      if (!changed) break;
    }
    if (!moved) break;

    // Renumber communities 0..c-1 in order of first appearance.
    const renum = new Map();
    for (let i = 0; i < n; i++) if (!renum.has(comm[i])) renum.set(comm[i], renum.size);
    const c = renum.size;
    membership = membership.map((x) => renum.get(comm[x]));
    if (c === n) break;

    // Collapse: one node per community, internal weight as a self-loop.
    const nextLoops = new Float64Array(c);
    const nextAdj = Array.from({ length: c }, () => new Map());
    for (let i = 0; i < n; i++) {
      const a = renum.get(comm[i]);
      nextLoops[a] += loops[i];
      for (const [j, w] of graph[i]) {
        const b = renum.get(comm[j]);
        if (a === b) { if (i < j) nextLoops[a] += w; }
        else nextAdj[a].set(b, (nextAdj[a].get(b) || 0) + w);
      }
    }
    graph = nextAdj.map((m) => [...m.entries()].sort((x, y) => x[0] - y[0]));
    loops = nextLoops;
  }
  return membership;
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

function compute(entities) {
  const g = buildGraph(entities);
  const { byId, ids, synth, adj, edges } = g;
  const comps = components(ids.length, adj);

  // Network of every node: components as they are, giants split by Louvain.
  const netOf = new Int32Array(ids.length).fill(-1);
  const groups = []; // { members:number[], component:number }
  const componentInfo = [];
  comps.forEach((members, ci) => {
    if (members.length <= SPLIT_ABOVE) {
      for (const m of members) netOf[m] = groups.length;
      groups.push({ members, component: ci });
      componentInfo.push({ size: members.length, networks: 1 });
      return;
    }
    const localIdx = new Map(members.map((m, i) => [m, i]));
    const local = members.map((m) => adj[m].map(([t, w]) => [localIdx.get(t), w]));
    const membership = louvain(local);
    const byComm = new Map();
    members.forEach((m, i) => {
      const c = membership[i];
      if (!byComm.has(c)) byComm.set(c, []);
      byComm.get(c).push(m);
    });
    for (const sub of byComm.values()) {
      for (const m of sub) netOf[m] = groups.length;
      groups.push({ members: sub, component: ci });
    }
    componentInfo.push({ size: members.length, networks: byComm.size });
  });

  // Edges per network, and links between sibling networks.
  const inner = groups.map(() => []);
  const between = groups.map(() => new Map());
  for (const e of edges) {
    const na = netOf[e.a], nb = netOf[e.b];
    if (na === nb) inner[na].push(e);
    else {
      between[na].set(nb, (between[na].get(nb) || 0) + 1);
      between[nb].set(na, (between[nb].get(na) || 0) + 1);
    }
  }

  const { rootOf, groups: xgroups } = crossIndex(entities);
  const alsoListedBy = (id) => {
    const root = rootOf.get(id);
    if (!root) return [];
    const self = byId.get(id);
    const out = new Set();
    for (const other of xgroups.get(root).ids) {
      const r = byId.get(other);
      if (r && r.authority !== (self && self.authority)) out.add(r.authority);
    }
    return [...out].sort();
  };

  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const networks = groups.map((grp, gi) => {
    const wdeg = new Map();
    for (const e of inner[gi]) {
      wdeg.set(e.a, (wdeg.get(e.a) || 0) + e.w);
      wdeg.set(e.b, (wdeg.get(e.b) || 0) + e.w);
    }
    const nameOf = (i) => { const r = byId.get(ids[i]); return r ? r.name : synth.get(ids[i]); };
    // The hub: the most strongly linked party, a listed one before an
    // unlisted name, then by name so the choice is stable.
    let hub = grp.members[0];
    for (const m of grp.members) {
      const better = (wdeg.get(m) || 0) - (wdeg.get(hub) || 0);
      const listed = byId.has(ids[m]) - byId.has(ids[hub]);
      if (listed > 0 || (listed === 0 && (better > 0 || (better === 0 && String(nameOf(m)).localeCompare(String(nameOf(hub))) < 0)))) hub = m;
    }
    const types = new Map(), programs = new Map(), countries = new Map(), relTypes = new Map(), authorities = new Map();
    let listed = 0, crossListed = 0, newest = '', recent = 0;
    for (const m of grp.members) {
      const r = byId.get(ids[m]);
      if (!r) continue;
      listed++;
      types.set(r.type || 'Unknown', (types.get(r.type || 'Unknown') || 0) + 1);
      for (const p of r.programs || []) programs.set(p, (programs.get(p) || 0) + 1);
      for (const c of countriesOf(r)) countries.set(c, (countries.get(c) || 0) + 1);
      const also = alsoListedBy(ids[m]);
      if (also.length) { crossListed++; for (const a of also) authorities.set(a, (authorities.get(a) || 0) + 1); }
      const d = String(r.datePublished || '').slice(0, 10);
      if (d > newest) newest = d;
      if (d && d >= yearAgo) recent++;
    }
    let ownershipLinks = 0;
    for (const e of inner[gi]) {
      if (e.ownership) ownershipLinks++;
      for (const t of e.types) relTypes.set(t, (relTypes.get(t) || 0) + 1);
    }
    return {
      gi,
      id: 'N' + ids[hub],
      name: nameOf(hub),
      hubId: ids[hub],
      size: grp.members.length,
      listed,
      external: grp.members.length - listed,
      links: inner[gi].length,
      ownershipLinks,
      types: Object.fromEntries(top(types, 6)),
      programs: top(programs, 5),
      countries: top(countries, 4),
      relationTypes: top(relTypes, 4),
      crossListed,
      alsoListedBy: top(authorities, 6),
      newest,
      recent,
      component: { size: componentInfo[grp.component].size, networks: componentInfo[grp.component].networks },
      neighbours: top(between[gi], 6).map(([ngi, n]) => ({ gi: ngi, links: n })),
    };
  });
  // Neighbour references by id once every network has one.
  for (const n of networks) n.neighbours = n.neighbours.map(({ gi, links }) => ({ id: networks[gi].id, name: networks[gi].name, links }));

  const listedNetworks = networks.filter((n) => n.size >= MIN_SIZE).sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const byNetId = new Map(networks.map((n) => [n.id, n]));
  return {
    g, groups, inner, networks, listedNetworks, byNetId, netOf,
    totals: {
      networks: listedNetworks.length,
      parties: listedNetworks.reduce((s, n) => s + n.listed, 0),
      pairs: networks.filter((n) => n.size === 2).length,
      links: edges.length,
      split: componentInfo.filter((c) => c.networks > 1).map((c) => ({ size: c.size, networks: c.networks })),
    },
  };
}

let cacheFor = null, cache = null;
function state(entities) {
  if (cacheFor !== entities) {
    const t = Date.now();
    cache = compute(entities);
    cacheFor = entities;
    console.log(`Networks computed: ${cache.totals.networks} networks in ${Date.now() - t}ms`);
  }
  return cache;
}

const summaryOf = ({ gi, ...rest }) => rest; // eslint-disable-line no-unused-vars

// Every network of MIN_SIZE parties or more, largest first, with the totals.
function networkList(entities) {
  const s = state(entities);
  return {
    totals: s.totals,
    networks: s.listedNetworks.map(summaryOf),
    note: 'Groups formed by the relationships OFAC publishes between listed parties. A display and triage aid, not a determination.',
  };
}

/*
 * One network: its summary, every member, and every link among them. Edges
 * reference members by index into `nodes`, which keeps a 500-party network
 * to a payload the page can draw at once.
 */
function networkDetail(entities, id) {
  const s = state(entities);
  const net = s.byNetId.get(String(id));
  if (!net) return null;
  const { g, groups, inner } = s;
  const members = groups[net.gi].members;
  const pos = new Map(members.map((m, i) => [m, i]));
  const wdeg = new Map();
  for (const e of inner[net.gi]) {
    wdeg.set(e.a, (wdeg.get(e.a) || 0) + e.w);
    wdeg.set(e.b, (wdeg.get(e.b) || 0) + e.w);
  }
  const { rootOf, groups: xgroups } = crossIndex(entities);
  const nodes = members.map((m) => {
    const id = g.ids[m];
    const r = g.byId.get(id);
    if (!r) return { id, name: g.synth.get(id), type: 'Unlisted', inSnapshot: false, weight: wdeg.get(m) || 0 };
    const root = rootOf.get(id);
    const also = new Set();
    if (root) for (const other of xgroups.get(root).ids) { const o = g.byId.get(other); if (o && o.authority !== r.authority) also.add(o.authority); }
    return {
      id, name: r.name, type: r.type || 'Unknown', list: r.list || '', programs: (r.programs || []).slice(0, 4),
      datePublished: r.datePublished || '', inSnapshot: true, weight: wdeg.get(m) || 0,
      alsoListedBy: [...also].sort(),
    };
  });
  const edges = inner[net.gi].map((e) => ({ s: pos.get(e.a), t: pos.get(e.b), types: [...e.types], ownership: e.ownership }));
  return Object.assign(summaryOf(net), { nodes, edges, hubIndex: nodes.findIndex((n) => n.id === net.hubId) });
}

// The network a party belongs to, for a link from its record.
function networkOf(entities, entityId) {
  const s = state(entities);
  const i = s.g.ids.indexOf(String(entityId));
  if (i < 0) return null;
  const net = s.networks[s.netOf[i]];
  return net && net.size >= MIN_SIZE ? { id: net.id, name: net.name, size: net.size } : null;
}

module.exports = { networkList, networkDetail, networkOf, louvain, SPLIT_ABOVE, MIN_SIZE };
