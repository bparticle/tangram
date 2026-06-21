import {
  PIECES, PIECE_BY_ID, ROT_SNAP, SNAP_VERTEX,
  sub, dot, cross, len, unit, dist, clamp, rotateVec,
  worldPoints, transformString, pointsString, edgesOf, overlaps, touches,
  pointOnSeg, segDist, normalizedAngleDelta, figureBounds, sameShape, placementFlip
} from './shared.js';
import { listLevels } from './levels.js';
import { createContactEngine, edgeContact, collinearOverlap, placeAlong, placeFromPivot } from './contact-engine.js';

// The contact engine is unchanged: one invariant (move continuously, never
// overlap, always stay in contact) yields slide-along-edge and pivot-around-
// corner for free. What's new here is the level shell around it — a silhouette
// to aim at, hints you opt into, and a generated-but-solvable scramble.

const BOARD = { minX: -4, maxX: 764, minY: -88, maxY: 484 };
const FIGURE_CENTER = [370, 160];
const ASSIST_TOL = 6; // px: once a move lands a piece this close to its goal, seat it exactly

const pieces = PIECES;
const pieceById = (id) => PIECE_BY_ID[id];

let levels = [];
let levelIndex = 0;
let targets = {};
const placements = {};
let startPlacements = {};
const contact = createContactEngine(placements, BOARD);
const {
  withinBounds, neighbourhood, lawful, lawfulNow, contactRails, contactCorners,
  localPivot, slideLimit, rotateLimit, cornerCanRotate
} = contact;

// How close a grab must land to a contact corner to read as a pivot. Generous
// so the small, sharp tips (e.g. the parallelogram's 45° corner) are easy to
// catch; an actual slide is still recognised inside this zone by its motion.
const CORNER_GRAB = 32;
// Within this many degrees of a reachable 45° stop, a live rotation sticks to
// it — sharp-corner turns no longer demand pixel-perfect aim.
const ROT_MAGNET = 9;

let selected = null;
const selection = new Set();
let movesMade = 0;
let hintsOn = false;
let noticeTimer;
let isAnimating = false;
let dragState = null;
const history = [];

let pieceLayer; let goalLayer; let guideLayer;

export async function mountGame(root) {
  root.innerHTML = '<main class="load-state"><p class="eyebrow">Tangram</p><strong>Loading levels…</strong></main>';
  try {
    levels = await listLevels();
  } catch (error) {
    console.error(error);
    root.innerHTML = '<main class="load-state"><p class="eyebrow">Database unavailable</p><strong>Levels could not be loaded.</strong><p>Check the server connection and try again.</p><a class="text-button" href="#editor">Open editor</a></main>';
    return;
  }
  if (!levels.length) {
    root.innerHTML = '<main class="load-state"><p class="eyebrow">No levels</p><strong>Create the first level in the editor.</strong><a class="text-button" href="#editor">Open editor</a></main>';
    return;
  }
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
  const level = levels[levelIndex];
  const raw = level.targets;
  const hasAuthoredStart = level.start && pieces.every((p) => level.start[p.id]);
  const b = figureBounds(raw);
  const ox = hasAuthoredStart ? 0 : FIGURE_CENTER[0] - b.cx;
  const oy = hasAuthoredStart ? 0 : FIGURE_CENTER[1] - b.cy;
  targets = {};
  for (const p of pieces) {
    const t = raw[p.id] || [0, 0, 0];
    targets[p.id] = [t[0] + ox, t[1] + oy, ((t[2] % 360) + 360) % 360, placementFlip(t)];
  }
  startPlacements = hasAuthoredStart
    ? Object.fromEntries(pieces.map((p) => {
      const s = level.start[p.id];
      return [p.id, [s[0], s[1], ((s[2] % 360) + 360) % 360, placementFlip(s)]];
    }))
    : makeScramble(targets);
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
        const cand = placeFromPivot(corner, lp, r + d, placementFlip(placements[p.id]));
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
    d.flip = placementFlip(d.start);
    d.startAngle = Math.atan2(point[1] - pv[1], point[0] - pv[0]);
    d.negLimit = rotateLimit(d.piece.id, -1, pv, d.lp, d.hood);
    d.posLimit = rotateLimit(d.piece.id, 1, pv, d.lp, d.hood);
  };
  const rotatable = () => d.negLimit > 0.5 || d.posLimit > 0.5;
  const bestRail = () => {
    let best = null; let bestScore = -1;
    for (const r of d.rails) {
      const score = Math.abs(dot(u, r.dir)) * (segDist(grab, r.seg[0], r.seg[1]) < 55 ? 1 : 0.001);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  };
  const rail = bestRail();
  // How well the motion lines up with the candidate rail. Near a corner this is
  // what separates intent: dragging *along* the edge slides, arcing *across* it
  // (low alignment) rotates — so even the middle of a tiny piece still slides,
  // while a flick around a sharp tip reliably turns.
  const slideAlong = rail ? Math.abs(dot(u, rail.dir)) : 0;
  const nearCorner = pivot && dist(pivot, grab) <= CORNER_GRAB;
  const wantsSlide = rail && (!nearCorner || slideAlong >= 0.7);

  if (wantsSlide) {
    startSlide(rail);
  } else if (pivot) {
    startRotate(pivot);
    // Pivot is pinned both ways — fall back to a slide if the motion allows one.
    if (!rotatable() && rail) startSlide(rail);
    else if (!rotatable()) d.mode = 'pending';
  } else if (rail) {
    startSlide(rail);
  }
  render();
}

