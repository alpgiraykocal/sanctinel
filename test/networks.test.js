'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { networkList, networkDetail, networkOf, louvain, SPLIT_ABOVE } = require('../lib/networks');

// A listed party with relationships to other ids.
const party = (id, type, rels, extra) => Object.assign({
  id: String(id), name: `PARTY ${id}`, type, authority: 'OFAC', list: 'SDN List', programs: ['TEST'],
  relationships: rels.map(([to, t]) => ({ relatedId: String(to), relatedName: `PARTY ${to}`, type: t || 'Providing support to' })),
}, extra || {});

test('connected parties form one network, named after the most linked party', () => {
  const E = [
    party(1, 'Entity', [[2, 'Owned or Controlled By'], [3], [4]]),
    party(2, 'Entity', []),
    party(3, 'Individual', [[4]]),
    party(4, 'Vessel', []),
    party(5, 'Entity', [[6]]), // a pair: counted, not listed
    party(6, 'Entity', []),
    party(7, 'Entity', []),    // no links: in no network
  ];
  const l = networkList(E);
  assert.equal(l.networks.length, 1);
  assert.equal(l.totals.pairs, 1);
  const n = l.networks[0];
  assert.equal(n.id, 'N1');
  assert.equal(n.size, 4);
  assert.equal(n.links, 4);
  assert.equal(n.ownershipLinks, 1);
  assert.deepEqual(n.types, { Entity: 2, Individual: 1, Vessel: 1 });
  assert.deepEqual(networkOf(E, '3'), { id: 'N1', name: 'PARTY 1', size: 4 });
  assert.equal(networkOf(E, '5'), null);
  assert.equal(networkOf(E, '7'), null);
});

test('a network\'s detail lists every member and link, by index', () => {
  const E = [party(1, 'Entity', [[2], [3]]), party(2, 'Entity', []), party(3, 'Entity', [[2]])];
  const d = networkDetail(E, 'N1');
  assert.equal(d.nodes.length, 3);
  assert.equal(d.edges.length, 3);
  for (const e of d.edges) assert.ok(d.nodes[e.s] && d.nodes[e.t]);
  assert.equal(d.nodes[d.hubIndex].id, '1');
  assert.equal(networkDetail(E, 'N999'), null);
});

test('an unlisted related party is kept, marked as not listed', () => {
  const E = [party(1, 'Entity', [[2], [3]]), party(2, 'Entity', [])];
  E[0].relationships.push({ relatedId: '', relatedName: 'Unlisted Holding Ltd', type: 'Owned or Controlled By' });
  const d = networkDetail(E, 'N1');
  const ext = d.nodes.filter((n) => !n.inSnapshot);
  assert.equal(ext.length, 2); // party 3 is not in the snapshot either
  assert.ok(ext.some((n) => n.name === 'Unlisted Holding Ltd'));
  assert.equal(d.external, 2);
});

test('a group too large to read is split into its communities, linked to each other', () => {
  // Two dense clusters of 250 joined by a single link: one component of 500,
  // over SPLIT_ABOVE, which Louvain must cut at the bridge.
  const E = [];
  const cluster = (base) => {
    for (let i = 0; i < 250; i++) {
      const rels = [];
      for (let j = 1; j <= 4; j++) rels.push([base + ((i + j) % 250)]);
      E.push(party(base + i, 'Entity', rels));
    }
  };
  cluster(1000); cluster(2000);
  E[0].relationships.push({ relatedId: '2000', relatedName: 'PARTY 2000', type: 'Providing support to' });
  assert.ok(500 > SPLIT_ABOVE);
  const l = networkList(E);
  assert.ok(l.networks.length >= 2, `${l.networks.length} networks`);
  assert.equal(l.totals.split.length, 1);
  assert.equal(l.totals.split[0].size, 500);
  // No community mixes the two clusters.
  for (const n of l.networks) {
    const d = networkDetail(E, n.id);
    const sides = new Set(d.nodes.map((x) => x.id[0]));
    assert.equal(sides.size, 1, `${n.id} mixes clusters`);
  }
  // The bridge is reported as a single link between networks of either side.
  assert.ok(l.networks.some((n) => n.neighbours.some((x) => x.links === 1 && x.id[1] !== n.id[1])));
});

test('louvain is deterministic and separates two cliques joined by one edge', () => {
  const clique = (o) => [0, 1, 2, 3].map((i) => [0, 1, 2, 3].filter((j) => j !== i).map((j) => [o + j, 1]));
  const adj = [...clique(0), ...clique(4)];
  adj[0].push([4, 1]); adj[4].push([0, 1]);
  const a = louvain(adj), b = louvain(adj);
  assert.deepEqual([...a], [...b]);
  assert.equal(new Set(a.slice(0, 4)).size, 1);
  assert.equal(new Set(a.slice(4)).size, 1);
  assert.notEqual(a[0], a[4]);
});
