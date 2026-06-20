import {
  PIECES, PIECE_BY_ID, ROT_SNAP, SNAP_VERTEX,
  sub, dot, cross, len, unit, dist, clamp, rotateVec,
  worldPoints, transformString, pointsString, edgesOf, overlaps, touches,
  pointOnSeg, segDist, normalizedAngleDelta, figureBounds, sameShape
} from './shared.js';
import { allLevels } from './levels.js';

// The contact engine is unchanged: one invariant (move continuously, never
// overlap, always stay in contact) yields slide-along-edge and pivot-around-
// corner for free. What's new here is the level shell around it — a silhouette
// to aim at, hints you opt into, and a generated-but-solvable scramble.

const BOARD = { minX: -4, maxX: 764, minY: -88, maxY: 484 };
const FIGURE_CENTER = [370, 160];

const pieces = PIECES;
const pieceById = (id) => PIECE_BY_ID[id];

let levels = [];
let levelIndex = 0;
let targets = {};
const placements = {};
let startPlacements = {};

let selected = null;
const selection = new Set();
let movesMade = 0;
let hintsOn = false;
let noticeTimer;
let isAnimating = false;
let dragState = null;
const history = [];

let pieceLayer; let goalLayer; let guideLayer;

export function mountGame(root) {
  levels = allLevels();
  root.innerHTML = TEMPLATE;
  pieceLayer = root.querySelector('#piece-layer');
  goalLayer = root.querySelector('#goal-layer');
  guideLayer = root.querySelector('#guide-layer');

  pieces.forEach((piece) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'piece');
    group.setAttribute('data-id', piece.id);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', piece.name);
    group.style.setProperty('--piece-color', piece.color);
    const points = pointsString(piece.shape);
    group.innerHTML = `<polygon class="hit-area" points="${points}"/><polygon class="piece-face" points="${points}"/>`;
    group.addEventListener('pointerdown', (event) => onPiecePointerDown(event, piece, group));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSelection(piece.id); render(); }
    });
    pieceLayer.appendChild(group);
  });

  wireControls(root);
  loadLevel(0);
}

// --- level loading + scramble ----------------------------------------------
function loadLevel(index) {
  levelIndex = (index + levels.length) % levels.length;
  const raw = levels[levelIndex].targets;
  const b = figureBounds(raw);
  const ox = FIGURE_CENTER[0] - b.cx;
  const oy = FIGURE_CENTER[1] - b.cy;
  targets = {};
  for (const p of pieces) {
    const t = raw[p.id] || [0, 0, 0];
    targets[p.id] = [t[0] + ox, t[1] + oy, ((t[2] % 360) + 360) % 360];
  }
  startPlacements = makeScramble(targets);
  pieces.forEach((p) => { placements[p.id] = [...startPlacements[p.id]]; });
  history.length = 0;
  movesMade = 0;
  selected = null;
  selection.clear();
  dragState = null;
  document.querySelector('#complete-screen').setAttribute('aria-hidden', 'true');
  renderSilhouette();
  renderAssignment();
  updateMasthead();
  render();
}

// Build a scramble by replaying random *legal* contact-moves from the solved
// figure. Every such move is reversible, so the start is guaranteed solvable.
function makeScramble(tg) {
  pieces.forEach((p) => { placements[p.id] = [...tg[p.id]]; });
  let made = 0;
  let tries = 0;
  while (made < 55 && tries < 600) { tries += 1; if (scrambleMove()) made += 1; }
  let guard = 0;
  while (isSolvedAgainst(tg) && guard < 60) { if (!scrambleMove()) break; guard += 1; }
  const snap = {};
  pieces.forEach((p) => { snap[p.id] = [...placements[p.id]]; });
  return snap;
}

function isSolvedAgainst(tg) {
  return pieces.every((p) => sameShape(worldPoints(p, placements[p.id]), worldPoints(p, tg[p.id])));
}

// Would the whole assembly still be one connected cluster if piece `id` moved
// to `place`? Scramble moves must preserve this so no piece is ever stranded
// (a stranded piece touches nothing and would be unmovable — unsolvable).
function connectedWith(id, place) {
  const polys = {};
  for (const o of pieces) polys[o.id] = o.id === id ? worldPoints(pieceById(id), place) : worldPoints(o, placements[o.id]);
  const seen = new Set([pieces[0].id]);
  const stack = [pieces[0].id];
  while (stack.length) {
    const c = stack.pop();
    for (const o of pieces) { if (seen.has(o.id)) continue; if (touches(polys[c], polys[o.id])) { seen.add(o.id); stack.push(o.id); } }
  }
  return seen.size === pieces.length;
}