function beginGroupDrag(event, element) {
  event.preventDefault();
  element.setPointerCapture(event.pointerId);
  const grab = clientToBoard(event);
  const grabPoint = [grab.x, grab.y];
  const members = [...selection];
  const starts = {};
  members.forEach((id) => { starts[id] = [...placements[id]]; });
  const staticPolys = pieces.filter((p) => !selection.has(p.id)).map((p) => worldPoints(p, placements[p.id]));
  dragState = { pointerId: event.pointerId, element, type: 'group', mode: 'translate', members, starts, staticPolys, grab: grabPoint, delta: [0, 0], angle: 0, moved: 0 };
  dragState.rails = groupRails(dragState);
  const pivot = groupCorners(members).sort((a, b) => dist(a, grabPoint) - dist(b, grabPoint))[0];
  if (pivot && dist(pivot, grabPoint) <= CORNER_GRAB) {
    dragState.mode = 'rotate';
    dragState.pivot = pivot;
    dragState.startAngle = Math.atan2(grabPoint[1] - pivot[1], grabPoint[0] - pivot[0]);
    dragState.negLimit = groupRotationLimit(dragState, -1);
    dragState.posLimit = groupRotationLimit(dragState, 1);
    if (dragState.negLimit < 0.5 && dragState.posLimit < 0.5) dragState.mode = 'translate';
  }
  // With static neighbours, a group slides on a rail just like a single piece:
  // wait for the drag direction, then ride the best-aligned shared edge. Only
  // the all-selected case (nothing static) keeps the free 2D translate.
  if (dragState.mode === 'translate' && staticPolys.length) dragState.mode = 'pending';
  render();
}

// Group sliding obeys the same law as a single piece: a member's *side* must
// ride a static edge. A cluster touching the rest only at a corner can't be
// dragged across it — keeping an edge flush also naturally pins the slide to
// that edge's direction. (Group rotation, like single-piece rotation, still
// needs only one contact point — see groupRotationValid.)
function groupValid(delta, d) {
  let contact = d.staticPolys.length === 0;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(pieceById(id), [s[0] + delta[0], s[1] + delta[1], s[2], placementFlip(s)]);
    if (!withinBounds(poly)) return false;
    for (const sp of d.staticPolys) {
      if (overlaps(poly, sp)) return false;
      if (!contact && edgeContact(poly, sp)) contact = true;
    }
  }
  return contact;
}

