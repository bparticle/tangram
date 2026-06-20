import {
  PIECES, PIECE_BY_ID, worldPoints, transformString, pointsString,
  centroid, overlaps, sub, dist, figureBounds
} from './shared.js';
import { getCustomLevels, saveCustomLevel, deleteCustomLevel } from './levels.js';

// A freeform tangram editor — no contact rules, no scramble. Drag pieces
// anywhere, rotate in 45° steps, snap corners to neighbours, then save the
// arrangement as a level. The game re-centres targets on load, so absolute
// position here doesn't matter — only the relative shape does.

const VERTEX_SNAP = 16;
const placements = {};
let selected = null;
let drag = null;
let board;

const TRAY = {
  mountain: [110, 120, 0], shadow: [330, 120, 0], reed: [520, 110, 45],
  stone: [110, 330, 0], bridge: [250, 330, 0], wing: [430, 330, 0], beak: [560, 330, 0]
};

export function mountBuilder(root) {
  PIECES.forEach((p) => { placements[p.id] = [...TRAY[p.id]]; });
  root.innerHTML = TEMPLATE;
  board = root.querySelector('#build-board');

  const layer = root.querySelector('#build-pieces');
  PIECES.forEach((p) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'piece build-piece');
    g.setAttribute('data-id', p.id);
    g.style.setProperty('--piece-color', p.color);
    g.innerHTML = `<polygon class="hit-area" points="${pointsString(p.shape)}"/><polygon class="piece-face" points="${pointsString(p.shape)}"/>`;
    g.addEventListener('pointerdown', (e) => beginDrag(e, p.id, g));
    layer.appendChild(g);
  });

  wire(root);
  refresh();
  renderSaved(root);
}

function clientToBoard(event) {
  const pt = board.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  return pt.matrixTransform(board.querySelector('#build-pieces').getScreenCTM().inverse());
}

function beginDrag(event, id, el) {
  event.preventDefault();
  event.stopPropagation();
  el.setPointerCapture(event.pointerId);
  selected = id;
  const p = clientToBoard(event);
  drag = { id, el, pointerId: event.pointerId, offset: sub([p.x, p.y], [placements[id][0], placements[id][1]]) };
  el.parentNode.appendChild(el); // bring to front
  refresh();
}

function moveDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const p = clientToBoard(event);
  placements[drag.id] = [p.x - drag.offset[0], p.y - drag.offset[1], placements[drag.id][2]];
  drag.el.setAttribute('transform', transformString(placements[drag.id]));
}

function endDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const id = drag.id;
  if (drag.el.hasPointerCapture?.(event.pointerId)) drag.el.releasePointerCapture(event.pointerId);
  drag = null;
  snapToNeighbours(id);
  refresh();
}

// Snap the dragged piece so one of its corners lands on a neighbour's corner.
function snapToNeighbours(id) {
  const me = worldPoints(PIECE_BY_ID[id], placements[id]);
  let best = null;
  let bestD = VERTEX_SNAP;
  for (const o of PIECES) {
    if (o.id === id) continue;
    const op = worldPoints(o, placements[o.id]);
    for (const v of me) for (const w of op) {
      const d = dist(v, w);
      if (d < bestD) { bestD = d; best = sub(w, v); }
    }
  }
  if (best) placements[id] = [placements[id][0] + best[0], placements[id][1] + best[1], placements[id][2]];
  else {
    // otherwise tidy to a 15px grid
    placements[id] = [Math.round(placements[id][0] / 15) * 15, Math.round(placements[id][1] / 15) * 15, placements[id][2]];
  }
}

function rotateSelected(delta) {
  if (!selected) return;
  const p = PIECE_BY_ID[selected];
  const place = placements[selected];
  const cl = centroid(p.shape);
  const r0 = place[2] * Math.PI / 180;
  const wc = [place[0] + cl[0] * Math.cos(r0) - cl[1] * Math.sin(r0), place[1] + cl[0] * Math.sin(r0) + cl[1] * Math.cos(r0)];
  const nr = ((place[2] + delta) % 360 + 360) % 360;
  const r1 = nr * Math.PI / 180;
  placements[selected] = [wc[0] - (cl[0] * Math.cos(r1) - cl[1] * Math.sin(r1)), wc[1] - (cl[0] * Math.sin(r1) + cl[1] * Math.cos(r1)), nr];
  snapToNeighbours(selected);
  refresh();
}

function overlapPairs() {
  const polys = PIECES.map((p) => worldPoints(p, placements[p.id]));
  const bad = [];
  for (let i = 0; i < polys.length; i += 1) for (let j = i + 1; j < polys.length; j += 1) {
    if (overlaps(polys[i], polys[j], 1.2)) bad.push(`${PIECES[i].id}/${PIECES[j].id}`);
  }
  return bad;
}

function currentTargets() {
  const t = {};
  PIECES.forEach((p) => { t[p.id] = placements[p.id].map((n) => Math.round(n * 1000) / 1000); });
  return t;
}