function scrambleMove() {
  const order = pieces.slice().sort(() => Math.random() - 0.5);
  for (const p of order) {
    const hood = neighbourhood(p.id);
    const accept = (cand) => lawful(p.id, cand, hood) && connectedWith(p.id, cand);
    const moves = [];
    for (const corner of contactCorners(p.id)) {
      const lp = localPivot(p.id, corner);
      const r = placements[p.id][2];
      for (const d of [45, 90, -45, -90]) {
        const cand = placeFromPivot(corner, lp, r + d);
        if (accept(cand)) moves.push(cand);
      }
    }
    for (const rail of contactRails(p.id)) {
      for (const sign of [1, -1]) {
        const lim = slideLimit(p.id, sign, rail.dir, hood);
        for (const frac of [1, 0.5]) {
          const cand = placeAlong(placements[p.id], rail.dir, sign * lim * frac);
          if (lim * frac > 30 && accept(cand)) moves.push(cand);
        }
      }
    }
    if (moves.length) { placements[p.id] = moves[Math.floor(Math.random() * moves.length)]; return true; }
  }
  return false;
}

// --- engine (unchanged contact mechanics) ----------------------------------
function withinBounds(poly) {
  return poly.every(([x, y]) => x >= BOARD.minX && x <= BOARD.maxX && y >= BOARD.minY && y <= BOARD.maxY);
}

function neighbourhood(id) {
  const polys = [];
  for (const o of pieces) if (o.id !== id) polys.push(worldPoints(o, placements[o.id]));
  return polys;
}

function lawful(id, place, others) {
  const poly = worldPoints(pieceById(id), place);
  if (!withinBounds(poly)) return false;
  let contact = false;
  for (const op of others) {
    if (overlaps(poly, op)) return false;
    if (!contact && touches(poly, op)) contact = true;
  }
  return contact;
}

const lawfulNow = (id, place) => lawful(id, place, neighbourhood(id));

const segLen = (seg) => dist(seg[0], seg[1]);

function collinearOverlap(a, b, c, d) {
  const dab = sub(b, a);
  const L = len(dab);
  if (L < 1e-6) return null;
  const u = [dab[0] / L, dab[1] / L];
  if (Math.abs(cross(u, unit(sub(d, c)))) > 0.03) return null;
  if (Math.abs(cross(u, sub(c, a))) > 0.8) return null;
  const tc = dot(sub(c, a), u);
  const td = dot(sub(d, a), u);
  const lo = Math.max(0, Math.min(tc, td));
  const hi = Math.min(L, Math.max(tc, td));
  if (hi - lo <= 0.8) return null;
  return [[a[0] + u[0] * lo, a[1] + u[1] * lo], [a[0] + u[0] * hi, a[1] + u[1] * hi]];
}

function contactRails(id) {
  const poly = worldPoints(pieceById(id), placements[id]);
  const edgesP = edgesOf(poly);
  const found = [];
  for (const o of pieces) {
    if (o.id === id) continue;
    const op = worldPoints(o, placements[o.id]);
    const edgesN = edgesOf(op);
    for (const [a, b] of edgesP) for (const [c, d] of edgesN) {
      const seg = collinearOverlap(a, b, c, d);
      if (seg) found.push({ dir: unit(sub(b, a)), seg });
    }
    for (const v of poly) for (const [c, d] of edgesN) if (pointOnSeg(v, c, d)) found.push({ dir: unit(sub(d, c)), seg: [c, d] });
    for (const w of op) for (const [a, b] of edgesP) if (pointOnSeg(w, a, b)) found.push({ dir: unit(sub(b, a)), seg: [a, b] });
  }
  const byLine = new Map();
  for (const rail of found) {
    let ang = Math.atan2(rail.dir[1], rail.dir[0]);
    if (ang < 0) ang += Math.PI;
    const offset = -Math.sin(ang) * rail.seg[0][0] + Math.cos(ang) * rail.seg[0][1];
    const key = `${Math.round(ang * 40)}:${Math.round(offset)}`;
    const prev = byLine.get(key);
    if (!prev || segLen(rail.seg) > segLen(prev.seg)) byLine.set(key, rail);
  }
  return [...byLine.values()];
}

function contactCorners(id) {
  const poly = worldPoints(pieceById(id), placements[id]);
  const edgesP = edgesOf(poly);
  const pts = [];
  const add = (p) => { if (!pts.some((q) => dist(q, p) < 1)) pts.push(p); };
  for (const o of pieces) {
    if (o.id === id) continue;
    const op = worldPoints(o, placements[o.id]);
    const edgesN = edgesOf(op);
    for (const v of poly) if (op.some((w) => dist(v, w) < 0.8) || edgesN.some(([c, d]) => pointOnSeg(v, c, d))) add(v);
    for (const w of op) if (poly.some((v) => dist(v, w) < 0.8) || edgesP.some(([a, b]) => pointOnSeg(w, a, b))) add(w);
  }
  return pts;
}

const placeAlong = (start, dir, s) => [start[0] + s * dir[0], start[1] + s * dir[1], start[2]];

function localPivot(id, worldPivot) {
  const s0 = placements[id];
  const r = -s0[2] * Math.PI / 180;
  const c = Math.cos(r);
  const si = Math.sin(r);
  const dx = worldPivot[0] - s0[0];
  const dy = worldPivot[1] - s0[1];
  return [dx * c - dy * si, dx * si + dy * c];
}