// A group slides exactly like a single piece: along a fixed rail, with the
// extent limited by first collision / loss of contact — not by a greedy 2D
// march. That's what lets a group ride cleanly to the far corner of a surface
// and seat there, instead of halting a few pixels short.
function groupRails(d) {
  const found = [];
  for (const id of d.members) {
    const me = edgesOf(worldPoints(pieceById(id), d.starts[id]));
    for (const sp of d.staticPolys) {
      const se = edgesOf(sp);
      for (const [a, b] of me) for (const [c, dd] of se) {
        const segment = collinearOverlap(a, b, c, dd);
        if (segment && dist(segment[0], segment[1]) >= 6) found.push({ dir: unit(sub(b, a)), seg: segment });
      }
    }
  }
  const byLine = new Map();
  for (const rail of found) {
    let angle = Math.atan2(rail.dir[1], rail.dir[0]);
    if (angle < 0) angle += Math.PI;
    const offset = -Math.sin(angle) * rail.seg[0][0] + Math.cos(angle) * rail.seg[0][1];
    const key = `${Math.round(angle * 40)}:${Math.round(offset)}`;
    const previous = byLine.get(key);
    if (!previous || dist(rail.seg[0], rail.seg[1]) > dist(previous.seg[0], previous.seg[1])) byLine.set(key, rail);
  }
  return [...byLine.values()];
}

// Validity for a group sliding by `delta`: bounded, non-overlapping, and still
// touching the static cluster. Contact here is plain touch (not edge contact),
// so the slide can run all the way to a corner — the same asymmetry single
// pieces have, where a rail is needed to *start* but a slide may *end* at a
// corner. The fixed direction prevents corner-walking, so no abuse follows.
function groupSlideValid(delta, d) {
  let contact = d.staticPolys.length === 0;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(pieceById(id), [s[0] + delta[0], s[1] + delta[1], s[2], placementFlip(s)]);
    if (!withinBounds(poly)) return false;
    for (const sp of d.staticPolys) {
      if (overlaps(poly, sp)) return false;
      if (!contact && touches(poly, sp)) contact = true;
    }
  }
  return contact;
}

function groupSlideLimit(d, dir, sign) {
  let last = 0;
  for (let distance = 0.6; distance <= 520; distance += 0.6) {
    if (!groupSlideValid([sign * distance * dir[0], sign * distance * dir[1]], d)) break;
    last = distance;
  }
  return last;
}

function decideGroupGesture(d, u) {
  let best = null;
  let bestScore = -1;
  for (const r of d.rails) {
    const score = Math.abs(dot(u, r.dir)) * (segDist(d.grab, r.seg[0], r.seg[1]) < 80 ? 1 : 0.001);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best) return;
  d.mode = 'slide'; d.dir = best.dir; d.rail = best;
  d.negLimit = groupSlideLimit(d, best.dir, -1);
  d.posLimit = groupSlideLimit(d, best.dir, 1);
  render();
}

