'use strict';

/*
 * Relationship networks page: the list from /api/networks, one network drawn
 * from /api/network.
 *
 * The drawing is a force-directed layout (Fruchterman-Reingold) computed here
 * in one pass before the first paint, from a deterministic start — the hub in
 * the middle, everyone else on a spiral by how strongly they are linked — so
 * the same network always comes out the same shape. Networks are capped
 * server-side at a few hundred parties (lib/networks splits anything larger),
 * which keeps the all-pairs repulsion affordable without an approximation.
 *
 * Colour says what a party is (entity, individual, vessel or aircraft), shape
 * repeats it for vessels and aircraft, and the members list beside the drawing
 * says it in words — identity is never colour alone. Display aid only.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString();
  const fmtDate = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const PAGE = 60;

  let all = [];
  let shown = PAGE;
  let current = null;   // network detail
  let view = null;      // { x, y, scale, tx, ty, fitted }
  let hover = -1, selected = -1;
  let colors = null;

  // ---- list ---------------------------------------------------------------
  const SORTS = {
    size: (a, b) => b.size - a.size || b.links - a.links,
    ownership: (a, b) => b.ownershipLinks - a.ownershipLinks || b.size - a.size,
    cross: (a, b) => b.crossListed - a.crossListed || b.size - a.size,
    newest: (a, b) => String(b.newest).localeCompare(String(a.newest)) || b.size - a.size,
  };

  function filtered() {
    const q = $('netFind').value.trim().toLowerCase();
    const sort = SORTS[$('netSort').value] || SORTS.size;
    const rows = q
      ? all.filter((n) => n.name.toLowerCase().includes(q) || n.programs.some(([p]) => p.toLowerCase().includes(q)))
      : all.slice();
    return rows.sort(sort);
  }

  function sortValue(n) {
    switch ($('netSort').value) {
      case 'ownership': return `${num(n.ownershipLinks)} ownership ${n.ownershipLinks === 1 ? 'link' : 'links'}`;
      case 'cross': return `${num(n.crossListed)} also listed elsewhere`;
      case 'newest': return n.newest ? `newest ${fmtDate(n.newest)}` : 'undated';
      default: return `${num(n.links)} links`;
    }
  }

  function renderList() {
    const rows = filtered();
    $('netCount').textContent = rows.length === all.length ? `(${num(all.length)})` : `(${num(rows.length)} of ${num(all.length)})`;
    $('netList').innerHTML = rows.slice(0, shown).map((n) => `
      <li><a class="net-item" href="#${encodeURIComponent(n.id)}"${current && current.id === n.id ? ' aria-current="true"' : ''}>
        <span class="net-item-name">${esc(n.name)}</span>
        <span class="net-item-meta"><strong>${num(n.size)}</strong> parties · ${esc(sortValue(n))}${n.programs[0] ? ` · ${esc(n.programs[0][0])}` : ''}</span>
        <span class="net-item-bar" aria-hidden="true"><span style="width:${Math.max(2, (n.size / (all[0] ? all[0].size : 1)) * 100)}%"></span></span>
      </a></li>`).join('') || '<li class="chart-empty">No network matches.</li>';
    $('netMore').hidden = rows.length <= shown;
  }

  // ---- detail -------------------------------------------------------------
  function typeKey(n) {
    if (!n.inSnapshot) return 'unlisted';
    const t = String(n.type || '').toLowerCase();
    if (t.includes('individual')) return 'individual';
    if (t.includes('vessel')) return 'vessel';
    if (t.includes('aircraft')) return 'aircraft';
    return 'entity';
  }
  const TYPE_LABEL = { entity: 'Entity', individual: 'Individual', vessel: 'Vessel', aircraft: 'Aircraft', unlisted: 'Not listed' };

  function chips(pairs, auth) {
    return pairs.map(([k, v]) => `<span class="tag${auth ? ` tag-auth auth-${esc(String(k).toLowerCase())}` : ''}">${esc(k)} <em>${num(v)}</em></span>`).join('');
  }

  function renderFacts(d) {
    $('netTitle').textContent = d.name;
    const split = d.component.networks > 1
      ? ` Part of a ${num(d.component.size)}-party group divided into ${num(d.component.networks)} networks.` : '';
    $('netSub').innerHTML = `Hub: <a href="entity.html?id=${encodeURIComponent(d.hubId)}">${esc(d.name)}</a>, the most strongly linked party.${esc(split)}`;
    const types = Object.entries(d.types).map(([k, v]) => `${num(v)} ${k.toLowerCase()}${v === 1 ? '' : /y$/i.test(k) ? '' : 's'}`).join(', ');
    $('netFacts').innerHTML = `
      <dl class="net-figs">
        <div><dt>Parties</dt><dd>${num(d.size)}</dd></div>
        <div><dt>Links</dt><dd>${num(d.links)}</dd></div>
        <div><dt>Ownership links</dt><dd>${num(d.ownershipLinks)}</dd></div>
        <div><dt>Also listed elsewhere</dt><dd>${num(d.crossListed)}</dd></div>
        <div><dt>Newest designation</dt><dd>${d.newest ? esc(fmtDate(d.newest)) : '—'}</dd></div>
      </dl>
      <p class="net-line"><span class="net-line-lbl">Members</span> ${esc(types)}${d.external ? ` · ${num(d.external)} named but not listed` : ''}</p>
      ${d.programs.length ? `<p class="net-line"><span class="net-line-lbl">Programs</span> ${chips(d.programs)}</p>` : ''}
      ${d.relationTypes.length ? `<p class="net-line"><span class="net-line-lbl">Links</span> ${chips(d.relationTypes)}</p>` : ''}
      ${d.alsoListedBy.length ? `<p class="net-line"><span class="net-line-lbl">Also listed by</span> ${chips(d.alsoListedBy, true)}</p>` : ''}
      ${d.countries.length ? `<p class="net-line"><span class="net-line-lbl">Countries</span> ${chips(d.countries)}</p>` : ''}`;
  }

  function renderMembers(d) {
    const order = d.nodes.map((n, i) => i).sort((a, b) => d.nodes[b].weight - d.nodes[a].weight || d.nodes[a].name.localeCompare(d.nodes[b].name));
    $('netMembersNote').textContent = `(${num(d.nodes.length)})`;
    $('netMembers').innerHTML = order.map((i) => {
      const n = d.nodes[i];
      const k = typeKey(n);
      return `<li class="net-member${i === selected ? ' is-selected' : ''}" data-i="${i}">
        <button type="button" class="net-member-btn" data-i="${i}" aria-pressed="${i === selected}">
          <span class="net-swatch sw-${k}" aria-hidden="true"></span>
          <span class="net-member-name">${esc(n.name)}</span>
          <span class="net-member-meta">${esc(TYPE_LABEL[k])} · ${num(degreeOf(i))} ${degreeOf(i) === 1 ? 'link' : 'links'}${n.alsoListedBy && n.alsoListedBy.length ? ` · also ${esc(n.alsoListedBy.join(', '))}` : ''}</span>
        </button>
        ${n.inSnapshot ? `<a class="net-member-open" href="entity.html?id=${encodeURIComponent(n.id)}" aria-label="Open record: ${esc(n.name)}">Record</a>` : ''}
      </li>`;
    }).join('');
    $('netNeighbours').innerHTML = d.neighbours.length ? `
      <h3 class="net-sub-h">Linked networks</h3>
      <p class="card-note">Networks of the same group with links to this one.</p>
      <ul class="net-neigh">${d.neighbours.map((x) => `<li><a href="#${encodeURIComponent(x.id)}">${esc(x.name)}</a> <span>${num(x.links)} ${x.links === 1 ? 'link' : 'links'}</span></li>`).join('')}</ul>` : '';
  }

  let degrees = null;
  const degreeOf = (i) => (degrees ? degrees[i] : 0);

  // ---- layout -------------------------------------------------------------
  function layout(d) {
    const n = d.nodes.length;
    const x = new Float64Array(n), y = new Float64Array(n);
    const order = d.nodes.map((_, i) => i).sort((a, b) => (a === d.hubIndex ? -1 : b === d.hubIndex ? 1 : d.nodes[b].weight - d.nodes[a].weight || a - b));
    order.forEach((i, r) => { const a = r * 2.399963; const rad = Math.sqrt(r + 0.5); x[i] = rad * Math.cos(a); y[i] = rad * Math.sin(a); });
    if (n < 2) return { x, y };
    const k = 1.1;
    let t = Math.sqrt(n) * 0.6;
    const iters = n > 250 ? 240 : 320;
    const cool = Math.pow(0.02 / t, 1 / iters);
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
      dx.fill(0); dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ex = x[i] - x[j], ey = y[i] - y[j];
          const d2 = ex * ex + ey * ey + 1e-4;
          const f = (k * k) / d2;
          dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
        }
      }
      for (const e of d.edges) {
        const ex = x[e.s] - x[e.t], ey = y[e.s] - y[e.t];
        const dist = Math.sqrt(ex * ex + ey * ey) + 1e-6;
        const f = (dist / k) * (e.ownership ? 1.3 : 1);
        dx[e.s] -= ex * f; dy[e.s] -= ey * f; dx[e.t] += ex * f; dy[e.t] += ey * f;
      }
      for (let i = 0; i < n; i++) {
        dx[i] -= x[i] * 0.04; dy[i] -= y[i] * 0.04; // gentle gravity keeps loose ends near
        const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
        const step = Math.min(len, t) / len;
        x[i] += dx[i] * step; y[i] += dy[i] * step;
      }
      t *= cool;
    }
    return { x, y };
  }

  // ---- drawing ------------------------------------------------------------
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    colors = {
      entity: v('--net-entity'), individual: v('--net-individual'), vessel: v('--net-vessel'),
      aircraft: v('--net-vessel'), unlisted: v('--net-unlisted'),
      edge: v('--net-edge'), edgeOwn: v('--net-edge-own'), surface: v('--color-surface'),
      text: v('--color-foreground'), muted: v('--color-muted-fg'), ring: v('--color-primary'),
    };
  }

  const radius = (n, i) => (i === current.hubIndex ? 11 : Math.min(10, 3.6 + Math.sqrt(n.weight || 1) * 1.05));

  function fit() {
    const cv = $('netCanvas');
    const w = cv.clientWidth, h = cv.clientHeight;
    const { x, y } = view;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < x.length; i++) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
    const pad = 36;
    const sx = (w - 2 * pad) / Math.max(1e-6, x1 - x0), sy = (h - 2 * pad) / Math.max(1e-6, y1 - y0);
    view.scale = Math.min(sx, sy, 90);
    view.tx = w / 2 - ((x0 + x1) / 2) * view.scale;
    view.ty = h / 2 - ((y0 + y1) / 2) * view.scale;
    view.fitted = true;
  }

  const sx = (i) => view.x[i] * view.scale + view.tx;
  const sy = (i) => view.y[i] * view.scale + view.ty;

  function shape(ctx, k, px, py, r) {
    ctx.beginPath();
    if (k === 'vessel') { ctx.moveTo(px, py - r * 1.25); ctx.lineTo(px + r * 1.25, py); ctx.lineTo(px, py + r * 1.25); ctx.lineTo(px - r * 1.25, py); ctx.closePath(); }
    else if (k === 'aircraft') { ctx.moveTo(px, py - r * 1.3); ctx.lineTo(px + r * 1.2, py + r * 0.9); ctx.lineTo(px - r * 1.2, py + r * 0.9); ctx.closePath(); }
    else ctx.arc(px, py, r, 0, Math.PI * 2);
  }

  function draw() {
    const cv = $('netCanvas');
    if (!current || !view) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const d = current;
    const focus = selected >= 0 ? selected : hover;
    const near = new Set();
    if (focus >= 0) { near.add(focus); for (const e of d.edges) { if (e.s === focus) near.add(e.t); if (e.t === focus) near.add(e.s); } }
    const dim = (i) => focus >= 0 && !near.has(i);

    // Links: ownership solid and darker, everything else fine and light.
    for (const pass of [false, true]) {
      for (const e of d.edges) {
        if (e.ownership !== pass) continue;
        const faded = focus >= 0 && !(e.s === focus || e.t === focus);
        ctx.globalAlpha = faded ? 0.12 : 1;
        ctx.strokeStyle = e.ownership ? colors.edgeOwn : colors.edge;
        ctx.lineWidth = e.ownership ? 1.6 : 1;
        ctx.beginPath(); ctx.moveTo(sx(e.s), sy(e.s)); ctx.lineTo(sx(e.t), sy(e.t)); ctx.stroke();
      }
    }
    // Parties, with a 2px surface ring so overlaps stay legible.
    for (let i = 0; i < d.nodes.length; i++) {
      const n = d.nodes[i], k = typeKey(n), r = radius(n, i);
      ctx.globalAlpha = dim(i) ? 0.2 : 1;
      shape(ctx, k, sx(i), sy(i), r);
      ctx.lineWidth = 2; ctx.strokeStyle = colors.surface; ctx.stroke();
      if (k === 'unlisted') { ctx.fillStyle = colors.surface; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = colors.unlisted; ctx.stroke(); }
      else { ctx.fillStyle = colors[k]; ctx.fill(); }
      if (i === d.hubIndex || i === focus) {
        ctx.lineWidth = 2; ctx.strokeStyle = i === focus ? colors.ring : colors.text;
        shape(ctx, k, sx(i), sy(i), r + 3.5); ctx.stroke();
      }
    }
    // Labels: the hub, the focus and its neighbours, and the most linked
    // parties when there is room for them — never every point.
    ctx.globalAlpha = 1;
    const labelled = new Set([d.hubIndex]);
    if (focus >= 0) for (const i of near) labelled.add(i);
    else {
      const room = Math.max(4, Math.min(14, Math.floor((w * h) / 60000)));
      d.nodes.map((n, i) => i).sort((a, b) => d.nodes[b].weight - d.nodes[a].weight).slice(0, room).forEach((i) => labelled.add(i));
    }
    ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const boxes = [];
    for (const i of [...labelled].sort((a, b) => (a === focus ? -1 : b === focus ? 1 : d.nodes[b].weight - d.nodes[a].weight))) {
      let text = d.nodes[i].name;
      if (text.length > 34) text = text.slice(0, 32) + '…';
      const tw = ctx.measureText(text).width;
      const px = sx(i) + radius(d.nodes[i], i) + 5, py = sy(i);
      const box = [px - 2, py - 8, px + tw + 2, py + 8];
      if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      boxes.push(box);
      ctx.lineWidth = 3.5; ctx.strokeStyle = colors.surface; ctx.lineJoin = 'round';
      ctx.strokeText(text, px, py);
      ctx.fillStyle = colors.text; ctx.fillText(text, px, py);
    }
  }

  function legend(d) {
    const present = new Set(d.nodes.map(typeKey));
    const items = ['entity', 'individual', 'vessel', 'aircraft', 'unlisted'].filter((k) => present.has(k))
      .map((k) => `<span><i class="net-swatch sw-${k}"></i>${TYPE_LABEL[k]}</span>`);
    items.push('<span><i class="net-line-key own"></i>Ownership link</span>', '<span><i class="net-line-key"></i>Other link</span>');
    $('netLegend').innerHTML = items.join('');
  }

  // ---- interaction --------------------------------------------------------
  function nodeAt(px, py) {
    if (!current) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < current.nodes.length; i++) {
      const dx = sx(i) - px, dy = sy(i) - py;
      const d2 = dx * dx + dy * dy;
      const r = radius(current.nodes[i], i) + 5; // hit target larger than the mark
      if (d2 < r * r && d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }

  function showTip(i, px, py) {
    const tip = $('netTip');
    if (i < 0) { tip.hidden = true; return; }
    const n = current.nodes[i];
    tip.innerHTML = `<strong>${esc(n.name)}</strong>
      <span>${esc(TYPE_LABEL[typeKey(n)])}${n.list ? ` · ${esc(n.list)}` : ''}</span>
      <span>${num(degreeOf(i))} ${degreeOf(i) === 1 ? 'link' : 'links'}${n.programs && n.programs.length ? ` · ${esc(n.programs.join(', '))}` : ''}</span>
      ${n.alsoListedBy && n.alsoListedBy.length ? `<span>Also listed by ${esc(n.alsoListedBy.join(', '))}</span>` : ''}
      ${n.datePublished ? `<span>Designated ${esc(fmtDate(n.datePublished))}</span>` : ''}`;
    tip.hidden = false;
    const stage = tip.parentElement.getBoundingClientRect();
    const left = Math.min(px + 14, stage.width - tip.offsetWidth - 8);
    const top = Math.min(py + 14, stage.height - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  function select(i, fromList) {
    selected = selected === i ? -1 : i;
    draw();
    for (const li of $('netMembers').querySelectorAll('.net-member')) {
      const on = Number(li.dataset.i) === selected;
      li.classList.toggle('is-selected', on);
      li.querySelector('button').setAttribute('aria-pressed', String(on));
      if (on && !fromList) li.scrollIntoView({ block: 'nearest' });
    }
  }

  function bindCanvas() {
    const cv = $('netCanvas');
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, tx: view && view.tx, ty: view && view.ty, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!view) return;
      const r = cv.getBoundingClientRect();
      if (drag) {
        const mx = e.clientX - drag.x, my = e.clientY - drag.y;
        if (Math.abs(mx) + Math.abs(my) > 3) drag.moved = true;
        if (drag.moved) { view.tx = drag.tx + mx; view.ty = drag.ty + my; view.fitted = false; $('netTip').hidden = true; draw(); return; }
      }
      const i = nodeAt(e.clientX - r.left, e.clientY - r.top);
      cv.style.cursor = i >= 0 ? 'pointer' : 'grab';
      if (i !== hover) { hover = i; draw(); }
      showTip(i, e.clientX - r.left, e.clientY - r.top);
    });
    cv.addEventListener('pointerup', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag && !drag.moved) {
        // A click on a party selects it (again: deselects); on empty space it clears.
        const i = nodeAt(e.clientX - r.left, e.clientY - r.top);
        if (i >= 0) select(i);
        else if (selected >= 0) select(selected);
      }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => { hover = -1; $('netTip').hidden = true; draw(); });
    cv.addEventListener('wheel', (e) => {
      if (!view) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    $('netZoomIn').addEventListener('click', () => zoom(1.3));
    $('netZoomOut').addEventListener('click', () => zoom(1 / 1.3));
    $('netFit').addEventListener('click', () => { if (view) { fit(); draw(); } });
    new ResizeObserver(() => { if (view) { if (view.fitted) fit(); draw(); } }).observe(cv);
    new MutationObserver(() => { readColors(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function zoom(f, px, py) {
    if (!view) return;
    const cv = $('netCanvas');
    const cx = px == null ? cv.clientWidth / 2 : px, cy = py == null ? cv.clientHeight / 2 : py;
    const s = Math.max(2, Math.min(400, view.scale * f));
    const real = s / view.scale;
    view.tx = cx - (cx - view.tx) * real; view.ty = cy - (cy - view.ty) * real;
    view.scale = s; view.fitted = false;
    draw();
  }

  // ---- loading ------------------------------------------------------------
  async function open(id, picked) {
    if (current && current.id === id) return;
    $('netTitle').textContent = 'Loading…';
    const { res, body } = await window.SS.getJson(`api/network?id=${encodeURIComponent(id)}`);
    if (!res.ok) { $('netTitle').textContent = 'Network not found'; $('netSub').textContent = body.error || ''; return; }
    current = body;
    hover = -1; selected = -1;
    degrees = new Int32Array(body.nodes.length);
    for (const e of body.edges) { degrees[e.s]++; degrees[e.t]++; }
    const { x, y } = layout(body);
    view = { x, y, scale: 1, tx: 0, ty: 0, fitted: true };
    $('netCanvas').setAttribute('aria-label', `Drawing of the ${body.name} network: ${body.nodes.length} parties and ${body.edges.length} links. The members list beside it gives the same parties as text.`);
    renderFacts(body);
    renderMembers(body);
    legend(body);
    fit();
    draw();
    renderList();
    document.title = `${body.name} network — Sanctions Search`;
    // Stacked layout: bring the drawing into view after a pick from the list.
    if (picked && window.matchMedia('(max-width: 1100px)').matches) document.querySelector('.net-view').scrollIntoView({ block: 'start' });
  }

  function route(e) {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = all.find((n) => n.id === id) ? id : (filtered()[0] || {}).id;
    if (target) open(target, !!e);
  }

  async function boot() {
    readColors();
    bindCanvas();
    $('netFind').addEventListener('input', () => { shown = PAGE; renderList(); });
    $('netSort').addEventListener('change', () => { shown = PAGE; renderList(); });
    $('netMore').addEventListener('click', () => { shown += PAGE; renderList(); });
    $('netMembers').addEventListener('click', (e) => {
      const b = e.target.closest('.net-member-btn');
      if (b) select(Number(b.dataset.i), true);
    });
    window.addEventListener('hashchange', route);

    const { res, body } = await window.SS.getJson('api/networks');
    if (!res.ok) { $('provenance').textContent = ''; $('loadError').hidden = false; return; }
    all = body.networks || [];
    const t = body.totals;
    const s = body.snapshot || {};
    $('provenance').innerHTML = `${s.isLive ? 'Live snapshot' : 'Offline sample'}` +
      (s.publicationId && s.publicationId !== 'unknown' ? ` · OFAC publication #${esc(s.publicationId)}` : '') +
      ` · ${num(t.links)} published relationships`;
    const stat = (n, label, sub) => `<div class="stat"><span class="stat-num">${esc(n)}</span><span class="stat-lbl">${esc(label)}</span>${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}</div>`;
    const big = t.split && t.split[0];
    $('headline').innerHTML =
      stat(num(t.networks), 'networks', `${num(t.pairs)} linked pairs besides`) +
      stat(num(t.parties), 'parties in them', 'listed parties only') +
      stat(num(all[0] ? all[0].size : 0), 'largest network', all[0] ? all[0].name : '') +
      stat(num(t.links), 'relationships', big ? `one ${num(big.size)}-party group split in ${num(big.networks)}` : 'published by OFAC');
    if (!all.length) {
      $('netList').innerHTML = '<li class="chart-empty">No networks in this snapshot.</li>';
      $('netTitle').textContent = 'No networks';
      return;
    }
    renderList();
    route(null);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