function placeFromPivot(worldPivot, lp, deg) {
  const r = deg * Math.PI / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [worldPivot[0] - (lp[0] * c - lp[1] * s), worldPivot[1] - (lp[0] * s + lp[1] * c), deg];
}

function slideLimit(id, sign, dir, hood) {
  const start = placements[id];
  let last = 0;
  for (let t = 0.6; t <= 520; t += 0.6) {
    if (!lawful(id, placeAlong(start, dir, sign * t), hood)) break;
    last = t;
  }
  return last;
}

function rotateLimit(id, sign, worldPivot, lp, hood) {
  const start = placements[id];
  let last = 0;
  for (let a = 0.6; a <= 180; a += 0.6) {
    if (!lawful(id, placeFromPivot(worldPivot, lp, start[2] + sign * a), hood)) break;
    last = a;
  }
  return last;
}

function cornerCanRotate(id, pivot, hood) {
  const lp = localPivot(id, pivot);
  const r = placements[id][2];
  return lawful(id, placeFromPivot(pivot, lp, r + 3), hood) || lawful(id, placeFromPivot(pivot, lp, r - 3), hood);
}

// --- interaction -----------------------------------------------------------
function clientToBoard(event) {
  const svg = document.querySelector('#game-board');
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(pieceLayer.getScreenCTM().inverse());
}

function selectOnly(id) { selection.clear(); if (id) selection.add(id); selected = id; }
function toggleSelection(id) {
  if (selection.has(id)) {
    selection.delete(id);
    if (selected === id) selected = selection.size ? [...selection][selection.size - 1] : null;
  } else { selection.add(id); selected = id; }
}
function selectPiece(id) { if (isAnimating) return; selectOnly(id); render(); }

function onPiecePointerDown(event, piece, element) {
  if (isAnimating) return;
  event.stopPropagation();
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    toggleSelection(piece.id);
    render();
    return;
  }
  if (selection.size >= 2 && selection.has(piece.id)) beginGroupDrag(event, element);
  else { selectOnly(piece.id); beginDrag(event, piece, element); }
}

function beginDrag(event, piece, element) {
  if (isAnimating) return;
  event.preventDefault();
  element.setPointerCapture(event.pointerId);
  selected = piece.id;
  const grab = clientToBoard(event);
  const grabPoint = [grab.x, grab.y];
  const corners = contactCorners(piece.id);
  const rails = contactRails(piece.id);
  if (!corners.length && !rails.length) {
    dragState = { pointerId: event.pointerId, element, piece, locked: true };
    element.classList.add('is-blocked');
    navigator.vibrate?.(12);
    render();
    return;
  }
  dragState = {
    pointerId: event.pointerId, element, piece, mode: 'pending',
    hood: neighbourhood(piece.id), rails, corners, grab: grabPoint,
    start: [...placements[piece.id]], current: [...placements[piece.id]], moved: 0
  };
  render();
}

function decideGesture(d, u, point) {
  const grab = d.grab;
  const pivot = d.corners.length ? d.corners.slice().sort((a, b) => dist(a, grab) - dist(b, grab))[0] : null;
  const startSlide = (rail) => {
    d.mode = 'slide'; d.dir = rail.dir; d.rail = rail;
    d.negLimit = slideLimit(d.piece.id, -1, rail.dir, d.hood);
    d.posLimit = slideLimit(d.piece.id, 1, rail.dir, d.hood);
  };
  const startRotate = (pv) => {
    d.mode = 'rotate'; d.pivot = pv; d.lp = localPivot(d.piece.id, pv);
    d.startAngle = Math.atan2(point[1] - pv[1], point[0] - pv[0]);
    d.negLimit = rotateLimit(d.piece.id, -1, pv, d.lp, d.hood);
    d.posLimit = rotateLimit(d.piece.id, 1, pv, d.lp, d.hood);
  };
  const bestRail = () => {
    let best = null; let bestScore = -1;
    for (const r of d.rails) {
      const score = Math.abs(dot(u, r.dir)) * (segDist(grab, r.seg[0], r.seg[1]) < 55 ? 1 : 0.001);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  };
  if (pivot && dist(pivot, grab) <= 20) {
    startRotate(pivot);
    if (d.negLimit < 0.5 && d.posLimit < 0.5) { const rail = bestRail(); if (rail) startSlide(rail); }
  } else {
    const rail = bestRail();
    if (rail) startSlide(rail);
    else if (pivot) startRotate(pivot);
  }
  render();
}

function beginGroupDrag(event, element) {
  event.preventDefault();
  element.setPointerCapture(event.pointerId);
  const grab = clientToBoard(event);
  const members = [...selection];
  const starts = {};
  members.forEach((id) => { starts[id] = [...placements[id]]; });
  const staticPolys = pieces.filter((p) => !selection.has(p.id)).map((p) => worldPoints(p, placements[p.id]));
  dragState = { pointerId: event.pointerId, element, type: 'group', members, starts, staticPolys, grab: [grab.x, grab.y], delta: [0, 0], moved: 0 };
  render();
}

function groupValid(delta, d) {
  let contact = d.staticPolys.length === 0;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(pieceById(id), [s[0] + delta[0], s[1] + delta[1], s[2]]);
    if (!withinBounds(poly)) return false;
    for (const sp of d.staticPolys) {
      if (overlaps(poly, sp)) return false;
      if (!contact && touches(poly, sp)) contact = true;
    }
  }
  return contact;
}