// Click a sliding group onto a vertex alignment along its rail, so it lands on
// the surface's end corner rather than a hair short of it.
function snapGroupSlide(d) {
  const dir = d.dir;
  const s0 = dot(d.delta, dir);
  let bestS = s0;
  let bestDelta = SNAP_VERTEX;
  for (const id of d.members) {
    const verts = worldPoints(pieceById(id), d.starts[id]);
    for (const v of verts) {
      const cur = [v[0] + s0 * dir[0], v[1] + s0 * dir[1]];
      for (const sp of d.staticPolys) for (const w of sp) {
        const diff = sub(w, cur);
        if (Math.abs(cross(dir, diff)) > SNAP_VERTEX) continue;
        const along = dot(diff, dir);
        if (Math.abs(along) >= bestDelta) continue;
        const sCand = s0 + along;
        if (sCand < -d.negLimit - 0.01 || sCand > d.posLimit + 0.01) continue;
        if (groupSlideValid([sCand * dir[0], sCand * dir[1]], d)) { bestDelta = Math.abs(along); bestS = sCand; }
      }
    }
  }
  d.delta = [bestS * dir[0], bestS * dir[1]];
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

function groupRotatedPlacements(d, angle) {
  const radians = angle * Math.PI / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const result = {};
  for (const id of d.members) {
    const start = d.starts[id];
    const dx = start[0] - d.pivot[0];
    const dy = start[1] - d.pivot[1];
    result[id] = [
      d.pivot[0] + dx * c - dy * s,
      d.pivot[1] + dx * s + dy * c,
      start[2] + angle,
      placementFlip(start)
    ];
  }
  return result;
}

function groupRotationValid(angle, d) {
  const rotated = groupRotatedPlacements(d, angle);
  let contact = d.staticPolys.length === 0;
  for (const id of d.members) {
    const polygon = worldPoints(pieceById(id), rotated[id]);
    if (!withinBounds(polygon)) return false;
    for (const staticPolygon of d.staticPolys) {
      if (overlaps(polygon, staticPolygon)) return false;
      if (!contact && touches(polygon, staticPolygon)) contact = true;
    }
  }
  return contact;
}

function groupRotationLimit(d, sign) {
  let last = 0;
  for (let angle = 0.6; angle <= 180; angle += 0.6) {
    if (!groupRotationValid(sign * angle, d)) break;
    last = angle;
  }
  return last;
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
  if (d.mode === 'rotate') {
    const rotated = groupRotatedPlacements(d, d.angle);
    for (const id of d.members) pieceLayer.querySelector(`[data-id="${id}"]`).setAttribute('transform', transformString(rotated[id]));
    return;
  }
  for (const id of d.members) {
    const s = d.starts[id];
    pieceLayer.querySelector(`[data-id="${id}"]`).setAttribute('transform', transformString([s[0] + d.delta[0], s[1] + d.delta[1], s[2], placementFlip(s)]));
  }
}

function snapGroup(d) {
  let best = null;
  let bestDelta = SNAP_VERTEX;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(pieceById(id), [s[0] + d.delta[0], s[1] + d.delta[1], s[2], placementFlip(s)]);
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
    if (dragState.mode === 'pending') {
      const drag = sub(point, dragState.grab);
      if (len(drag) < 5) return;
      decideGroupGesture(dragState, unit(drag));
      if (dragState.mode === 'pending') return;
    }
    if (dragState.mode === 'rotate') {
      const angle = Math.atan2(point[1] - dragState.pivot[1], point[0] - dragState.pivot[0]);
      dragState.angle = clamp(normalizedAngleDelta(angle - dragState.startAngle) * 180 / Math.PI, -dragState.negLimit, dragState.posLimit);
      dragState.moved = Math.abs(dragState.angle);
    } else if (dragState.mode === 'slide') {
      const s = clamp(dot(sub(point, dragState.grab), dragState.dir), -dragState.negLimit, dragState.posLimit);
      dragState.delta = [s * dragState.dir[0], s * dragState.dir[1]];
      dragState.moved = Math.abs(s);
    } else {
      dragState.delta = marchGroup(dragState, sub(point, dragState.grab));
      dragState.moved = len(dragState.delta);
    }
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
    const raw = clamp(normalizedAngleDelta(angle - dragState.startAngle) * 180 / Math.PI, -dragState.negLimit, dragState.posLimit);
    const deg = magnetizeRotation(dragState, raw);
    dragState.moved = Math.abs(deg);
    dragState.current = placeFromPivot(dragState.pivot, dragState.lp, dragState.start[2] + deg, dragState.flip);
  }
  dragState.element.setAttribute('transform', transformString(dragState.current));
  updateDragDock();
}

// Pull a live rotation toward the nearest reachable 45° stop while dragging, so
// the player lands turns without precise aim. Only the absolute angle that the
// release-time snap would also accept is offered, and only within the swept
// limits — the preview never promises a turn the commit would reject.
function magnetizeRotation(d, deg) {
  const snappedAbs = Math.round((d.start[2] + deg) / ROT_SNAP) * ROT_SNAP;
  const snappedDeg = snappedAbs - d.start[2];
  if (snappedDeg < -d.negLimit - 0.01 || snappedDeg > d.posLimit + 0.01) return deg;
  return Math.abs(deg - snappedDeg) <= ROT_MAGNET ? snappedDeg : deg;
}

