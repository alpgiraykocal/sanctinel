'use strict';

/*
 * Ego-network extraction over OFAC entity relationships.
 *
 * Design order (per AML network-analysis practice): graph model + reduction
 * first, visualization last. This module builds the LOCAL network around one
 * center entity — never the full graph — preserving edge direction, type, and
 * whether an edge is an ownership link (needed for the 50 Percent Rule).
 *
 * Output is an investigation aid. Node/edge emphasis is a triage/display signal,
 * NOT an automated suspicious-activity or blocking determination.
 */

const OWNERSHIP_RE = /own|control|subsid|parent|beneficial/i;

// Build directed adjacency from every entity's relationships. relatedId may be
// empty for an unlisted party — we synthesize a node keyed by name so external
// (possibly unlisted) owners still appear, which matters for 50% Rule tracing.
function buildAdjacency(entities) {
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  const adj = new Map(); // id -> [{to, type, dir, ownership}]
  const synth = new Map(); // synthetic-id -> {id,name,inSnapshot:false}

  const addEdge = (from, to, type, dir, ownership) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, type, dir, ownership });
  };

  for (const e of entities) {
    const from = String(e.id);
    for (const rel of e.relationships || []) {
      let to = rel.relatedId ? String(rel.relatedId) : '';
      if (!to) {
        if (!rel.relatedName) continue;
        to = 'name:' + rel.relatedName.toLowerCase().replace(/\s+/g, '_');
      }
      // Register a synthetic node for any related party not in the snapshot
      // (e.g. an unlisted owner) so it still renders — important for 50% Rule.
      if (!byId.has(to) && !synth.has(to)) {
        synth.set(to, { id: to, name: rel.relatedName || `Entity ${to}`, type: 'External', list: '', programs: [], inSnapshot: false });
      }
      const ownership = OWNERSHIP_RE.test(rel.type);
      addEdge(from, to, rel.type, 'out', ownership);
      addEdge(to, from, rel.type, 'in', ownership); // reverse for undirected traversal
    }
  }
  return { byId, adj, synth };
}

function nodeFor(id, byId, synth, hop) {
  const e = byId.get(id) || synth.get(id);
  if (!e) return null;
  return {
    id: String(id),
    name: e.name || `Entity ${id}`,
    type: e.type || 'Unknown',
    list: e.list || '',
    programs: e.programs || [],
    inSnapshot: e.inSnapshot !== false,
    hop,
  };
}

/*
 * Extract the ego network around centerId up to `depth` hops.
 * limits: { maxNodes }. Deterministic ordering (by hop, then name).
 */
// Adjacency over the whole snapshot costs a pass across every entity and edge
// (~38k / ~9k). It is identical for every ego request against the same
// snapshot, so build it once per entities array; a refresh swaps that array and
// the cache falls away with it.
let adjacencyFor = null, adjacencyCache = null;
function adjacencyOf(entities) {
  if (adjacencyFor !== entities) {
    adjacencyCache = buildAdjacency(entities);
    adjacencyFor = entities;
  }
  return adjacencyCache;
}

function egoNetwork(entities, centerId, depth = 2, limits = {}) {
  const maxNodes = limits.maxNodes || 300;
  const { byId, adj, synth } = adjacencyOf(entities);
  centerId = String(centerId);
  if (!byId.has(centerId)) return null;

  const hopOf = new Map([[centerId, 0]]);
  const order = [centerId];
  let frontier = [centerId];

  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const id of frontier) {
      const neighbors = (adj.get(id) || []).slice().sort((a, b) => a.to.localeCompare(b.to));
      for (const edge of neighbors) {
        if (!hopOf.has(edge.to)) {
          hopOf.set(edge.to, d);
          order.push(edge.to);
          next.push(edge.to);
          if (hopOf.size >= maxNodes) break;
        }
      }
      if (hopOf.size >= maxNodes) break;
    }
    frontier = next;
    if (hopOf.size >= maxNodes) break;
  }

  // Nodes.
  const nodes = order.map((id) => nodeFor(id, byId, synth, hopOf.get(id))).filter(Boolean);
  const inSet = new Set(nodes.map((n) => n.id));

  // Directed edges among included nodes (dedup, keep 'out' direction only).
  const edges = [];
  const seen = new Set();
  for (const e of entities) {
    const from = String(e.id);
    if (!inSet.has(from)) continue;
    for (const rel of e.relationships || []) {
      let to = rel.relatedId ? String(rel.relatedId) : (rel.relatedName ? 'name:' + rel.relatedName.toLowerCase().replace(/\s+/g, '_') : '');
      if (!to || !inSet.has(to)) continue;
      const key = `${from}->${to}:${rel.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: from, target: to, type: rel.type, ownership: OWNERSHIP_RE.test(rel.type) });
    }
  }

  // Explainable metrics: degree + weighted (ownership counts double).
  const degree = new Map();
  const wdegree = new Map();
  for (const n of nodes) { degree.set(n.id, 0); wdegree.set(n.id, 0); }
  for (const ed of edges) {
    for (const id of [ed.source, ed.target]) {
      degree.set(id, (degree.get(id) || 0) + 1);
      wdegree.set(id, (wdegree.get(id) || 0) + (ed.ownership ? 2 : 1));
    }
  }
  for (const n of nodes) { n.degree = degree.get(n.id); n.weightedDegree = wdegree.get(n.id); }

  const center = nodes.find((n) => n.id === centerId);
  return {
    center: { id: center.id, name: center.name },
    depth,
    nodes,
    edges,
    metrics: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      ownershipEdges: edges.filter((e) => e.ownership).length,
      topByDegree: [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 5)
        .map((n) => ({ id: n.id, name: n.name, degree: n.degree, weightedDegree: n.weightedDegree })),
    },
    audit: {
      center: centerId,
      depth,
      maxNodes,
      note: 'Display/triage aid over listed relationships only — not a determination.',
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { egoNetwork, buildAdjacency, OWNERSHIP_RE };