function marchGroup(d, desired) {
  let cur = d.delta;
  for (let i = 0; i < 280; i += 1) {
    const toGoal = sub(desired, cur);
    const D = len(toGoal);
    if (D < 0.4) break;
    const step = Math.min(2, D);
    const u = [toGoal[0] / D, toGoal[1] / D];
    let advanced = false;
    for (const deg of [0, 12, -12, 25, -25, 40, -40, 58, -58, 75, -75]) {
      const dir = deg === 0 ? u : rotateVec(u, deg * Math.PI / 180);
      const cand = [cur[0] + dir[0] * step, cur[1] + dir[1] * step];
      if (groupValid(cand, d)) { cur = cand; advanced = true; break; }
    }
    if (!advanced) break;
  }
  return cur;
}

function groupRails(members) {
  const set = new Set(members);
  const found = [];
  for (const id of members) {
    const eP = edgesOf(worldPoints(pieceById(id), placements[id]));
    for (const o of pieces) {
      if (set.has(o.id)) continue;
      const eN = edgesOf(worldPoints(o, placements[o.id]));
      for (const [a, b] of eP) for (const [c, e] of eN) { const seg = collinearOverlap(a, b, c, e); if (seg) found.push(seg); }
    }
  }
  const byLine = new Map();
  for (const seg of found) {
    const dir = unit(sub(seg[1], seg[0]));
    let ang = Math.atan2(dir[1], dir[0]); if (ang < 0) ang += Math.PI;
    const off = -Math.sin(ang) * seg[0][0] + Math.cos(ang) * seg[0][1];
    const key = `${Math.round(ang * 40)}:${Math.round(off)}`;
    const prev = byLine.get(key);
    if (!prev || segLen(seg) > segLen(prev)) byLine.set(key, seg);
  }
  return [...byLine.values()];
}

function groupCorners(members) {
  const set = new Set(members);
  const pts = [];
  const add = (p) => { if (!pts.some((q) => dist(q, p) < 1)) pts.push(p); };
  for (const id of members) {
    const poly = worldPoints(pieceById(id), placements[id]);
    const eP = edgesOf(poly);
    for (const o of pieces) {
      if (set.has(o.id)) continue;
      const op = worldPoints(o, placements[o.id]);
      const eN = edgesOf(op);
      for (const v of poly) if (op.some((w) => dist(v, w) < 0.8) || eN.some(([c, d]) => pointOnSeg(v, c, d))) add(v);
      for (const w of op) if (poly.some((v) => dist(v, w) < 0.8) || eP.some(([a, b]) => pointOnSeg(w, a, b))) add(w);
    }
  }
  return pts;
}

function applyGroupTransforms(d) {
  for (const id of d.members) {
    const s = d.starts[id];
    pieceLayer.querySelector(`[data-id="${id}"]`).setAttribute('transform', transformString([s[0] + d.delta[0], s[1] + d.delta[1], s[2]]));
  }
}

function snapGroup(d) {
  let best = null;
  let bestDelta = SNAP_VERTEX;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(pieceById(id), [s[0] + d.delta[0], s[1] + d.delta[1], s[2]]);
    for (const v of poly) for (const sp of d.staticPolys) for (const w of sp) {
      const off = sub(w, v);
      const dd = len(off);
      if (dd >= bestDelta) continue;
      const cand = [d.delta[0] + off[0], d.delta[1] + off[1]];
      if (groupValid(cand, d)) { bestDelta = dd; best = cand; }
    }
  }
  if (best) d.delta = best;
}

function updateDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (dragState.locked) return;
  const board = clientToBoard(event);
  const point = [board.x, board.y];
  if (dragState.type === 'group') {
    dragState.delta = marchGroup(dragState, sub(point, dragState.grab));
    dragState.moved = len(dragState.delta);
    applyGroupTransforms(dragState);
    updateDragDock();
    return;
  }
  if (dragState.mode === 'pending') {
    const drag = sub(point, dragState.grab);
    if (len(drag) < 5) return;
    decideGesture(dragState, unit(drag), point);
    if (dragState.mode === 'pending') return;
  }
  if (dragState.mode === 'slide') {
    const s = clamp(dot(sub(point, dragState.grab), dragState.dir), -dragState.negLimit, dragState.posLimit);
    dragState.moved = Math.abs(s);
    dragState.current = placeAlong(dragState.start, dragState.dir, s);
  } else {
    const angle = Math.atan2(point[1] - dragState.pivot[1], point[0] - dragState.pivot[0]);
    const deg = clamp(normalizedAngleDelta(angle - dragState.startAngle) * 180 / Math.PI, -dragState.negLimit, dragState.posLimit);
    dragState.moved = Math.abs(deg);
    dragState.current = placeFromPivot(dragState.pivot, dragState.lp, dragState.start[2] + deg);
  }
  dragState.element.setAttribute('transform', transformString(dragState.current));
  updateDragDock();
}

