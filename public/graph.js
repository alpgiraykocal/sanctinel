'use strict';

/*
 * Radial ego-network renderer with a hybrid pipeline:
 *   - small / medium graphs  → Canvas 2D (curved edges, arrows, shadows, halos)
 *   - large graphs (> GL_MIN nodes) → WebGL geometry (points + lines) with a
 *     Canvas 2D overlay for hop guides, culled labels, highlight rings, tooltip.
 * WebGL keeps hundreds–thousands of nodes/edges smooth where 2D would stall.
 *
 * Deterministic radial layout: center middle, 1-hop ring one, 2-hop ring two.
 * Display/triage aid only — not a determination.
 */
(function () {
  const GL_MIN = 140; // node count at which we switch to WebGL

  const modal = () => document.getElementById('graphModal');
  const cv = () => document.getElementById('graphCanvas');
  const glCanvas = () => document.getElementById('graphGL');

  let state = { data: null, depth: 2, hover: null, layout: [], centerId: null, geom: null, glCtx: null, glFailed: false, view: 'radial' };

  const LIGHT_C = {
    center: '#2563EB', centerHalo: 'rgba(37,99,235,.16)', centerRing: '#1D4ED8',
    block: '#DC2626', restrict: '#D97706', ext: '#94A3B8',
    edge: '#CBD5E1', edgeOwn: '#DC2626',
    label: '#0F172A', labelDim: '#94A3B8', halo: 'rgba(248,250,252,.92)',
    nodeStroke: '#FFFFFF', guide: 'rgba(100,116,139,.16)', guideText: 'rgba(100,116,139,.55)',
    ownStroke: '#0F172A', tipBg: 'rgba(255,255,255,.98)', tipBorder: '#CBD5E1', tipText: '#0F172A', tipDim: '#64748B',
  };
  const DARK_C = {
    center: '#3B82F6', centerHalo: 'rgba(59,130,246,.22)', centerRing: '#60A5FA',
    block: '#F87171', restrict: '#FBBF24', ext: '#64748B',
    edge: '#3A4870', edgeOwn: '#F87171',
    label: '#F1F5F9', labelDim: '#94A3B8', halo: 'rgba(11,18,32,.92)',
    nodeStroke: '#0B1220', guide: 'rgba(148,163,184,.14)', guideText: 'rgba(148,163,184,.5)',
    ownStroke: '#F1F5F9', tipBg: 'rgba(19,28,49,.98)', tipBorder: '#3A4870', tipText: '#F1F5F9', tipDim: '#94A3B8',
  };
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const rgbOf = (c) => ({ center: hex2rgb(c.center), block: hex2rgb(c.block), restrict: hex2rgb(c.restrict), ext: hex2rgb(c.ext), edge: hex2rgb(c.edge), own: hex2rgb(c.edgeOwn) });
  let C = LIGHT_C, RGB = rgbOf(LIGHT_C);
  function applyTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    C = dark ? DARK_C : LIGHT_C; RGB = rgbOf(C);
  }

  function severity(node) {
    if (!node.inSnapshot) return 'ext';
    const l = node.list || '';
    if (/CMIC|Sectoral|Menu-Based/i.test(l)) return 'restrict';
    return 'block';
  }
  const nodeColor = (n) => (n.id === state.centerId ? C.center : C[severity(n)] || C.block);
  const nodeRGB = (n) => (n.id === state.centerId ? RGB.center : RGB[severity(n)] || RGB.block);
  function nodeRadius(n) {
    if (n.id === state.centerId) return 19;
    const w = n.weightedDegree || 1;
    return Math.max(6, Math.min(22, 5.5 + Math.sqrt(w) * 2.4));
  }

  function collapseEdges(edges) {
    const map = new Map();
    for (const e of edges) {
      const key = [e.source, e.target].sort().join('|');
      const cur = map.get(key);
      if (cur) {
        cur.ownership = cur.ownership || e.ownership;
        if (!cur.types.includes(e.type)) cur.types.push(e.type);
        if (cur.from !== e.source) cur.mutual = true;
      } else map.set(key, { from: e.source, to: e.target, ownership: e.ownership, types: [e.type], mutual: false });
    }
    return [...map.values()];
  }

  function computeLayout(data, w, h) {
    const cx = w * 0.5, cy = h * 0.5;
    const depthMax = Math.max(1, ...data.nodes.map((n) => n.hop));
    const maxR = Math.min(w, h) * 0.34;
    const ringGap = maxR / depthMax;
    const byHop = {};
    for (const n of data.nodes) (byHop[n.hop] ||= []).push(n);
    const pos = {};
    for (const hop of Object.keys(byHop)) {
      const ring = byHop[hop].slice().sort((a, b) => a.name.localeCompare(b.name));
      if (Number(hop) === 0) { pos[ring[0].id] = { x: cx, y: cy, ang: 0 }; continue; }
      const r = ringGap * Number(hop);
      const n = ring.length;
      const offset = Number(hop) * 0.6;
      ring.forEach((node, i) => {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2 + offset;
        pos[node.id] = { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), ang };
      });
    }
    state.geom = { cx, cy, ringGap, depthMax, maxR };
    // Clamp node radius by ring crowding so dense rings (50+ siblings on a
    // small screen) render as small separated dots instead of overlapping.
    const ringCount = {};
    for (const n of data.nodes) ringCount[n.hop] = (ringCount[n.hop] || 0) + 1;
    return data.nodes.map((n) => {
      let r = nodeRadius(n);
      if (n.hop > 0) {
        const spacing = (2 * Math.PI * ringGap * n.hop) / ringCount[n.hop];
        r = Math.min(r, Math.max(3.5, spacing * 0.42));
      }
      return { node: n, x: pos[n.id].x, y: pos[n.id].y, r, ang: pos[n.id].ang };
    });
  }

  /* ---------- relationship hierarchy ---------- */

  /*
   * Principals above, subordinates below. The radial view answers "who is
   * connected to this party"; this one answers "who stands above whom, and how
   * far the chain runs" — which a ring of equidistant dots cannot show.
   *
   * EVERY relationship type is drawn, not only ownership. Restricting the
   * hierarchy to ownership left 42% of the parties that have any relationship
   * at all with an empty diagram, and the chains it dropped are often the ones
   * worth seeing: TURKMEN → TALIB → AL QA'IDA is a support chain with no
   * ownership edge anywhere in it.
   *
   * Ownership stays distinct — solid red, its own legend entry, called out in
   * the side note — because it alone drives the 50 Percent Rule. Per-type
   * direction is resolved server-side (lib/graph.relationDirection).
   */
  // rowGap leaves a lane wide enough for a connector bus between wrapped rows;
  // padBottom keeps the last row clear of the renderer badge.
  const HB = { nodeW: 150, nodeH: 34, gapX: 14, gapY: 74, rowGap: 26, pad: 22, padBottom: 30 };
  // Below this the box text stops being readable, so the stage scrolls instead.
  const MIN_HIERARCHY_SCALE = 0.66;

  /*
   * Corporate names in this data are mostly legal form: forty boxes reading
   * "LIMITED LIABILITY C…" and "JOINT STOCK COMPA…" tell an analyst nothing,
   * because the part that identifies the company is the part that gets cut.
   * Strip the legal form for the box label; the tooltip still carries the name
   * exactly as the authority published it.
   */
  const LEGAL_PREFIX = /^(?:(?:PUBLIC|OPEN|CLOSED|PRIVATE|FEDERAL|NON[- ]?PUBLIC)\s+)?(?:JOINT[- ]STOCK\s+COMPANY|LIMITED\s+LIABILITY\s+COMPANY|LIMITED\s+LIABILITY\s+PARTNERSHIP|JOINT\s+VENTURE|STOCK\s+COMPANY|COMPANY|CORPORATION|OOO|OAO|PAO|ZAO|AO|JSC|PJSC|OJSC|CJSC|LLC|LLP|LTD|PLC|SA|AG|GMBH|SPA|BV|NV)\b[\s,.:-]*/i;
  const LEGAL_SUFFIX = /[\s,]+(?:OOO|OAO|PAO|ZAO|AO|JSC|PJSC|OJSC|CJSC|LLC|LLP|LTD|LIMITED|PLC|S\.?A\.?|A\.?G\.?|GMBH|S\.?P\.?A\.?|B\.?V\.?|N\.?V\.?|INC\.?|CO\.?)\s*$/i;

  function shortName(name) {
    let s = String(name || '').trim();
    const stripped = s.replace(LEGAL_PREFIX, '').replace(LEGAL_SUFFIX, '').trim();
    // Only use it if something identifying survived — "OOO" alone is not a name.
    return stripped.length >= 3 ? stripped : s;
  }

  // Normalize every edge to above → below, dropping self-loops. Peer edges
  // (family, association) carry no direction and are kept aside so they can be
  // drawn level rather than forced into a rung they do not belong on.
  function hierPairs() {
    const out = [];
    const peers = [];
    const seen = new Set();
    for (const e of state.data.edges) {
      if (e.source === e.target) continue;
      const dir = e.hier || 'up';
      if (dir === 'peer') {
        const key = [e.source, e.target].sort().join('~');
        if (seen.has(key)) continue;
        seen.add(key);
        peers.push({ a: e.source, b: e.target, type: e.type });
        continue;
      }
      const above = dir === 'down' ? e.source : e.target;
      const below = dir === 'down' ? e.target : e.source;
      const key = `${above}>${below}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Position says who is superior; the ARROW says which way the stated
      // relationship runs, and the two are not always the same. "X owns Y"
      // points down at Y, but "X provides support to Y" puts Y above and points
      // UP at Y — drawing that one downward would claim the principal supports
      // its subordinate, the reverse of what the list says.
      out.push({
        owner: above, owned: below, type: e.type,
        ownership: !!e.ownership, role: e.role || null, pointsUp: dir === 'up',
      });
    }
    return { pairs: out, peers };
  }

  // Level 0 is the centre; negative levels are the parties above it (owners,
  // principals, beneficiaries), positive the ones below (holdings, agents,
  // supporters).
  function assignLevels(pairs, peers) {
    const up = new Map(), down = new Map(), side = new Map();
    const link = (map, from, to) => { const a = map.get(from); if (a) a.push(to); else map.set(from, [to]); };
    for (const p of pairs) { link(down, p.owner, p.owned); link(up, p.owned, p.owner); }
    for (const p of peers || []) { link(side, p.a, p.b); link(side, p.b, p.a); }
    // One BFS over the relationship graph treated as undirected, with the level
    // stepping up, down or staying put according to which way each edge points.
    // Walking the two directions in separate passes from the centre looked
    // equivalent but was not: it never reached the centre's SIBLINGS — the
    // other parties hanging off its principal, which is most of the chain in
    // practice and exactly what the review is looking for.
    const level = new Map([[state.centerId, 0]]);
    let frontier = [state.centerId];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        const base = level.get(id);
        const step = (map, delta) => {
          for (const to of map.get(id) || []) {
            if (level.has(to)) continue;
            level.set(to, base + delta); next.push(to);
          }
        };
        step(up, -1);
        step(down, 1);
        step(side, 0);
      }
      frontier = next;
    }
    return level;
  }

  /*
   * Wide sibling sets are the norm here — one Russian parent bank can hold
   * fifty listed subsidiaries. Laying them out on a single row would squeeze
   * each box to a few unreadable pixels, so a level wraps into as many rows as
   * it needs and the connectors run through a horizontal bus per level.
   */
  function computeHierarchyLayout(w, h) {
    const { pairs, peers } = hierPairs();
    const level = assignLevels(pairs, peers);
    const byId = new Map(state.data.nodes.map((n) => [n.id, n]));

    const levels = [...new Set([...level.values()])].sort((a, b) => a - b);
    const perLevel = new Map(levels.map((l) => [l, []]));
    for (const [id, l] of level) { const n = byId.get(id); if (n) perLevel.get(l).push(n); }
    // Deterministic: centre first in its band, then heaviest, then by name.
    for (const list of perLevel.values()) {
      list.sort((a, b) => {
        if (a.id === state.centerId) return -1;
        if (b.id === state.centerId) return 1;
        return (b.weightedDegree - a.weightedDegree) || a.name.localeCompare(b.name);
      });
    }

    const usableW = Math.max(HB.nodeW + HB.pad * 2, w - HB.pad * 2);
    const perRow = Math.max(1, Math.floor((usableW + HB.gapX) / (HB.nodeW + HB.gapX)));

    // Height each band needs once its members wrap.
    const bands = levels.map((l) => {
      const list = perLevel.get(l);
      const rows = Math.max(1, Math.ceil(list.length / perRow));
      return { level: l, list, rows, height: rows * HB.nodeH + (rows - 1) * HB.rowGap };
    });

    const totalH = bands.reduce((s, b) => s + b.height, 0) + (bands.length - 1) * HB.gapY;
    const usableH = h - HB.pad - HB.padBottom;
    const scale = Math.min(1, usableH / Math.max(1, totalH));

    const positions = [];
    let y = HB.pad + Math.max(0, (usableH - totalH * scale) / 2);
    for (const band of bands) {
      band.top = y;
      band.bottom = y + band.height * scale;
      for (let i = 0; i < band.list.length; i++) {
        const row = Math.floor(i / perRow);
        const inRow = band.list.slice(row * perRow, (row + 1) * perRow).length;
        const col = i % perRow;
        const rowW = inRow * HB.nodeW + (inRow - 1) * HB.gapX;
        const x0 = (w - rowW) / 2;
        positions.push({
          node: band.list[i],
          x: x0 + col * (HB.nodeW + HB.gapX) + HB.nodeW / 2,
          y: y + (row * (HB.nodeH + HB.rowGap) + HB.nodeH / 2) * scale,
          w: HB.nodeW, h: HB.nodeH * scale,
          r: Math.max(6, (HB.nodeH * scale) / 2), // hit radius for shared hover/click
          level: band.level,
        });
      }
      y += band.height * scale + HB.gapY * scale;
    }

    const drawn = new Set(positions.map((p) => p.node.id));
    const shownPairs = pairs.filter((p) => drawn.has(p.owner) && drawn.has(p.owned));
    const shownPeers = peers.filter((p) => drawn.has(p.a) && drawn.has(p.b));
    const ownershipLinks = shownPairs.filter((p) => p.ownership).length;
    const orphans = state.data.nodes.length - drawn.size;
    return {
      positions, pairs: shownPairs, peers: shownPeers, bands, scale,
      ownershipLinks, orphans,
    };
  }

  /*
   * Three link styles, in descending legal weight. Ownership is the only one
   * the 50 Percent Rule reaches, so it must never look like the others:
   *   solid red    50%+ ownership / control
   *   dashed amber beneficial interest (property held in a party's interest)
   *   dashed grey  everything else — support, agency, office, association
   */
  const kindOf = (p) => (p.ownership ? 'own' : p.role ? 'interest' : 'other');

  function linkStyle(p) {
    const kind = typeof p === 'string' ? p : kindOf(p);
    if (kind === 'own') return { color: C.edgeOwn, dash: null, width: 1.9, alpha: 0.85 };
    if (kind === 'interest') return { color: C.restrict, dash: [4, 3], width: 1.4, alpha: 0.75 };
    return { color: C.labelDim, dash: [4, 3], width: 1.4, alpha: 0.8 };
  }

  // A shared bus takes its children's style only when they agree. Painting a
  // mixed bus in ownership red would say "everything hanging off this is owned",
  // which for a principal that both owns one party and is merely supported by
  // two others is exactly the wrong claim.
  function busStyle(kids) {
    const kinds = new Set(kids.map(kindOf));
    return linkStyle(kinds.size === 1 ? [...kinds][0] : 'other');
  }

  function drawHierarchy(ctx, H, w, h, hover) {
    const pos = new Map(H.positions.map((p) => [p.node.id, p]));
    const hot = new Set();
    if (hover) {
      for (const p of H.pairs) {
        if (p.owner === hover) hot.add(p.owned);
        if (p.owned === hover) hot.add(p.owner);
      }
      for (const p of H.peers) {
        if (p.a === hover) hot.add(p.b);
        if (p.b === hover) hot.add(p.a);
      }
      hot.add(hover);
    }

    // Band guides so the "above = principal" reading is unmistakable.
    ctx.save();
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.guideText;
    for (const b of H.bands) {
      const n = b.list.length;
      const label = b.level === 0
        ? (n > 1 ? `centre + ${n - 1} at the same level` : 'centre')
        : b.level < 0
          ? `owners, principals & beneficiaries${-b.level > 1 ? ` · ${-b.level} up` : ''} (${n})`
          : `holdings, agents & supporters${b.level > 1 ? ` · ${b.level} down` : ''} (${n})`;
      ctx.fillText(label, 10, b.top - 6);
      ctx.strokeStyle = C.guide;
      ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.moveTo(8, b.top - 2); ctx.lineTo(w - 8, b.top - 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    /*
     * One trunk per owner, one horizontal bus per row of its holdings, then a
     * short drop into each box — the org-chart convention. Drawing an
     * independent elbow per child instead put forty near-parallel verticals
     * through every row of a wide band, which reads as noise rather than
     * structure.
     */
    const byOwner = new Map();
    for (const p of H.pairs) {
      const a = pos.get(p.owner), b = pos.get(p.owned);
      if (!a || !b) continue;
      const g = byOwner.get(p.owner) || { owner: a, kids: [] };
      g.kids.push({ box: b, ownership: p.ownership, role: p.role, type: p.type, owned: p.owned, pointsUp: p.pointsUp });
      byOwner.set(p.owner, g);
    }

    for (const [ownerId, g] of byOwner) {
      // Rows share a y; group so each gets its own bus.
      const rows = new Map();
      for (const k of g.kids) {
        const key = Math.round(k.box.y);
        const list = rows.get(key);
        if (list) list.push(k); else rows.set(key, [k]);
      }
      // Keep the bus inside the lane between rows so it never hides under the
      // row above it.
      const lane = Math.max(5, Math.min(13, (HB.rowGap * H.scale) / 2));
      for (const [rowY, kids] of rows) {
        const down = rowY > g.owner.y;
        const sample = kids[0].box;
        const busY = down ? sample.y - sample.h / 2 - lane : sample.y + sample.h / 2 + lane;
        const xs = kids.map((k) => k.box.x);
        const trunkX = Math.min(Math.max(g.owner.x, Math.min(...xs)), Math.max(...xs));
        const dimRow = hover && !hot.has(ownerId) && !kids.some((k) => hot.has(k.owned));
        const rowStyle = busStyle(kids);

        ctx.strokeStyle = rowStyle.color;
        ctx.globalAlpha = dimRow ? 0.1 : rowStyle.alpha * 0.9;
        ctx.lineWidth = rowStyle.width;
        if (rowStyle.dash) ctx.setLineDash(rowStyle.dash);

        // Trunk from the principal's box to this row's bus.
        ctx.beginPath();
        ctx.moveTo(g.owner.x, g.owner.y + (down ? g.owner.h / 2 : -g.owner.h / 2));
        ctx.lineTo(g.owner.x, busY);
        ctx.lineTo(trunkX, busY);
        ctx.stroke();
        // The bus itself.
        ctx.beginPath();
        ctx.moveTo(Math.min(...xs), busY);
        ctx.lineTo(Math.max(...xs), busY);
        ctx.stroke();
        ctx.setLineDash([]);

        for (const k of kids) {
          const dim = hover && !(hot.has(ownerId) && hot.has(k.owned));
          const st = linkStyle(k);
          ctx.strokeStyle = st.color;
          ctx.lineWidth = st.width;
          if (st.dash) ctx.setLineDash(st.dash);
          ctx.globalAlpha = dim ? 0.1 : st.alpha;
          const by = k.box.y - (down ? k.box.h / 2 : -k.box.h / 2);
          ctx.beginPath();
          ctx.moveTo(k.box.x, busY);
          ctx.lineTo(k.box.x, by);
          ctx.stroke();
          ctx.setLineDash([]);
          if (!dim) {
            const s = 6, toward = down ? 1 : -1;
            // Apex sits on the box it points at: into the lower box when the
            // relationship runs downward ("owns"), away from it and up toward
            // the principal when it runs upward ("owned by", "support to").
            const apexY = k.pointsUp ? by - s * toward * 1.6 : by;
            const baseY = k.pointsUp ? by - s * toward * 0.6 : by - s * toward;
            ctx.beginPath();
            ctx.moveTo(k.box.x, apexY);
            ctx.lineTo(k.box.x - s * 0.6, baseY);
            ctx.lineTo(k.box.x + s * 0.6, baseY);
            ctx.closePath();
            ctx.fillStyle = st.color;
            ctx.fill();
          }
          // With mixed relationship types on one diagram the line style alone
          // cannot say WHICH relationship this is, so name it on hover.
          if (hover && (hover === ownerId || hover === k.owned)) {
            labelText(ctx, k.type, k.box.x, (busY + by) / 2, '9px "IBM Plex Mono", monospace', C.labelDim, 'center');
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // Peer links (family, association) carry no direction — draw them level,
    // between the two boxes, so they never read as a chain of control.
    for (const p of H.peers) {
      const a0 = pos.get(p.a), b0 = pos.get(p.b);
      if (!a0 || !b0) continue;
      const [a, b] = a0.x <= b0.x ? [a0, b0] : [b0, a0];
      const dim = hover && !(hot.has(p.a) && hot.has(p.b));
      const sameRow = Math.abs(a.y - b.y) < 2;
      ctx.save();
      ctx.strokeStyle = C.labelDim;
      ctx.globalAlpha = dim ? 0.1 : 0.9;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      let lx, ly;
      if (sameRow) {
        // Centre-to-centre would run underneath the opaque boxes and vanish.
        // Bow the link just below the row so the whole span stays visible even
        // when the two parties are not adjacent in it.
        const dip = a.h / 2 + 9;
        ctx.moveTo(a.x + a.w / 2, a.y);
        ctx.quadraticCurveTo((a.x + b.x) / 2, a.y + dip, b.x - b.w / 2, b.y);
        lx = (a.x + b.x) / 2; ly = a.y + dip * 0.75;
      } else {
        ctx.moveTo(a.x + a.w / 2, a.y);
        ctx.lineTo(b.x - b.w / 2, b.y);
        lx = (a.x + b.x) / 2; ly = (a.y + b.y) / 2;
      }
      ctx.stroke();
      ctx.restore();
      if (hover && (hover === p.a || hover === p.b)) {
        labelText(ctx, p.type, lx, ly, '9px "IBM Plex Mono", monospace', C.labelDim, 'center');
      }
    }

    // Node boxes.
    for (const p of H.positions) {
      const n = p.node;
      const isCenter = n.id === state.centerId;
      const dim = hover && !hot.has(n.id);
      ctx.globalAlpha = dim ? 0.3 : 1;
      const x = p.x - p.w / 2, y = p.y - p.h / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(15,23,42,.16)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
      roundRect(ctx, x, y, p.w, p.h, 7);
      ctx.fillStyle = isCenter ? C.center : C.halo;
      ctx.fill();
      ctx.restore();
      roundRect(ctx, x, y, p.w, p.h, 7);
      ctx.lineWidth = isCenter ? 2 : 1.4;
      ctx.strokeStyle = isCenter ? C.centerRing : nodeColor(n);
      if (!n.inSnapshot) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Severity flag down the left edge.
      ctx.fillStyle = nodeColor(n);
      ctx.fillRect(x + 1.5, y + 3, 3, Math.max(4, p.h - 6));

      if (p.h >= 13) {
        ctx.font = `${isCenter ? 600 : 500} 11px "IBM Plex Sans", sans-serif`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = isCenter ? C.nodeStroke : C.label;
        let label = shortName(n.name);
        const maxW = p.w - 18;
        if (ctx.measureText(label).width > maxW) {
          while (label.length > 1 && ctx.measureText(label + '…').width > maxW) label = label.slice(0, -1);
          label += '…';
        }
        ctx.fillText(label, x + 10, p.y);
      }
      ctx.globalAlpha = 1;
    }
  }

  function neighborsOf(id) {
    const set = new Set();
    for (const e of state.data.edges) {
      if (e.source === id) set.add(e.target);
      if (e.target === id) set.add(e.source);
    }
    return set;
  }

  /* ---------- WebGL ---------- */
  const NODE_VS = 'attribute vec2 a_pos;attribute float a_size;attribute vec4 a_color;varying vec4 v_color;void main(){gl_Position=vec4(a_pos,0.0,1.0);gl_PointSize=a_size;v_color=a_color;}';
  const NODE_FS = 'precision mediump float;varying vec4 v_color;void main(){vec2 c=gl_PointCoord-0.5;float d=length(c);float edge=smoothstep(0.5,0.46,d);float inner=smoothstep(0.44,0.40,d);float ring=edge-inner;vec3 col=mix(v_color.rgb,vec3(1.0),ring);gl_FragColor=vec4(col,v_color.a*edge);}';
  const LINE_VS = 'attribute vec2 a_pos;attribute vec4 a_color;varying vec4 v_color;void main(){gl_Position=vec4(a_pos,0.0,1.0);v_color=a_color;}';
  const LINE_FS = 'precision mediump float;varying vec4 v_color;void main(){gl_FragColor=v_color;}';

  function compile(gl, type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function prog(gl, vs, fs) { const p = gl.createProgram(); gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }

  function getGL() {
    if (state.glCtx) return state.glCtx;
    if (state.glFailed) return null;
    try {
      const c = glCanvas();
      const gl = c.getContext('webgl', { premultipliedAlpha: false, antialias: true }) || c.getContext('experimental-webgl');
      if (!gl) throw new Error('no webgl');
      const nodeP = prog(gl, NODE_VS, NODE_FS);
      const lineP = prog(gl, LINE_VS, LINE_FS);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      state.glCtx = {
        gl,
        node: { p: nodeP, pos: gl.getAttribLocation(nodeP, 'a_pos'), size: gl.getAttribLocation(nodeP, 'a_size'), color: gl.getAttribLocation(nodeP, 'a_color'), buf: gl.createBuffer() },
        line: { p: lineP, pos: gl.getAttribLocation(lineP, 'a_pos'), color: gl.getAttribLocation(lineP, 'a_color'), buf: gl.createBuffer() },
      };
      return state.glCtx;
    } catch (e) { console.warn('WebGL init failed:', e.message); state.glFailed = true; return null; }
  }

  function blankGL() {
    const G = state.glCtx; if (!G) return;
    const { gl } = G; gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function drawGL(pos, layout, edges, hover, hoverNb, w, h, dpr) {
    const G = getGL(); if (!G) return false;
    const { gl } = G;
    const c = gl.canvas;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const clipX = (x) => (x / w) * 2 - 1;
    const clipY = (y) => 1 - (y / h) * 2;

    // Lines.
    const ld = [];
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue;
      const hot = hover && (hover === e.from || hover === e.to);
      const dim = hover && !hot;
      const [r, g, bl] = e.ownership ? RGB.own : RGB.edge;
      const al = dim ? 0.06 : (e.ownership ? 0.7 : 0.3);
      ld.push(clipX(a.x), clipY(a.y), r, g, bl, al, clipX(b.x), clipY(b.y), r, g, bl, al);
    }
    if (ld.length) {
      gl.useProgram(G.line.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.line.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ld), gl.DYNAMIC_DRAW);
      const stride = 6 * 4;
      gl.enableVertexAttribArray(G.line.pos); gl.vertexAttribPointer(G.line.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(G.line.color); gl.vertexAttribPointer(G.line.color, 4, gl.FLOAT, false, stride, 2 * 4);
      gl.drawArrays(gl.LINES, 0, ld.length / 6);
    }

    // Nodes.
    const nd = [];
    for (const p of layout) {
      const n = p.node;
      const isH = hover === n.id;
      const dim = hover && !isH && !hoverNb.has(n.id);
      const [r, g, bl] = nodeRGB(n);
      nd.push(clipX(p.x), clipY(p.y), p.r * 2 * dpr, r, g, bl, dim ? 0.28 : 1);
    }
    if (nd.length) {
      gl.useProgram(G.node.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.node.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nd), gl.DYNAMIC_DRAW);
      const stride = 7 * 4;
      gl.enableVertexAttribArray(G.node.pos); gl.vertexAttribPointer(G.node.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(G.node.size); gl.vertexAttribPointer(G.node.size, 1, gl.FLOAT, false, stride, 2 * 4);
      gl.enableVertexAttribArray(G.node.color); gl.vertexAttribPointer(G.node.color, 4, gl.FLOAT, false, stride, 3 * 4);
      gl.drawArrays(gl.POINTS, 0, nd.length / 7);
    }
    return true;
  }

  /* ---------- shared 2D helpers ---------- */
  function drawGuides(ctx, cx, cy, ringGap, depthMax) {
    ctx.save();
    ctx.setLineDash([2, 6]); ctx.strokeStyle = C.guide; ctx.lineWidth = 1;
    for (let d = 1; d <= depthMax; d++) { ctx.beginPath(); ctx.arc(cx, cy, ringGap * d, 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]); ctx.fillStyle = C.guideText; ctx.font = '10px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
    for (let d = 1; d <= depthMax; d++) ctx.fillText(`${d} hop`, cx, cy - ringGap * d - 6);
    ctx.restore();
  }

  function drawArrow(ctx, fromX, fromY, target, color) {
    const dx = target.x - fromX, dy = target.y - fromY;
    const ang = Math.atan2(dy, dx);
    const tipX = target.x - Math.cos(ang) * (target.r + 2), tipY = target.y - Math.sin(ang) * (target.r + 2);
    const s = 7;
    ctx.save(); ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - s * Math.cos(ang - 0.4), tipY - s * Math.sin(ang - 0.4));
    ctx.lineTo(tipX - s * Math.cos(ang + 0.4), tipY - s * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  function labelText(ctx, text, x, y, font, color, align) {
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = C.halo; ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Place labels beside the node on whichever side has room, clamped fully
  // inside the canvas (never cut off at an edge) and nudged vertically to avoid
  // overlapping already-placed labels (`placed` = shared box list, priority order).
  function drawLabel(ctx, p, cx, cy, w, h, isCenter, isHover, placed) {
    const maxChars = isCenter ? 34 : 22;
    const raw = p.node.name;
    const name = raw.length > maxChars ? raw.slice(0, maxChars - 1) + '…' : raw;
    const font = `${isCenter || isHover ? 600 : 400} ${isCenter ? 12 : 11}px "IBM Plex Sans", sans-serif`;
    const color = isCenter || isHover ? C.label : C.labelDim;
    ctx.font = font;
    const tw = ctx.measureText(name).width;
    const th = 14, pad = 6;

    let align, lx, baseY;
    if (isCenter) {
      align = 'center';
      lx = Math.max(pad + tw / 2, Math.min(w - pad - tw / 2, p.x));
      baseY = Math.min(h - 10, p.y + p.r + 15);
    } else {
      const gap = p.r + 6;
      if (p.x <= cx) { align = 'right'; lx = p.x - gap; if (lx - tw < pad) { align = 'left'; lx = p.x + gap; } }
      else { align = 'left'; lx = p.x + gap; if (lx + tw > w - pad) { align = 'right'; lx = p.x - gap; } }
      if (align === 'left' && lx + tw > w - pad) lx = w - pad - tw;
      if (align === 'right' && lx - tw < pad) lx = pad + tw;
      baseY = Math.max(12, Math.min(h - 12, p.y));
    }

    const boxAt = (y) => {
      const x = align === 'center' ? lx - tw / 2 : align === 'left' ? lx : lx - tw;
      return { x: x - 2, y: y - th / 2, w: tw + 4, h: th };
    };
    let ly = baseY;
    if (placed) {
      let tries = 0, step = 0;
      while (tries < 60 && placed.some((q) => rectsOverlap(boxAt(ly), q))) {
        tries++; step += 4;
        ly = baseY + ((tries % 2) ? step : -step);
        ly = Math.max(12, Math.min(h - 12, ly));
      }
      placed.push(boxAt(ly));
    }
    labelText(ctx, name, lx, ly, font, color, align);
  }

  // Draw labels in priority order (center, then highest weighted degree) so the
  // most important labels claim their spot first and others yield around them.
  function drawLabels(ctx, items, cx, cy, w, h, hover) {
    const placed = [];
    items.slice().sort((a, b) => {
      if (a.node.id === state.centerId) return -1;
      if (b.node.id === state.centerId) return 1;
      const ah = hover && (a.node.id === hover), bh = hover && (b.node.id === hover);
      if (ah !== bh) return ah ? -1 : 1;
      return b.node.weightedDegree - a.node.weightedDegree;
    }).forEach((p) => drawLabel(ctx, p, cx, cy, w, h, p.node.id === state.centerId, hover === p.node.id, placed));
  }

  function drawTooltip(ctx, p, w, h) {
    const n = p.node;
    const lines = [n.name, `${n.type}${n.inSnapshot ? ` · ID ${n.id}` : ' · unlisted'}`, n.list || '', (n.programs || []).length ? n.programs.join(', ') : '', `degree ${n.degree} · weighted ${n.weightedDegree}`].filter(Boolean);
    ctx.font = '11px "IBM Plex Sans", sans-serif';
    const bw = Math.min(280, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20);
    const bh = lines.length * 15 + 12;
    const half = p.w ? p.w / 2 : p.r; // boxes in the hierarchy view, circles in the radial one
    let bx = p.x + half + 10, by = p.y - bh / 2;
    if (bx + bw > w) bx = p.x - half - 10 - bw;
    if (by < 4) by = 4; if (by + bh > h - 4) by = h - 4 - bh;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5;
    ctx.fillStyle = C.tipBg; roundRect(ctx, bx, by, bw, bh, 9); ctx.fill(); ctx.restore();
    ctx.strokeStyle = C.tipBorder; ctx.lineWidth = 1; roundRect(ctx, bx, by, bw, bh, 9); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    lines.forEach((l, i) => { ctx.fillStyle = i === 0 ? C.tipText : C.tipDim; ctx.font = `${i === 0 ? 600 : 400} 11px "IBM Plex Sans", sans-serif`; ctx.fillText(l, bx + 11, by + 18 + i * 15); });
  }

  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  /* ---------- 2D full render (small/medium) ---------- */
  function draw2D(ctx, pos, layout, edges, cx, cy, w, h, hover, hoverNb) {
    ctx.lineCap = 'round';
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue;
      const hot = hover && (hover === e.from || hover === e.to);
      const dim = hover && !hot;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const bump = Math.min(26, len * 0.12);
      const ctrlX = mx - (dy / len) * bump, ctrlY = my + (dx / len) * bump;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(ctrlX, ctrlY, b.x, b.y);
      ctx.strokeStyle = e.ownership ? C.edgeOwn : C.edge;
      ctx.globalAlpha = dim ? 0.12 : (e.ownership ? 0.85 : 0.5);
      ctx.lineWidth = e.ownership ? 2.4 : 1.3; ctx.stroke(); ctx.globalAlpha = 1;
      if (!e.mutual && !dim) drawArrow(ctx, ctrlX, ctrlY, b, e.ownership ? C.edgeOwn : '#94A3B8');
      if (hot) labelText(ctx, e.types.join(' / '), (a.x + ctrlX + b.x) / 3, (a.y + ctrlY + b.y) / 3, '10px "IBM Plex Mono", monospace', C.labelDim, 'center');
    }
    for (const p of layout) {
      const n = p.node, isHover = hover === n.id, isCenter = n.id === state.centerId;
      const dim = hover && !isHover && !hoverNb.has(n.id);
      ctx.globalAlpha = dim ? 0.28 : 1;
      if (isCenter) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 8, 0, Math.PI * 2); ctx.fillStyle = C.centerHalo; ctx.fill(); }
      ctx.save(); ctx.shadowColor = 'rgba(15,23,42,.18)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = nodeColor(n); ctx.fill(); ctx.restore();
      ctx.lineWidth = isCenter ? 3 : 2; ctx.strokeStyle = isCenter ? C.centerRing : (n.inSnapshot ? C.nodeStroke : C.ext);
      if (!n.inSnapshot) ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      if (isHover) { ctx.lineWidth = 2; ctx.strokeStyle = C.ownStroke; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  }

  // The hierarchy is drawn in 2D only: it is at most a few hundred boxes, and
  // the WebGL path draws points, not labelled rectangles.
  // Height the hierarchy needs at full size, so draw() can grow the canvas and
  // let the stage scroll instead of scaling boxes below readability.
  function hierarchyNaturalHeight(w) {
    const { pairs, peers } = hierPairs();
    const level = assignLevels(pairs, peers);
    const counts = new Map();
    for (const [, l] of level) counts.set(l, (counts.get(l) || 0) + 1);
    if (!counts.size) return 0;
    const usableW = Math.max(HB.nodeW + HB.pad * 2, w - HB.pad * 2);
    const perRow = Math.max(1, Math.floor((usableW + HB.gapX) / (HB.nodeW + HB.gapX)));
    let total = 0;
    for (const n of counts.values()) {
      const rows = Math.max(1, Math.ceil(n / perRow));
      total += rows * HB.nodeH + (rows - 1) * HB.rowGap;
    }
    return total + (counts.size - 1) * HB.gapY + HB.pad + HB.padBottom;
  }

  function drawOwnershipView(ctx, w, h) {
    blankGL();
    const H = computeHierarchyLayout(w, h);
    state.layout = H.positions;
    state.hierarchy = H;

    const note = document.getElementById('graphViewNote');
    const badge = document.getElementById('graphRenderer');

    if (!H.pairs.length && !H.peers.length) {
      ctx.font = '13px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.labelDim;
      ctx.fillText('No relationships published for this party.', w / 2, h / 2 - 10);
      ctx.font = '11px "IBM Plex Sans", sans-serif';
      ctx.fillText('Nothing to place above or below it.', w / 2, h / 2 + 12);
      if (badge) badge.textContent = 'no relationships';
      if (note) { note.hidden = false; note.innerHTML = ''; note.textContent = 'This party has no listed relationships in the snapshot.'; }
      return;
    }

    drawHierarchy(ctx, H, w, h, state.hover);
    if (state.hover) {
      const p = state.layout.find((q) => q.node.id === state.hover);
      if (p) drawTooltip(ctx, p, w, h);
    }

    const links = H.pairs.length + H.peers.length;
    if (badge) badge.textContent = `${H.positions.length} entities · ${links} link${links === 1 ? '' : 's'}`;
    if (note) {
      note.hidden = false;
      note.innerHTML = '';
      const count = document.createElement('strong');
      count.className = 'graph-view-count';
      count.textContent = `${H.positions.length} entities · ${links} relationship${links === 1 ? '' : 's'}`;
      note.appendChild(count);
      // Say plainly how much of what is on screen the 50 Percent Rule reaches:
      // the diagram now draws support, agency and office links alongside
      // ownership, and only ownership carries the rule.
      const bits = [H.ownershipLinks
        ? `${H.ownershipLinks} of them ${H.ownershipLinks === 1 ? 'is an ownership link' : 'are ownership links'} (solid red) — only those drive the 50% Rule`
        : 'None of them is an ownership link, so the 50% Rule does not reach this network'];
      if (H.orphans) bits.push(`${H.orphans} part${H.orphans === 1 ? 'y is' : 'ies are'} not connected to the centre by any chain — see Radial`);
      note.appendChild(document.createTextNode(bits.join('. ') + '.'));
    }
  }

  /* ---------- orchestrator ---------- */
  function draw() {
    applyTheme();
    const canvas = cv();
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Size the canvas before measuring it: in the hierarchy view it may need to
    // be taller than the stage (which then scrolls).
    if (state.view === 'ownership' && state.data) {
      // Shrink to fit while the boxes stay readable; past that point grow the
      // canvas and scroll. On a desktop stage the whole chain still fits in one
      // view — losing that overview to a scrollbar would be a worse trade.
      const stage = canvas.parentElement;
      const need = hierarchyNaturalHeight(canvas.clientWidth || stage.clientWidth) * MIN_HIERARCHY_SCALE;
      canvas.style.height = Math.max(stage.clientHeight, Math.min(need, 8000)) + 'px';
    } else {
      canvas.style.height = '';
    }

    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (state.view === 'ownership') return drawOwnershipView(ctx, w, h);

    const layout = computeLayout(state.data, w, h);
    state.layout = layout;
    const pos = {}; layout.forEach((p) => (pos[p.node.id] = p));
    const { cx, cy, ringGap, depthMax } = state.geom;
    const edges = collapseEdges(state.data.edges);
    const hover = state.hover, hoverNb = hover ? neighborsOf(hover) : new Set();

    drawGuides(ctx, cx, cy, ringGap, depthMax);

    const useGL = layout.length > GL_MIN && !state.glFailed;

    if (useGL && drawGL(pos, layout, edges, hover, hoverNb, w, h, dpr)) {
      // Overlay extras the shaders don't draw: center halo + hover ring.
      const center = pos[state.centerId];
      if (center) { ctx.beginPath(); ctx.arc(center.x, center.y, center.r + 9, 0, Math.PI * 2); ctx.fillStyle = C.centerHalo; ctx.fill(); }
      if (hover && pos[hover]) { const p = pos[hover]; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2); ctx.strokeStyle = C.ownStroke; ctx.lineWidth = 2; ctx.stroke(); }
    } else {
      blankGL();
      draw2D(ctx, pos, layout, edges, cx, cy, w, h, hover, hoverNb);
    }

    // Shared label pass with a screen-size-aware budget: a phone can carry far
    // fewer readable labels than a desktop canvas.
    const budget = w < 560 ? 8 : 14;
    const showAll = layout.length <= (w < 560 ? 10 : 34);
    const topSet = new Set([...state.data.nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, budget).map((n) => n.id));
    const shown = layout.filter((p) => {
      const n = p.node;
      if (n.id === state.centerId) return true;
      if (hover) return n.id === hover || hoverNb.has(n.id);
      return showAll || topSet.has(n.id);
    });
    drawLabels(ctx, shown, cx, cy, w, h, hover);
    if (hover && pos[hover]) drawTooltip(ctx, pos[hover], w, h);

    const badge = document.getElementById('graphRenderer');
    if (badge) badge.textContent = `${layout.length} entities · ${edges.length} connections`;
  }

  function hitTest(mx, my) {
    // The hierarchy draws rectangles, the radial view circles.
    if (state.view === 'ownership') {
      for (const p of state.layout) {
        if (Math.abs(mx - p.x) <= p.w / 2 && Math.abs(my - p.y) <= p.h / 2 + 3) return p.node.id;
      }
      return null;
    }
    let best = null, bestD = Infinity;
    for (const p of state.layout) {
      const dx = mx - p.x, dy = my - p.y, d = dx * dx + dy * dy;
      if (d <= (p.r + 5) * (p.r + 5) && d < bestD) { best = p.node.id; bestD = d; }
    }
    return best;
  }

  function renderMetrics() {
    document.getElementById('graphMetrics').innerHTML = state.data.metrics.topByDegree.map((m) => `<li><span>${escapeHtml(m.name)}</span><span class="wd">${m.weightedDegree}</span></li>`).join('');
    document.getElementById('graphAudit').textContent = `center ${state.data.audit.center} · depth ${state.data.depth} · ${state.data.metrics.nodeCount} nodes / ${state.data.metrics.edgeCount} edges · ${state.data.metrics.ownershipEdges} ownership · ${new Date(state.data.audit.generatedAt).toLocaleString()}`;
    document.getElementById('graphSubtitle').textContent = `Ego network of ${state.data.center.name} · ${state.data.snapshot ? state.data.snapshot.source : ''}`;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Draw a failure into the stage rather than firing an alert() and leaving an
  // empty modal behind: a rate-limited or failed load used to look identical to
  // a party with no network at all, and the view controls silently did nothing
  // afterwards because there was no data to redraw.
  function drawLoadError(message) {
    const canvas = cv();
    canvas.style.height = '';
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    applyTheme();
    blankGL();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.label;
    ctx.font = '13px "IBM Plex Sans", sans-serif';
    ctx.fillText('Could not load the relationship network.', w / 2, h / 2 - 10);
    ctx.fillStyle = C.labelDim;
    ctx.font = '11px "IBM Plex Sans", sans-serif';
    ctx.fillText(message, w / 2, h / 2 + 12);
    const badge = document.getElementById('graphRenderer');
    if (badge) badge.textContent = 'unavailable';
  }

  async function load(id, depth) {
    let res;
    try {
      const r = await fetch(`api/graph/ego-network?id=${encodeURIComponent(id)}&depth=${depth}`);
      res = await r.json().catch(() => ({}));
      if (!r.ok || res.error) {
        const why = res.error || `server responded ${r.status}`;
        return drawLoadError(r.status === 429 ? `${why} — wait a minute and reopen.` : why);
      }
    } catch (e) {
      return drawLoadError(e.message);
    }
    state.data = res; state.depth = res.depth; state.centerId = res.center.id; state.hover = null;
    renderMetrics(); draw();
  }

  /*
   * Focus management for the dialog.
   *
   * It declares role="dialog" aria-modal="true", which promises keyboard users
   * that focus is inside it and cannot wander out. It was doing neither: focus
   * stayed on the body, so Tab walked the search form behind the backdrop —
   * invisible, unreachable by mouse, and still operable by keyboard. Remember
   * the trigger, move focus in on open, keep Tab inside, and hand focus back on
   * close so the user returns to the button they came from.
   */
  let lastFocus = null;
  const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function focusables() {
    return [...modal().querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  }

  function trapTab(e) {
    if (e.key !== 'Tab' || modal().hidden) return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open(id) {
    lastFocus = document.activeElement;
    modal().hidden = false;
    document.getElementById('graphTitle').textContent = 'Relationship network';
    setDepthButtons(2);
    setView('radial');
    load(id, 2);
    document.body.style.overflow = 'hidden';
    const close$ = document.getElementById('graphClose');
    if (close$) close$.focus();
  }

  function close() {
    modal().hidden = true;
    document.body.style.overflow = '';
    state.data = null;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  function setDepthButtons(d) { modal().querySelectorAll('.depth-toggle button').forEach((b) => b.classList.toggle('active', Number(b.dataset.depth) === d)); }

  function setView(view) {
    state.view = view;
    state.hover = null;
    modal().querySelectorAll('.view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    modal().classList.toggle('view-ownership', view === 'ownership');
    const title = document.getElementById('graphTitle');
    if (title) title.textContent = view === 'ownership' ? 'Relationship hierarchy' : 'Relationship network';
    const note = document.getElementById('graphViewNote');
    if (note && view !== 'ownership') { note.hidden = true; note.innerHTML = ''; }
    if (state.data) draw();
  }

  function wire() {
    const m = modal();
    m.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
    m.querySelectorAll('.depth-toggle button').forEach((b) => b.addEventListener('click', () => {
      if (!state.centerId) return; // first load still in flight
      setDepthButtons(Number(b.dataset.depth));
      load(state.centerId, Number(b.dataset.depth));
    }));
    m.querySelectorAll('.view-toggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    const canvas = cv();
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = id ? 'pointer' : 'default';
      if (id !== state.hover) { state.hover = id; draw(); }
    });
    canvas.addEventListener('mouseleave', () => { if (state.hover) { state.hover = null; draw(); } });
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (id && id !== state.centerId) { const n = state.data.nodes.find((x) => x.id === id); if (n && n.inSnapshot) load(id, state.depth); }
    });
    window.addEventListener('keydown', (e) => {
      if (m.hidden) return;
      if (e.key === 'Escape') close();
      else trapTab(e);
    });
    let rt; window.addEventListener('resize', () => { if (!m.hidden && state.data) { clearTimeout(rt); rt = setTimeout(draw, 100); } });
  }

  document.addEventListener('DOMContentLoaded', wire);
  window.OFACGraph = { open, redraw: () => { if (state.data && !modal().hidden) draw(); } };
})();