function refresh() {
  PIECES.forEach((p) => {
    const el = board.querySelector(`[data-id="${p.id}"]`);
    el.setAttribute('transform', transformString(placements[p.id]));
    el.classList.toggle('is-selected', selected === p.id);
  });
  // silhouette overlay on the build board
  const sil = board.querySelector('#build-silhouette');
  sil.innerHTML = PIECES.map((p) => `<polygon points="${pointsString(worldPoints(p, placements[p.id]))}"/>`).join('');

  const bad = overlapPairs();
  const status = document.querySelector('#build-status');
  if (bad.length) { status.textContent = `${bad.length} overlap${bad.length > 1 ? 's' : ''} — fix before saving`; status.className = 'build-status bad'; }
  else { status.textContent = 'Valid figure — no overlaps'; status.className = 'build-status ok'; }

  // preview thumbnail
  const b = figureBounds(placements);
  const pad = 16;
  document.querySelector('#build-preview').innerHTML =
    `<svg viewBox="${b.minX - pad} ${b.minY - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}" preserveAspectRatio="xMidYMid meet">${PIECES.map((p) => `<polygon points="${pointsString(worldPoints(p, placements[p.id]))}"/>`).join('')}</svg>`;

  document.querySelector('#build-json').value = JSON.stringify({ name: document.querySelector('#build-name').value || 'Untitled', targets: currentTargets() }, null, 0);
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'level'; }

function save(root) {
  const name = document.querySelector('#build-name').value.trim();
  if (!name) { flash('Name the level first'); document.querySelector('#build-name').focus(); return; }
  if (overlapPairs().length) { flash('Fix overlaps before saving'); return; }
  const id = `custom_${slug(name)}`;
  saveCustomLevel({ id, name, targets: currentTargets() });
  flash(`Saved “${name}” — play it from the game`);
  renderSaved(root);
}

function loadLevel(targets) {
  const b = figureBounds(targets);
  const ox = 360 - b.cx;
  const oy = 280 - b.cy;
  PIECES.forEach((p) => {
    const t = targets[p.id] || [0, 0, 0];
    placements[p.id] = [t[0] + ox, t[1] + oy, t[2]];
  });
  refresh();
}

function resetTray() {
  PIECES.forEach((p) => { placements[p.id] = [...TRAY[p.id]]; });
  selected = null;
  refresh();
}

function renderSaved(root) {
  const list = root.querySelector('#saved-list');
  const levels = getCustomLevels();
  if (!levels.length) { list.innerHTML = '<li class="empty">No custom levels yet.</li>'; return; }
  list.innerHTML = levels.map((l) => `<li><span>${l.name}</span><span class="row-actions"><button data-load="${l.id}">Load</button><button data-del="${l.id}" class="danger">Delete</button></span></li>`).join('');
  list.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => {
    const lvl = getCustomLevels().find((l) => l.id === b.dataset.load);
    if (lvl) { document.querySelector('#build-name').value = lvl.name; loadLevel(lvl.targets); }
  }));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { deleteCustomLevel(b.dataset.del); renderSaved(root); }));
}

let flashTimer;
function flash(msg) {
  const el = document.querySelector('#build-flash');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function wire(root) {
  window.addEventListener('pointermove', moveDrag, { passive: false });
  window.addEventListener('pointerup', endDrag);
  root.querySelector('#build-board').addEventListener('pointerdown', () => { selected = null; refresh(); });
  root.querySelector('#rotate-ccw').addEventListener('click', () => rotateSelected(-45));
  root.querySelector('#rotate-cw').addEventListener('click', () => rotateSelected(45));
  root.querySelector('#save-level').addEventListener('click', () => save(root));
  root.querySelector('#reset-tray').addEventListener('click', resetTray);
  root.querySelector('#build-name').addEventListener('input', refresh);
  root.querySelector('#copy-json').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.querySelector('#build-json').value);
    flash('JSON copied');
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '[') { e.preventDefault(); rotateSelected(-45); }
    if (e.key === ']') { e.preventDefault(); rotateSelected(45); }
  });
}

const TEMPLATE = `
  <div class="builder">
    <header class="build-head">
      <div class="brand"><span class="brand-mark">間</span><span class="brand-name">MA · Builder</span></div>
      <div class="build-status ok" id="build-status">Valid figure</div>
      <a class="text-button" href="#">← Back to game</a>
    </header>
    <div class="build-main">
      <div class="build-stage">
        <svg id="build-board" viewBox="0 0 720 560" role="group" aria-label="Freeform tangram builder">
          <defs>
            <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#e7e2d6" stroke-width="1"/></pattern>
          </defs>
          <rect width="720" height="560" fill="url(#grid)"/>
          <g id="build-silhouette" aria-hidden="true"></g>
          <g id="build-pieces"></g>
        </svg>
        <p class="build-tip">Drag pieces freely · corners snap to neighbours · <kbd>[</kbd><kbd>]</kbd> or the buttons rotate the selected piece 45°</p>
      </div>
      <aside class="build-panel">
        <label class="field"><span>Level name</span><input id="build-name" placeholder="e.g. Swan" autocomplete="off"/></label>
        <div class="build-rotate"><button class="ghost" id="rotate-ccw">⟲ 45°</button><button class="ghost" id="rotate-cw">45° ⟳</button></div>
        <div class="build-preview-wrap"><span class="eyebrow">Silhouette</span><div id="build-preview" class="build-preview"></div></div>
        <div class="build-actions"><button id="save-level">Save level</button><button class="ghost" id="reset-tray">Reset pieces</button></div>
        <div class="saved"><span class="eyebrow">Custom levels</span><ul id="saved-list"></ul></div>
        <label class="field"><span>Export JSON <button class="link" id="copy-json" type="button">copy</button></span><textarea id="build-json" rows="3" readonly></textarea></label>
      </aside>
    </div>
    <div id="build-flash" class="build-flash"></div>
  </div>
`;