function snapRotation(d, place) {
  const snapped = Math.round(place[2] / ROT_SNAP) * ROT_SNAP;
  if (snapped >= d.start[2] - d.negLimit - 0.01 && snapped <= d.start[2] + d.posLimit + 0.01) {
    const candidate = placeFromPivot(d.pivot, d.lp, snapped);
    if (lawful(d.piece.id, candidate, d.hood)) return candidate;
  }
  return place;
}

function snapSlide(d, place) {
  const dir = d.dir;
  const s = dot(sub(place, d.start), dir);
  const moving = worldPoints(pieceById(d.piece.id), place);
  let bestS = s;
  let bestDelta = SNAP_VERTEX;
  for (const op of d.hood) for (const w of op) for (const v of moving) {
    const diff = sub(w, v);
    if (Math.abs(cross(dir, diff)) > SNAP_VERTEX) continue;
    const along = dot(diff, dir);
    if (Math.abs(along) >= bestDelta) continue;
    const sCand = s + along;
    if (sCand < -d.negLimit - 0.01 || sCand > d.posLimit + 0.01) continue;
    if (lawful(d.piece.id, placeAlong(d.start, dir, sCand), d.hood)) { bestDelta = Math.abs(along); bestS = sCand; }
  }
  return placeAlong(d.start, dir, bestS);
}

async function finishDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const d = dragState;
  dragState = null;
  if (d.element.hasPointerCapture?.(event.pointerId)) d.element.releasePointerCapture(event.pointerId);
  d.element.classList.remove('is-blocked');

  if (d.type === 'group') {
    snapGroup(d);
    if (len(d.delta) > 0.5 && groupValid(d.delta, d)) {
      history.push(snapshot());
      for (const id of d.members) { const s = d.starts[id]; placements[id] = [s[0] + d.delta[0], s[1] + d.delta[1], s[2]]; }
      movesMade += 1;
      render();
      if (solved()) window.setTimeout(showComplete, 420);
      else showNotice(`Moved ${d.members.length} pieces together.`);
    } else render();
    return;
  }

  if (d.locked) { selected = d.piece.id; render(); return; }

  let target = d.current;
  if (d.mode === 'rotate') target = snapRotation(d, target);
  else if (d.mode === 'slide' && d.dir) target = snapSlide(d, target);

  const before = placements[d.piece.id];
  const changed = dist(target, before) > 0.5 || Math.abs(target[2] - before[2]) > 0.1;
  if (changed && lawful(d.piece.id, target, d.hood)) {
    history.push(snapshot());
    isAnimating = true;
    document.querySelector('#action-dock').innerHTML = `<span class="pulse-dot"></span><span><strong>Settling</strong><small>Contact path stays clear</small></span>`;
    await animateToTransform(d.element, d.current, target, 170);
    placements[d.piece.id] = target;
    movesMade += 1;
    selected = d.piece.id;
    isAnimating = false;
    render();
    if (solved()) window.setTimeout(showComplete, 420);
    else showNotice(d.mode === 'rotate' ? 'Pivoted on a shared corner.' : 'Slid along the contact edge.');
  } else {
    d.element.setAttribute('transform', transformString(before));
    selected = d.piece.id;
    render();
  }
}

function cancelDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  dragState.element?.classList.remove('is-blocked');
  dragState = null;
  render();
}