function snapRotation(d, place) {
  const snapped = Math.round(place[2] / ROT_SNAP) * ROT_SNAP;
  if (snapped >= d.start[2] - d.negLimit - 0.01 && snapped <= d.start[2] + d.posLimit + 0.01) {
    const candidate = placeFromPivot(d.pivot, d.lp, snapped, d.flip);
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
    if (d.mode === 'rotate') {
      const snapped = Math.round(d.angle / ROT_SNAP) * ROT_SNAP;
      if (snapped >= -d.negLimit - 0.01 && snapped <= d.posLimit + 0.01 && groupRotationValid(snapped, d)) d.angle = snapped;
      if (Math.abs(d.angle) > 0.5 && groupRotationValid(d.angle, d)) {
        history.push(snapshot());
        const rotated = groupRotatedPlacements(d, d.angle);
        for (const id of d.members) placements[id] = rotated[id];
        settle(d.members);
        movesMade += 1;
        render();
        if (solved()) window.setTimeout(showComplete, 420);
        else showNotice(`Pivoted ${d.members.length} pieces together.`);
      } else render();
      return;
    }
    if (d.mode === 'pending') { render(); return; }
    const onRail = d.mode === 'slide';
    if (onRail) snapGroupSlide(d); else snapGroup(d);
    const valid = onRail ? groupSlideValid(d.delta, d) : groupValid(d.delta, d);
    if (len(d.delta) > 0.5 && valid) {
      history.push(snapshot());
      for (const id of d.members) { const s = d.starts[id]; placements[id] = [s[0] + d.delta[0], s[1] + d.delta[1], s[2], placementFlip(s)]; }
      settle(d.members);
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
    settle([d.piece.id]);
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
      element.setAttribute('transform', transformString([from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p, from[2] + (to[2] - from[2]) * p, placementFlip(from)]));
      if (raw < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function keyRotate(sign) {
  if (!selected || isAnimating) return;
  if (selection.size > 1) { keyRotateGroup(sign); return; }
  const corners = contactCorners(selected);
  if (!corners.length) { showNotice('No shared corner to pivot on.'); return; }
  const hood = neighbourhood(selected);
  const pivot = corners[0];
  const lp = localPivot(selected, pivot);
  const start = placements[selected];
  const target = (Math.round(start[2] / ROT_SNAP) + sign) * ROT_SNAP;
  const candidate = placeFromPivot(pivot, lp, target, placementFlip(start));
  if (!lawful(selected, candidate, hood)) { showNotice('That turn is blocked.'); return; }
  history.push(snapshot());
  placements[selected] = candidate;
  settle([selected]);
  movesMade += 1;
  render();
  if (solved()) window.setTimeout(showComplete, 420);
  else showNotice('Pivoted on a shared corner.');
}

function keyRotateGroup(sign) {
  const members = [...selection];
  const starts = {};
  members.forEach((id) => { starts[id] = [...placements[id]]; });
  const staticPolys = pieces.filter((piece) => !selection.has(piece.id)).map((piece) => worldPoints(piece, placements[piece.id]));
  for (const pivot of groupCorners(members)) {
    const state = { members, starts, staticPolys, pivot };
    if (groupRotationLimit(state, sign) < ROT_SNAP - 0.1) continue;
    const angle = sign * ROT_SNAP;
    if (!groupRotationValid(angle, state)) continue;
    history.push(snapshot());
    const rotated = groupRotatedPlacements(state, angle);
    for (const id of members) placements[id] = rotated[id];
    settle(members);
    movesMade += 1;
    render();
    if (solved()) window.setTimeout(showComplete, 420);
    else showNotice(`Pivoted ${members.length} pieces together.`);
    return;
  }
  showNotice('That group turn is blocked.');
}

// --- win / state -----------------------------------------------------------
const pieceSolved = (piece) => sameShape(worldPoints(piece, placements[piece.id]), worldPoints(piece, targets[piece.id]));
const solved = () => pieces.every(pieceSolved);

// Once a committed move leaves a piece essentially on its own goal, finish the
// alignment exactly. Authored targets — especially intentionally off-kilter
// ones — can sit a hair off the contact lattice the player can actually reach;
// without this they'd be visibly "there" yet never register, and the solved
// figure would keep hairline gaps. We only seat when the exact goal is clear of
// every neighbour, so it can never force an overlap or reveal a hidden answer
// (it triggers only when the player is already correct).
function settle(ids) {
  for (const id of ids) {
    const target = targets[id];
    if (!target) continue;
    const piece = pieceById(id);
    const goal = worldPoints(piece, target);
    if (!sameShape(worldPoints(piece, placements[id]), goal, ASSIST_TOL)) continue;
    if (!withinBounds(goal)) continue;
    if (neighbourhood(id).some((other) => overlaps(goal, other))) continue;
    placements[id] = [...target];
  }
}

function snapshot() {
  const map = {};
  pieces.forEach((p) => { map[p.id] = [...placements[p.id]]; });
  return map;
}

function undo() {
  if (!history.length || isAnimating) return;
  const prev = history.pop();
  pieces.forEach((p) => { placements[p.id] = [...prev[p.id]]; });
  movesMade = Math.max(0, movesMade - 1);
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
  const bounds = figureBounds(targets);
  const polygons = pieces.map((piece) => `<polygon points="${pointsString(worldPoints(piece, targets[piece.id]))}"/>`).join('');
  goalLayer.innerHTML = `<defs><clipPath id="board-silhouette" clipPathUnits="userSpaceOnUse">${polygons}</clipPath></defs><rect class="silhouette" x="${bounds.minX - 2}" y="${bounds.minY - 2}" width="${bounds.w + 4}" height="${bounds.h + 4}" clip-path="url(#board-silhouette)"/>`;
}

function renderAssignment() {
  const b = figureBounds(targets);
  const pad = 16;
  const vb = `${b.minX - pad} ${b.minY - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
  const polygons = pieces.map((p) => ({ points: pointsString(worldPoints(p, targets[p.id])) }));
  // Paint the prompt once through a union clip by default. The hint reveals
  // only its construction lines; piece colours remain undisclosed.
  const artwork = hintsOn
    ? polygons.map(({ points }) => `<polygon class="hint-division" points="${points}"/>`).join('')
    : `<defs><clipPath id="assignment-silhouette" clipPathUnits="userSpaceOnUse">${polygons.map(({ points }) => `<polygon points="${points}"/>`).join('')}</clipPath></defs><rect x="${b.minX - pad}" y="${b.minY - pad}" width="${b.w + 2 * pad}" height="${b.h + 2 * pad}" fill="#33352c" clip-path="url(#assignment-silhouette)"/>`;
  document.querySelector('#goal-thumb').innerHTML = `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${artwork}</svg>`;
  document.querySelector('#assignment-name').textContent = levels[levelIndex].name;
  // Surface the difficulty the editor records but the game otherwise hides.
  const difficulty = levels[levelIndex].difficulty;
  document.querySelector('#assignment-eyebrow').textContent = difficulty
    ? `Assignment · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`
    : 'Assignment';
}

function updateMasthead() {
  document.querySelector('#level-name').textContent = levels[levelIndex].name;
  document.querySelector('#level-count').textContent = `${String(levelIndex + 1).padStart(2, '0')} / ${String(levels.length).padStart(2, '0')}`;
}

// Before any drag, show the selected piece where it can act: a dashed axis on
// every edge it can ride, a dot on every corner it can pivot. This answers
// "where do I grab, and which way will it slide?" without the player guessing.
function renderAffordances() {
  if (isAnimating || selection.size !== 1 || !selected) return;
  const hood = neighbourhood(selected);
  for (const rail of contactRails(selected)) {
    const [[x1, y1], [x2, y2]] = rail.seg;
    guideLayer.insertAdjacentHTML('beforeend', `<line class="slide-axis" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  }
  for (const pivot of contactCorners(selected)) {
    if (!cornerCanRotate(selected, pivot, hood)) continue;
    guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-dot" cx="${pivot[0]}" cy="${pivot[1]}" r="4.5"/>`);
  }
}

function renderGuide() {
  guideLayer.innerHTML = '';
  if (!dragState) { renderAffordances(); return; }
  if (dragState.locked) return;
  if (dragState.type === 'group') {
    if (dragState.mode === 'rotate') {
      const [cx, cy] = dragState.pivot;
      guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-ring" cx="${cx}" cy="${cy}" r="26"/><circle class="pivot-point" cx="${cx}" cy="${cy}" r="5"/>`);
    } else if (dragState.mode === 'slide' && dragState.rail) {
      const [[x1, y1], [x2, y2]] = dragState.rail.seg;
      guideLayer.insertAdjacentHTML('beforeend', `<line class="available-edge-halo is-engaged" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="available-edge is-engaged" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }
    return;
  }
  if (dragState?.mode === 'rotate') {
    const [cx, cy] = dragState.pivot;
    guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-ring" cx="${cx}" cy="${cy}" r="26"/><circle class="pivot-point" cx="${cx}" cy="${cy}" r="5"/>`);
    return;
  }
  if (dragState.mode === 'slide' && dragState.rail) {
    const [[x1, y1], [x2, y2]] = dragState.rail.seg;
    guideLayer.insertAdjacentHTML('beforeend', `<line class="available-edge-halo is-engaged" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="available-edge is-engaged" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  }
}

function updateDragDock() {
  const dock = document.querySelector('#action-dock');
  if (!dragState || dragState.locked) return;
  if (dragState.type === 'group') {
    if (dragState.mode === 'rotate') {
      const span = Math.max(1, dragState.posLimit + dragState.negLimit);
      dock.innerHTML = `<span class="drag-meter"><i style="transform:scaleX(${Math.min(1, dragState.moved / span)})"></i></span><span><strong>ROTATE GROUP ${Math.round(dragState.moved)}°</strong><small>${dragState.members.length} pieces · snaps to 45°</small></span>`;
    } else if (dragState.mode === 'pending') {
      dock.innerHTML = `<span><strong>GROUP · ${dragState.members.length} pieces</strong><small>Drag along a shared edge to slide</small></span>`;
    } else if (dragState.mode === 'slide') {
      const span = Math.max(1, dragState.posLimit, dragState.negLimit);
      dock.innerHTML = `<span class="drag-meter"><i style="transform:scaleX(${Math.min(1, dragState.moved / span)})"></i></span><span><strong>SLIDE GROUP ${Math.round(dragState.moved)}px</strong><small>${dragState.members.length} pieces · release to set</small></span>`;
    } else {
      dock.innerHTML = `<span class="drag-meter"><i style="transform:scaleX(${Math.min(1, dragState.moved / 140)})"></i></span><span><strong>MOVE GROUP ${Math.round(dragState.moved)}px</strong><small>${dragState.members.length} pieces · release to set</small></span>`;
    }
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
  else if (selection.size >= 2) dock.innerHTML = `<span><strong>GROUP · ${selection.size} pieces</strong><small>Drag a shared edge to slide · arc a corner to pivot · shift-click to adjust</small></span>`;
  else if (selected) dock.innerHTML = `<span><strong>${pieceById(selected).name}</strong><small>Drag a dashed edge to slide · arc a dotted corner to pivot</small></span>`;
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
  renderAssignment();
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
        <a class="text-button" href="#editor">Editor</a>
        <button class="text-button" id="rules-button" aria-expanded="false" aria-controls="rules-panel">How it moves</button>
      </div>
    </header>

    <section class="game-shell">
      <aside class="intro">
        <p class="eyebrow" id="assignment-eyebrow">Assignment</p>
        <h1 id="assignment-name">—</h1>
        <div class="goal-card"><div id="goal-thumb" class="goal-thumb" aria-label="Target silhouette"></div><button class="icon-button goal-hint" id="hint-button" aria-label="Toggle silhouette divisions" aria-pressed="false" title="Show silhouette divisions (H)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.7.7-1 1.2-1 2.5H9c0-1.3-.3-1.8-1-2.5A6 6 0 0 1 12 3z"/></svg></button></div>
        <p class="lede">Form the silhouette. A piece slides only where one of its sides rests along another's edge; arc a shared corner to pivot. Nothing overlaps.</p>
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
        <button class="icon-button" id="undo-button" aria-label="Undo last move" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8 5 12l4 4M5 12h8a5 5 0 1 1 0 10"/></svg></button>
        <button class="icon-button" id="reset-button" aria-label="Reset puzzle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a8 8 0 1 1 2 7M4 11V5m0 6h6"/></svg></button>
      </aside>
    </section>

    <footer><span>Slide a side · pivot a corner · <kbd>⇧</kbd>click to group</span><span class="footer-hint"><kbd>←</kbd><kbd>→</kbd> choose · <kbd>[</kbd><kbd>]</kbd> turn · <kbd>H</kbd> silhouette</span><span>Turns snap to 45°</span></footer>
  </main>

  <aside class="rules-panel" id="rules-panel" aria-hidden="true">
    <button class="close-rules" aria-label="Close rules">Close</button>
    <p class="eyebrow">How it moves</p>
    <h2 class="rules-title">Three laws of contact</h2>

    <ol class="laws">
      <li class="law">
        <div class="law-head"><span class="law-num">一</span><strong>Contact unlocks</strong></div>
        <div class="law-body">
          <svg class="law-fig" viewBox="0 0 88 60" aria-hidden="true">
            <rect class="fig-solid" x="10" y="22" width="22" height="22"/>
            <polygon class="fig-solid" points="32,22 32,44 54,44"/>
            <polygon class="fig-ghost" points="60,12 82,12 60,34"/>
            <line class="fig-x" x1="65" y1="17" x2="77" y2="29"/>
            <line class="fig-x" x1="77" y1="17" x2="65" y2="29"/>
          </svg>
          <p>A piece can move only where it touches the cluster. A floating piece has nothing to ride — it stays put until something meets it.</p>
        </div>
      </li>

      <li class="law">
        <div class="law-head"><span class="law-num">二</span><strong>Sides are rails</strong></div>
        <div class="law-body">
          <svg class="law-fig" viewBox="0 0 88 60" aria-hidden="true">
            <rect class="fig-solid" x="18" y="16" width="24" height="24"/>
            <polygon class="fig-solid" points="42,16 64,16 42,40"/>
            <line class="fig-axis" x1="42" y1="9" x2="42" y2="47"/>
            <path class="fig-axis-arrow" d="M38 13 L42 9 L46 13"/>
            <path class="fig-axis-arrow" d="M38 43 L42 47 L46 43"/>
          </svg>
          <p>A piece slides only where one of <em>its</em> sides lies flat along another's edge — drag that side and it rides the shared edge until it collides. A lone corner resting on an edge is <em>not</em> a rail: no side, no slide.</p>
        </div>
      </li>

      <li class="law">
        <div class="law-head"><span class="law-num">三</span><strong>Corners are pivots</strong></div>
        <div class="law-body">
          <svg class="law-fig" viewBox="0 0 88 60" aria-hidden="true">
            <rect class="fig-solid" x="12" y="30" width="22" height="22"/>
            <polygon class="fig-outline" points="34,30 56,30 34,10"/>
            <path class="fig-arc" d="M56 30 A 22 22 0 0 0 49.6 14.4"/>
            <path class="fig-arc-arrow" d="M53.4 16.4 L49.6 14.4 L51.4 18.2"/>
            <circle class="fig-dot" cx="34" cy="30" r="3.4"/>
          </svg>
          <p>Arc a shared corner and the piece turns around it, needing just that one contact point and clear space to sweep. It stops at the first collision and clicks to 45° as you go.</p>
        </div>
      </li>
    </ol>

    <div class="rules-legend">
      <p class="eyebrow small">Reading the board</p>
      <ul>
        <li>
          <svg class="legend-mark" viewBox="0 0 22 22" aria-hidden="true"><line class="fig-axis" x1="3" y1="11" x2="19" y2="11"/></svg>
          <span><strong>Dashed edge</strong> — a side resting on an edge: drag it to slide.</span>
        </li>
        <li>
          <svg class="legend-mark" viewBox="0 0 22 22" aria-hidden="true"><circle class="fig-dot" cx="11" cy="11" r="4"/></svg>
          <span><strong>Ringed corner</strong> — a shared corner: arc it to pivot.</span>
        </li>
        <li>
          <svg class="legend-mark" viewBox="0 0 22 22" aria-hidden="true"><polygon class="fig-ghost" points="4,4 18,4 4,18"/></svg>
          <span><strong>Dimmed piece</strong> — no contact, nothing to ride.</span>
        </li>
      </ul>
    </div>

    <div class="rules-legend">
      <p class="eyebrow small">Controls</p>
      <ul class="controls-list">
        <li><span class="keys"><kbd>←</kbd><kbd>→</kbd></span> Choose a piece</li>
        <li><span class="keys"><kbd>[</kbd><kbd>]</kbd></span> Turn it 45°</li>
        <li><span class="keys"><kbd>⇧</kbd>click</span> Group pieces, then drag or arc them together</li>
        <li><span class="keys"><kbd>H</kbd></span> Reveal how the silhouette is divided</li>
      </ul>
    </div>

    <p class="rules-foot">Solved pieces settle exactly onto the silhouette. Movement guides appear only on the piece you've selected, so the board stays calm until you act.</p>
  </aside>

  <div class="complete-screen" id="complete-screen" aria-hidden="true">
    <div class="sun"></div><p class="eyebrow">Form completed</p><h2 id="complete-name">家</h2>
    <p>Settled in <strong id="final-moves">0</strong> moves.</p>
    <div class="complete-actions"><button id="play-again" class="ghost">Replay</button><button id="next-level">Next level</button></div>
  </div>
`;
