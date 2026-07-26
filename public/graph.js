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

  let state = { data: null, depth: 2, hover: null, layout: [], centerId: null, geom: null, glCtx: null, glFailed: false };

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
    let bx = p.x + p.r + 10, by = p.y - bh / 2;
    if (bx + bw > w) bx = p.x - p.r - 10 - bw;
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

  /* ---------- orchestrator ---------- */
  function draw() {
    applyTheme();
    const canvas = cv();
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

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

  async function load(id, depth) {
    const res = await fetch(`/api/graph/ego-network?id=${encodeURIComponent(id)}&depth=${depth}`).then((r) => r.json());
    if (res.error) { alert(res.error); return; }
    state.data = res; state.depth = res.depth; state.centerId = res.center.id; state.hover = null;
    renderMetrics(); draw();
  }

  function open(id) { modal().hidden = false; document.getElementById('graphTitle').textContent = 'Relationship network'; setDepthButtons(2); load(id, 2); document.body.style.overflow = 'hidden'; }
  function close() { modal().hidden = true; document.body.style.overflow = ''; state.data = null; }
  function setDepthButtons(d) { modal().querySelectorAll('.depth-toggle button').forEach((b) => b.classList.toggle('active', Number(b.dataset.depth) === d)); }

  function wire() {
    const m = modal();
    m.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
    m.querySelectorAll('.depth-toggle button').forEach((b) => b.addEventListener('click', () => {
      if (!state.centerId) return; // first load still in flight
      setDepthButtons(Number(b.dataset.depth));
      load(state.centerId, Number(b.dataset.depth));
    }));
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
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) close(); });
    let rt; window.addEventListener('resize', () => { if (!m.hidden && state.data) { clearTimeout(rt); rt = setTimeout(draw, 100); } });
  }

  document.addEventListener('DOMContentLoaded', wire);
  window.OFACGraph = { open, redraw: () => { if (state.data && !modal().hidden) draw(); } };
})();