const easeOutQuint = (v) => 1 - Math.pow(1 - v, 5);
async function animateToTransform(element, from, to, duration) {
  await new Promise((resolve) => {
    const started = performance.now();
    function frame(now) {
      const raw = Math.min(1, (now - started) / duration);
      const p = easeOutQuint(raw);
      element.setAttribute('transform', transformString([from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p, from[2] + (to[2] - from[2]) * p]));
      if (raw < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function keyRotate(sign) {
  if (!selected || isAnimating || selection.size > 1) return;
  const corners = contactCorners(selected);
  if (!corners.length) { showNotice('No shared corner to pivot on.'); return; }
  const hood = neighbourhood(selected);
  const pivot = corners[0];
  const lp = localPivot(selected, pivot);
  const start = placements[selected];
  const target = (Math.round(start[2] / ROT_SNAP) + sign) * ROT_SNAP;
  const candidate = placeFromPivot(pivot, lp, target);
  if (!lawful(selected, candidate, hood)) { showNotice('That turn is blocked.'); return; }
  history.push(snapshot());
  placements[selected] = candidate;
  movesMade += 1;
  render();
  if (solved()) window.setTimeout(showComplete, 420);
  else showNotice('Pivoted on a shared corner.');
}

// --- win / state -----------------------------------------------------------
const pieceSolved = (piece) => sameShape(worldPoints(piece, placements[piece.id]), worldPoints(piece, targets[piece.id]));
const solved = () => pieces.every(pieceSolved);

function snapshot() {
  const map = {};
  pieces.forEach((p) => { map[p.id] = [...placements[p.id]]; });
  return map;
}

function undo() {
  if (!history.length || isAnimating) return;
  const prev = history.pop();
  pieces.forEach((p) => { placements[p.id] = [...prev[p.id]]; });
  movesMade += 1;
  render();
  showNotice('One move reversed.');
}

function reset() {
  if (isAnimating) return;
  pieces.forEach((p) => { placements[p.id] = [...startPlacements[p.id]]; });
  history.length = 0;
  movesMade = 0;
  selected = null;
  selection.clear();
  dragState = null;
  document.querySelector('#complete-screen').setAttribute('aria-hidden', 'true');
  render();
  showNotice('Scramble restored.');
}

// --- rendering -------------------------------------------------------------
function renderSilhouette() {
  goalLayer.innerHTML = pieces.map((p) => `<polygon class="silhouette" points="${pointsString(worldPoints(p, targets[p.id]))}"/>`).join('');
}

function renderAssignment() {
  const b = figureBounds(targets);
  const pad = 16;
  const vb = `${b.minX - pad} ${b.minY - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
  // Default: one solid silhouette (stroke == fill hides the seams between
  // pieces). With hints on, reveal the piece-by-piece layout in full colour.
  const polys = pieces.map((p) => {
    const pts = pointsString(worldPoints(p, targets[p.id]));
    return hintsOn
      ? `<polygon points="${pts}" fill="${p.color}" stroke="#fff" stroke-width="1"/>`
      : `<polygon points="${pts}" fill="#33352c" stroke="#33352c" stroke-width="1.6" stroke-linejoin="round"/>`;
  }).join('');
  document.querySelector('#goal-thumb').innerHTML = `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${polys}</svg>`;
  document.querySelector('#assignment-name').textContent = levels[levelIndex].name;
}

function updateMasthead() {
  document.querySelector('#level-name').textContent = levels[levelIndex].name;
  document.querySelector('#level-count').textContent = `${String(levelIndex + 1).padStart(2, '0')} / ${String(levels.length).padStart(2, '0')}`;
}

function renderGuide() {
  guideLayer.innerHTML = '';
  if (!hintsOn) return;
  if (dragState?.locked || dragState?.type === 'group') return;
  if (selection.size >= 2) {
    const members = [...selection];
    groupRails(members).forEach(([[x1, y1], [x2, y2]]) => {
      guideLayer.insertAdjacentHTML('beforeend', `<line class="available-edge-halo is-engaged" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="available-edge is-engaged" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    });
    groupCorners(members).forEach(([cx, cy]) => guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-point" cx="${cx}" cy="${cy}" r="4"/>`));
    return;
  }
  if (selection.size !== 1) return;
  if (dragState?.mode === 'rotate') {
    const [cx, cy] = dragState.pivot;
    guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-ring" cx="${cx}" cy="${cy}" r="26"/><circle class="pivot-point" cx="${cx}" cy="${cy}" r="5"/>`);
    return;
  }
  const rails = contactRails(selected);
  const corners = contactCorners(selected);
  const sliding = dragState?.mode === 'slide';
  const activeKey = dragState?.rail ? `${dragState.rail.seg[0]}|${dragState.rail.seg[1]}` : null;
  rails.forEach((rail) => {
    const [[x1, y1], [x2, y2]] = rail.seg;
    const engaged = !sliding || activeKey === `${rail.seg[0]}|${rail.seg[1]}`;
    const klass = engaged ? ' is-engaged' : '';
    guideLayer.insertAdjacentHTML('beforeend', `<line class="available-edge-halo${klass}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="available-edge${klass}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  });
  if (!sliding) {
    const hood = neighbourhood(selected);
    corners.forEach((corner) => {
      const [cx, cy] = corner;
      if (cornerCanRotate(selected, corner, hood)) guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-ring" cx="${cx}" cy="${cy}" r="13"/><circle class="pivot-point" cx="${cx}" cy="${cy}" r="4.5"/>`);
      else guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-point" cx="${cx}" cy="${cy}" r="3" opacity="0.5"/>`);
    });
  }
}

function updateDragDock() {
  const dock = document.querySelector('#action-dock');
  if (!dragState || dragState.locked) return;
  if (dragState.type === 'group') {
    dock.innerHTML = `<span class="drag-meter"><i style="transform:scaleX(${Math.min(1, dragState.moved / 140)})"></i></span><span><strong>MOVE GROUP ${Math.round(dragState.moved)}px</strong><small>${dragState.members.length} pieces · release to set</small></span>`;
  } else if (dragState.mode === 'pending') {
    dock.innerHTML = `<span><strong>${pieceById(dragState.piece.id).name}</strong><small>Drag a face to slide · arc a corner to rotate</small></span>`;
  } else if (dragState.mode === 'slide') {
    const span = Math.max(1, dragState.posLimit, dragState.negLimit);
    dock.innerHTML = `<span class="drag-meter"><i style="transform:scaleX(${Math.min(1, dragState.moved / span)})"></i></span><span><strong>SLIDE ${Math.round(dragState.moved)}px</strong><small>Release to set</small></span>`;
  } else {
    const span = Math.max(1, dragState.posLimit + dragState.negLimit);
    dock.innerHTML = `<span class="drag-meter"><i style="transform:scaleX(${Math.min(1, dragState.moved / span)})"></i></span><span><strong>ROTATE ${Math.round(dragState.moved)}°</strong><small>Snaps to 45°</small></span>`;
  }
}

function render() {
  const driven = dragState?.locked ? null
    : dragState?.type === 'group' ? new Set(dragState.members)
    : dragState ? new Set([dragState.piece.id]) : null;
  document.querySelectorAll('.piece').forEach((element) => {
    const piece = pieceById(element.dataset.id);
    if (!driven || !driven.has(piece.id)) element.setAttribute('transform', transformString(placements[piece.id]));
    element.classList.toggle('is-selected', selection.has(piece.id));
    element.classList.toggle('is-solved', pieceSolved(piece));
    element.setAttribute('aria-pressed', String(selection.has(piece.id)));
  });
  selection.forEach((id) => { const front = pieceLayer.querySelector(`[data-id="${id}"]`); if (front) pieceLayer.appendChild(front); });
  renderGuide();
  const dock = document.querySelector('#action-dock');
  if (isAnimating) dock.innerHTML = `<span class="pulse-dot"></span><span><strong>Settling</strong><small>Contact path stays clear</small></span>`;
  else if (dragState?.locked) dock.innerHTML = `<span class="locked-mark">×</span><span><strong>NO CONTACT</strong><small>This piece touches nothing to ride</small></span>`;
  else if (dragState) updateDragDock();
  else if (selection.size >= 2) dock.innerHTML = `<span><strong>GROUP · ${selection.size} pieces</strong><small>Drag any to move together · shift-click to adjust</small></span>`;
  else if (selected) dock.innerHTML = `<span><strong>${pieceById(selected).name}</strong><small>Drag to slide · shift-click to group · Hint for guides</small></span>`;
  else dock.innerHTML = '';
  const solvedCount = pieces.filter(pieceSolved).length;
  const percent = Math.round((solvedCount / pieces.length) * 100);
  document.querySelector('#progress-number').textContent = `${String(percent).padStart(2, '0')}%`;
  document.querySelector('#progress-bar').style.transform = `scaleX(${percent / 100})`;
  document.querySelector('#move-count').textContent = String(movesMade).padStart(2, '0');
  document.querySelector('#undo-button').disabled = history.length === 0 || isAnimating;
}

function showNotice(message) {
  const notice = document.querySelector('#notice');
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.add('is-visible');
  noticeTimer = setTimeout(() => notice.classList.remove('is-visible'), 2600);
}

function showComplete() {
  const screen = document.querySelector('#complete-screen');
  document.querySelector('#final-moves').textContent = movesMade;
  document.querySelector('#complete-name').textContent = levels[levelIndex].name;
  screen.setAttribute('aria-hidden', 'false');
  screen.querySelector('button').focus();
}

function setHints(on) {
  hintsOn = on;
  const btn = document.querySelector('#hint-button');
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  render();
}

function wireControls(root) {
  root.querySelector('#undo-button').addEventListener('click', undo);
  root.querySelector('#reset-button').addEventListener('click', reset);
  root.querySelector('#hint-button').addEventListener('click', () => setHints(!hintsOn));
  root.querySelector('#play-again').addEventListener('click', reset);
  root.querySelector('#next-level').addEventListener('click', () => loadLevel(levelIndex + 1));
  root.querySelector('#prev-button').addEventListener('click', () => loadLevel(levelIndex - 1));
  root.querySelector('#next-button').addEventListener('click', () => loadLevel(levelIndex + 1));

  window.addEventListener('pointermove', updateDrag, { passive: false });
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('pointercancel', cancelDrag);

  root.querySelector('#game-board').addEventListener('pointerdown', () => {
    if (isAnimating || dragState) return;
    if (selection.size) { selection.clear(); selected = null; render(); }
  });

  const rulesPanel = root.querySelector('#rules-panel');
  const rulesButton = root.querySelector('#rules-button');
  const setRules = (open) => {
    rulesPanel.setAttribute('aria-hidden', String(!open));
    rulesButton.setAttribute('aria-expanded', String(open));
    if (open) rulesPanel.querySelector('.close-rules').focus();
  };
  rulesButton.addEventListener('click', () => setRules(rulesButton.getAttribute('aria-expanded') !== 'true'));
  root.querySelector('.close-rules').addEventListener('click', () => setRules(false));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setRules(false);
    if (event.key === 'h' || event.key === 'H') setHints(!hintsOn);
    if (event.key === '[') { event.preventDefault(); keyRotate(-1); }
    if (event.key === ']') { event.preventDefault(); keyRotate(1); }
    if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !isAnimating) {
      event.preventDefault();
      const index = Math.max(0, pieces.findIndex((piece) => piece.id === selected));
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + pieces.length) % pieces.length;
      selectPiece(pieces[next].id);
      root.querySelector(`[data-id="${pieces[next].id}"]`).focus();
    }
  });
}

const TEMPLATE = `
  <a class="skip-link" href="#board">Skip to puzzle</a>
  <main>
    <header class="masthead">
      <div class="brand" aria-label="MA Tangram"><span class="brand-mark">間</span><span class="brand-name">MA</span></div>
      <div class="level-nav">
        <button class="icon-button small" id="prev-button" aria-label="Previous level">‹</button>
        <div class="level-meta"><strong id="level-name">—</strong><span id="level-count">00 / 00</span></div>
        <button class="icon-button small" id="next-button" aria-label="Next level">›</button>
      </div>
      <div class="masthead-right">
        <a class="text-button" href="#admin">Build</a>
        <button class="text-button" id="rules-button" aria-expanded="false" aria-controls="rules-panel">How it moves</button>
      </div>
    </header>

    <section class="game-shell">
      <aside class="intro">
        <p class="eyebrow">Assignment</p>
        <h1 id="assignment-name">—</h1>
        <div class="goal-card"><div id="goal-thumb" class="goal-thumb" aria-label="Target silhouette"></div></div>
        <p class="lede">Form the silhouette. Drag a face to slide it along an edge it touches; arc a corner to pivot. Nothing overlaps.</p>
        <div class="progress-wrap" aria-label="Puzzle progress">
          <div class="progress-copy"><span>FORMING</span><strong id="progress-number">00%</strong></div>
          <div class="progress-track"><span id="progress-bar"></span></div>
        </div>
      </aside>

      <section class="board-wrap" id="board" aria-label="Tangram puzzle board">
        <div class="board-note" aria-hidden="true"><span>幾</span><span>何</span></div>
        <svg id="game-board" viewBox="0 0 760 570" role="group" aria-label="Seven non-overlapping classic tangram pieces">
          <defs>
            <filter id="paper-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#342d23" flood-opacity=".16" /></filter>
            <filter id="edge-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          <g id="goal-layer" transform="translate(0 90)" aria-hidden="true"></g>
          <g id="piece-layer" transform="translate(0 90)"></g>
          <g id="guide-layer" transform="translate(0 90)" aria-hidden="true"></g>
        </svg>
        <div class="board-caption"><span>SCRAMBLE</span><span>SILHOUETTE</span></div>
        <div id="action-dock" class="action-dock" aria-live="polite"></div>
        <div id="notice" class="notice" role="status" aria-live="polite"></div>
      </section>

      <aside class="side-tools">
        <div class="move-count"><span id="move-count">00</span><small>MOVES</small></div>
        <button class="icon-button" id="hint-button" aria-label="Toggle hints" aria-pressed="false" title="Show contact hints (H)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.7.7-1 1.2-1 2.5H9c0-1.3-.3-1.8-1-2.5A6 6 0 0 1 12 3z"/></svg></button>
        <button class="icon-button" id="undo-button" aria-label="Undo last move" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8 5 12l4 4M5 12h8a5 5 0 1 1 0 10"/></svg></button>
        <button class="icon-button" id="reset-button" aria-label="Reset puzzle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a8 8 0 1 1 2 7M4 11V5m0 6h6"/></svg></button>
      </aside>
    </section>

    <footer><span>Slide a face · pivot a corner · <kbd>⇧</kbd>click to group</span><span class="footer-hint"><kbd>←</kbd><kbd>→</kbd> choose · <kbd>[</kbd><kbd>]</kbd> turn · <kbd>H</kbd> hint</span><span>Turns snap to 45°</span></footer>
  </main>

  <aside class="rules-panel" id="rules-panel" aria-hidden="true">
    <button class="close-rules" aria-label="Close rules">Close</button>
    <p class="eyebrow">The three laws</p>
    <ol>
      <li><span>一</span><div><strong>Contact unlocks.</strong><p>A piece moves only where it touches the cluster. Floating pieces have nothing to ride.</p></div></li>
      <li><span>二</span><div><strong>Edges are rails.</strong><p>Drag a face and it rides the shared edge, stopping at the first collision.</p></div></li>
      <li><span>三</span><div><strong>Corners are pivots.</strong><p>Arc a shared corner; the turn sweeps until blocked, then snaps to 45°.</p></div></li>
    </ol>
    <p class="rules-foot">Hints are off by default — press <kbd>H</kbd> or the bulb to light the rails and rotation rings. Match the grey silhouette to finish.</p>
  </aside>

  <div class="complete-screen" id="complete-screen" aria-hidden="true">
    <div class="sun"></div><p class="eyebrow">Form completed</p><h2 id="complete-name">家</h2>
    <p>Settled in <strong id="final-moves">0</strong> moves.</p>
    <div class="complete-actions"><button id="play-again" class="ghost">Replay</button><button id="next-level">Next level</button></div>
  </div>
`;
