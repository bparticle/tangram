import { trapFocus } from './a11y.js';
import { createModifierZone, coarsePointer } from './modifier-zone.js';
import {
  PIECES, PIECE_BY_ID, ROT_SNAP,
  sub, dot, len, dist, clamp,
  worldPoints, transformString, pointsString, overlaps, touches,
  normalizedAngleDelta, figureBounds, sameShape, placementFlip
} from './shared.js';
import { listLevels } from './levels.js';
import { createContactEngine, GESTURE, placeAlong, placeFromPivot } from './contact-engine.js';

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
  withinBounds, neighbourhood, lawful, contactRails, contactCorners,
  localPivot, slideLimit, cornerCanRotate,
  makeBody, bodyRails, bodyCorners, bodyValid, bodyTranslate, bodyRotate,
  bodyRotateLimit, bodyInterpret, bodySnapSlide, bodySnapRotation,
  bodySnapFree, bodyMarch
} = contact;

// Intent is read from the *shape* of the drag, not where it was grabbed: a slide
// runs along a rail, a rotation arcs perpendicular to the pivot→grab radius. That
// read — and every contact rule it relies on — now lives once in the engine
// (bodyInterpret), shared by single pieces and groups here and in the builder, so
// the two can never drift apart. Tuning constants live in GESTURE.

let selected = null;
const selection = new Set();
let movesMade = 0;
let hintsOn = false;
let noticeTimer;
let isAnimating = false;
let dragState = null;
const history = [];

let pieceLayer; let goalLayer; let guideLayer;
let modifierZone = null;
let gameCleanup = null;
let rulesTrapCleanup = null;
let rulesReturnFocus = null;
let completeTrapCleanup = null;
let completeReturnFocus = null;

export function unmountGame() {
  gameCleanup?.();
  gameCleanup = null;
  rulesTrapCleanup?.();
  rulesTrapCleanup = null;
  completeTrapCleanup?.();
  completeTrapCleanup = null;
}

export async function mountGame(root) {
  unmountGame();
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

  gameCleanup = wireControls(root);
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
  closeComplete();
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
  if (modifierZone?.isGroupModifier(event)) {
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
  const body = makeBody([piece.id]);
  const corners = bodyCorners(body);
  const rails = bodyRails(body);
  if (!corners.length && !rails.length) {
    dragState = { pointerId: event.pointerId, element, piece, locked: true };
    element.classList.add('is-blocked');
    navigator.vibrate?.(12);
    render();
    return;
  }
  dragState = {
    pointerId: event.pointerId, element, piece, body, mode: 'pending',
    hood: body.staticPolys, rails, corners, grab: grabPoint,
    start: [...placements[piece.id]], current: [...placements[piece.id]], moved: 0
  };
  render();
}

// Apply a committed gesture (from bodyInterpret) onto a drag state. Identical for
// a single piece and a group — the only difference is a group has no `start`/`lp`
// to seed single-piece rotation rendering.
function applyDecision(d, decision, point) {
  if (decision.mode === 'slide') {
    d.mode = 'slide'; d.dir = decision.dir; d.rail = decision.rail; d.grab = point;
    d.negLimit = decision.negLimit; d.posLimit = decision.posLimit;
  } else {
    d.mode = 'rotate'; d.pivot = decision.pivot;
    d.startAngle = Math.atan2(point[1] - decision.pivot[1], point[0] - decision.pivot[0]);
    d.lastAngle = d.startAngle; // accumulate per-move so a turn past 180° doesn't wrap
    d.accum = 0;
    d.negLimit = decision.negLimit; d.posLimit = decision.posLimit;
    if (d.start) { d.lp = localPivot(d.piece.id, decision.pivot); d.flip = placementFlip(d.start); }
  }
  render();
}

function beginGroupDrag(event, element) {
  event.preventDefault();
  element.setPointerCapture(event.pointerId);
  const grab = clientToBoard(event);
  const grabPoint = [grab.x, grab.y];
  const body = makeBody(selection);
  dragState = { pointerId: event.pointerId, element, type: 'group', body, members: body.members, mode: 'translate', grab: grabPoint, delta: [0, 0], angle: 0, moved: 0 };
  dragState.rails = bodyRails(body);
  dragState.pivots = bodyCorners(body);
  // With static neighbours the group obeys the contact law just like a single
  // piece: wait for the drag, then read slide-vs-pivot from the motion's shape.
  // Only the all-selected case (nothing static) keeps the free 2D translate.
  if (body.staticPolys.length) dragState.mode = 'pending';
  render();
}

// Push the body's live placements to the DOM during a group drag. Rotation and
// translation both come straight from the engine's rigid-body transforms.
function applyGroupTransforms(d) {
  const map = d.mode === 'rotate' ? bodyRotate(d.body, d.pivot, d.angle) : bodyTranslate(d.body, d.delta);
  for (const id of d.members) pieceLayer.querySelector(`[data-id="${id}"]`).setAttribute('transform', transformString(map[id]));
}

function updateDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (dragState.locked) return;
  const board = clientToBoard(event);
  const point = [board.x, board.y];
  if (dragState.type === 'group') {
    if (dragState.mode === 'pending') {
      const decision = bodyInterpret(dragState.body, { grab: dragState.grab, rails: dragState.rails, corners: dragState.pivots, point, railNear: GESTURE.RAIL_NEAR_GROUP });
      if (decision) applyDecision(dragState, decision, point);
      if (dragState.mode === 'pending') { renderGuide(); return; }
    }
    if (dragState.mode === 'rotate') {
      const angle = Math.atan2(point[1] - dragState.pivot[1], point[0] - dragState.pivot[0]);
      dragState.accum = clamp(dragState.accum + normalizedAngleDelta(angle - dragState.lastAngle) * 180 / Math.PI, -dragState.negLimit, dragState.posLimit);
      dragState.lastAngle = angle;
      const raw = dragState.accum;
      const snapped = Math.round(raw / ROT_SNAP) * ROT_SNAP;
      const inRange = snapped >= -dragState.negLimit - 0.01 && snapped <= dragState.posLimit + 0.01;
      dragState.angle = inRange && Math.abs(raw - snapped) <= GESTURE.ROT_MAGNET ? snapped : raw;
      dragState.moved = Math.abs(dragState.angle);
    } else if (dragState.mode === 'slide') {
      const s = clamp(dot(sub(point, dragState.grab), dragState.dir), -dragState.negLimit, dragState.posLimit);
      dragState.delta = [s * dragState.dir[0], s * dragState.dir[1]];
      dragState.moved = Math.abs(s);
    } else {
      dragState.delta = bodyMarch(dragState.body, sub(point, dragState.grab), dragState.delta);
      dragState.moved = len(dragState.delta);
    }
    applyGroupTransforms(dragState);
    return;
  }
  if (dragState.mode === 'pending') {
    const decision = bodyInterpret(dragState.body, { grab: dragState.grab, rails: dragState.rails, corners: dragState.corners, point, railNear: GESTURE.RAIL_NEAR_PIECE });
    if (decision) applyDecision(dragState, decision, point);
    if (dragState.mode === 'pending') { renderGuide(); return; }
  }
  if (dragState.mode === 'slide') {
    const s = clamp(dot(sub(point, dragState.grab), dragState.dir), -dragState.negLimit, dragState.posLimit);
    dragState.moved = Math.abs(s);
    dragState.current = placeAlong(dragState.start, dragState.dir, s);
  } else {
    const angle = Math.atan2(point[1] - dragState.pivot[1], point[0] - dragState.pivot[0]);
    // Accumulate small per-move increments (each well under 180°), so a continuous
    // turn past ±180° keeps climbing instead of wrapping and snapping back.
    dragState.accum = clamp(dragState.accum + normalizedAngleDelta(angle - dragState.lastAngle) * 180 / Math.PI, -dragState.negLimit, dragState.posLimit);
    dragState.lastAngle = angle;
    const deg = magnetizeRotation(dragState, dragState.accum);
    dragState.moved = Math.abs(deg);
    dragState.current = placeFromPivot(dragState.pivot, dragState.lp, dragState.start[2] + deg, dragState.flip);
  }
  dragState.element.setAttribute('transform', transformString(dragState.current));
}

// Pull a live rotation toward the nearest reachable 45° stop while dragging, so
// the player lands turns without precise aim. Only the absolute angle that the
// release-time snap would also accept is offered, and only within the swept
// limits — the preview never promises a turn the commit would reject.
function magnetizeRotation(d, deg) {
  const snappedAbs = Math.round((d.start[2] + deg) / ROT_SNAP) * ROT_SNAP;
  const snappedDeg = snappedAbs - d.start[2];
  if (snappedDeg < -d.negLimit - 0.01 || snappedDeg > d.posLimit + 0.01) return deg;
  return Math.abs(deg - snappedDeg) <= GESTURE.ROT_MAGNET ? snappedDeg : deg;
}

async function finishDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const d = dragState;
  dragState = null;
  if (d.element.hasPointerCapture?.(event.pointerId)) d.element.releasePointerCapture(event.pointerId);
  d.element.classList.remove('is-blocked');

  if (d.type === 'group') {
    if (d.mode === 'rotate') {
      const angle = bodySnapRotation(d.body, d.pivot, d.angle, d.negLimit, d.posLimit);
      if (Math.abs(angle) > 0.5 && bodyValid(d.body, bodyRotate(d.body, d.pivot, angle), 'touch')) {
        history.push(snapshot());
        const rotated = bodyRotate(d.body, d.pivot, angle);
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
    let valid;
    if (d.mode === 'slide') {
      const s = bodySnapSlide(d.body, d.dir, dot(d.delta, d.dir), d.negLimit, d.posLimit);
      d.delta = [s * d.dir[0], s * d.dir[1]];
      valid = bodyValid(d.body, bodyTranslate(d.body, d.delta), 'touch');
    } else {
      d.delta = bodySnapFree(d.body, d.delta);
      valid = bodyValid(d.body, bodyTranslate(d.body, d.delta), 'edge');
    }
    if (len(d.delta) > 0.5 && valid) {
      history.push(snapshot());
      const map = bodyTranslate(d.body, d.delta);
      for (const id of d.members) placements[id] = map[id];
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
  if (d.mode === 'rotate') {
    target = placeFromPivot(d.pivot, d.lp, d.start[2] + bodySnapRotation(d.body, d.pivot, d.accum, d.negLimit, d.posLimit), d.flip);
  } else if (d.mode === 'slide' && d.dir) {
    target = placeAlong(d.start, d.dir, bodySnapSlide(d.body, d.dir, dot(sub(d.current, d.start), d.dir), d.negLimit, d.posLimit));
  }

  const before = placements[d.piece.id];
  const changed = dist(target, before) > 0.5 || Math.abs(target[2] - before[2]) > 0.1;
  if (changed && lawful(d.piece.id, target, d.hood)) {
    history.push(snapshot());
    isAnimating = true;
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
  const body = makeBody(selection);
  for (const pivot of bodyCorners(body)) {
    if (bodyRotateLimit(body, pivot, sign) < ROT_SNAP - 0.1) continue;
    const angle = sign * ROT_SNAP;
    if (!bodyValid(body, bodyRotate(body, pivot, angle), 'touch')) continue;
    history.push(snapshot());
    const rotated = bodyRotate(body, pivot, angle);
    for (const id of body.members) placements[id] = rotated[id];
    settle(body.members);
    movesMade += 1;
    render();
    if (solved()) window.setTimeout(showComplete, 420);
    else showNotice(`Pivoted ${body.members.length} pieces together.`);
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
  closeComplete();
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
  // Without hint: solid dark polygons with a matching 1px stroke per piece.
  // The stroke seals sub-pixel seams Safari shows at clipPath boundaries on
  // high-DPI displays — a clipPath approach was used before and showed faint
  // division lines on iPad retina. With hint: light stroke reveals divisions.
  const artwork = hintsOn
    ? polygons.map(({ points }) => `<polygon class="hint-division" points="${points}"/>`).join('')
    : polygons.map(({ points }) => `<polygon class="assignment-piece" points="${points}"/>`).join('');
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
    } else if (dragState.mode === 'pending') {
      // Still interpreting: show every shared rail and corner the group could ride.
      for (const rail of (dragState.rails || [])) {
        const [[x1, y1], [x2, y2]] = rail.seg;
        guideLayer.insertAdjacentHTML('beforeend', `<line class="slide-axis" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
      }
      for (const c of (dragState.pivots || [])) {
        guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-dot" cx="${c[0]}" cy="${c[1]}" r="4.5"/>`);
      }
    }
    return;
  }
  if (dragState.mode === 'pending') {
    // Still interpreting a single piece: keep every rail and rotatable corner lit
    // so the player sees what their drag is being read against.
    for (const rail of (dragState.rails || [])) {
      const [[x1, y1], [x2, y2]] = rail.seg;
      guideLayer.insertAdjacentHTML('beforeend', `<line class="slide-axis" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }
    for (const c of (dragState.corners || [])) {
      if (!cornerCanRotate(dragState.piece.id, c, dragState.hood)) continue;
      guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-dot" cx="${c[0]}" cy="${c[1]}" r="4.5"/>`);
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
  const solvedCount = pieces.filter(pieceSolved).length;
  const percent = Math.round((solvedCount / pieces.length) * 100);
  document.querySelector('#progress-number').textContent = `${String(percent).padStart(2, '0')}%`;
  document.querySelector('#progress-bar').style.transform = `scaleX(${percent / 100})`;
  const compactNumber = document.querySelector('#progress-compact-number');
  const compactBar = document.querySelector('#progress-compact-bar');
  if (compactNumber) compactNumber.textContent = `${String(percent).padStart(2, '0')}%`;
  if (compactBar) compactBar.style.transform = `scaleX(${percent / 100})`;
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

function closeComplete() {
  const screen = document.querySelector('#complete-screen');
  if (!screen || screen.getAttribute('aria-hidden') === 'true') return;
  screen.setAttribute('aria-hidden', 'true');
  completeTrapCleanup?.();
  completeTrapCleanup = null;
  const back = completeReturnFocus;
  completeReturnFocus = null;
  back?.focus?.();
}

function showComplete() {
  const screen = document.querySelector('#complete-screen');
  document.querySelector('#final-moves').textContent = movesMade;
  document.querySelector('#complete-name').textContent = levels[levelIndex].name;
  completeReturnFocus = document.activeElement;
  screen.setAttribute('aria-hidden', 'false');
  completeTrapCleanup = trapFocus(screen);
  screen.querySelector('#play-again').focus();
}

function setHints(on) {
  hintsOn = on;
  const btn = document.querySelector('#hint-button');
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  renderAssignment();
}

function wireControls(root) {
  const ac = new AbortController();
  const { signal } = ac;

  root.querySelector('#undo-button').addEventListener('click', undo, { signal });
  root.querySelector('#reset-button').addEventListener('click', reset, { signal });
  root.querySelector('#hint-button').addEventListener('click', () => setHints(!hintsOn), { signal });
  root.querySelector('#play-again').addEventListener('click', reset, { signal });
  root.querySelector('#next-level').addEventListener('click', () => loadLevel(levelIndex + 1), { signal });
  root.querySelector('#prev-button').addEventListener('click', () => loadLevel(levelIndex - 1), { signal });
  root.querySelector('#next-button').addEventListener('click', () => loadLevel(levelIndex + 1), { signal });

  window.addEventListener('pointermove', updateDrag, { passive: false, signal });
  window.addEventListener('pointerup', finishDrag, { signal });
  window.addEventListener('pointercancel', cancelDrag, { signal });

  root.querySelector('#game-board').addEventListener('pointerdown', () => {
    if (isAnimating || dragState) return;
    if (selection.size) { selection.clear(); selected = null; render(); }
  }, { signal });

  modifierZone = createModifierZone(root.querySelector('.board-wrap'), { signal });

  const rulesPanel = root.querySelector('#rules-panel');
  const rulesButton = root.querySelector('#rules-button');
  const completeScreen = root.querySelector('#complete-screen');
  const setRules = (open) => {
    if (open) {
      rulesReturnFocus = document.activeElement;
      rulesPanel.setAttribute('aria-hidden', 'false');
      rulesButton.setAttribute('aria-expanded', 'true');
      rulesTrapCleanup = trapFocus(rulesPanel);
      rulesPanel.querySelector('.close-rules').focus();
    } else {
      rulesPanel.setAttribute('aria-hidden', 'true');
      rulesButton.setAttribute('aria-expanded', 'false');
      rulesTrapCleanup?.();
      rulesTrapCleanup = null;
      const back = rulesReturnFocus;
      rulesReturnFocus = null;
      (back ?? rulesButton).focus();
    }
  };
  rulesButton.addEventListener('click', () => setRules(rulesButton.getAttribute('aria-expanded') !== 'true'), { signal });
  root.querySelector('.close-rules').addEventListener('click', () => setRules(false), { signal });
  root.querySelector('#mobile-rules-link')?.addEventListener('click', () => setRules(true), { signal });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (completeScreen.getAttribute('aria-hidden') === 'false') { closeComplete(); return; }
      if (rulesButton.getAttribute('aria-expanded') === 'true') setRules(false);
      return;
    }
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
  }, { signal });

  return () => {
    ac.abort();
    modifierZone?.destroy();
    modifierZone = null;
    rulesTrapCleanup?.();
    rulesTrapCleanup = null;
    completeTrapCleanup?.();
    completeTrapCleanup = null;
  };
}

const TEMPLATE = `
  <a class="skip-link" href="#board">Skip to puzzle</a>
  <main>
    <header class="masthead">
      <div class="brand" aria-label="MA Tangram"><span class="brand-mark" lang="ja">間</span><span class="brand-name">MA</span></div>
      <div class="level-nav">
        <button class="icon-button small" id="prev-button" aria-label="Previous level">‹</button>
        <div class="level-meta">
          <strong id="level-name">—</strong>
          <span id="level-count">00 / 00</span>
          <div class="progress-compact" aria-label="Puzzle progress">
            <span class="progress-compact-label">FORMING</span>
            <strong id="progress-compact-number">00%</strong>
            <div class="progress-track compact"><span id="progress-compact-bar"></span></div>
          </div>
        </div>
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
        <p class="lede">Form the silhouette. A piece slides along a shared edge or pivots on a shared corner — nothing overlaps.</p>
        <div class="progress-wrap" aria-label="Puzzle progress">
          <div class="progress-copy"><span>FORMING</span><strong id="progress-number">00%</strong></div>
          <div class="progress-track"><span id="progress-bar"></span></div>
        </div>
      </aside>

      <section class="board-wrap" id="board" aria-label="Tangram puzzle board">
        <div class="board-note" aria-hidden="true"><span lang="ja">幾</span><span lang="ja">何</span></div>
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
        <div id="notice" class="notice" role="status" aria-live="polite"></div>
      </section>

      <aside class="side-tools">
        <div class="move-count"><span id="move-count">00</span><small>MOVES</small></div>
        <button class="icon-button" id="undo-button" aria-label="Undo last move" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8 5 12l4 4M5 12h8a5 5 0 1 1 0 10"/></svg></button>
        <button class="icon-button" id="reset-button" aria-label="Reset puzzle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a8 8 0 1 1 2 7M4 11V5m0 6h6"/></svg></button>
      </aside>
    </section>

    <p class="mobile-hint"><button type="button" class="mobile-hint-link" id="mobile-rules-link">How it moves</button> · Drag a shared edge · arc a shared corner · tap <strong>Group</strong> to combine pieces</p>

    <footer><span>Drag a shared edge · arc a corner · <kbd>⇧</kbd>click to group</span><span class="footer-hint"><kbd>←</kbd><kbd>→</kbd> choose · <kbd>[</kbd><kbd>]</kbd> turn · <kbd>H</kbd> silhouette</span><span>Turns snap to 45°</span></footer>
  </main>

  <aside class="rules-panel" id="rules-panel" role="dialog" aria-modal="true" aria-labelledby="rules-title" aria-hidden="true">
    <button class="close-rules" aria-label="Close rules">Close</button>
    <p class="eyebrow">How it moves</p>
    <h2 class="rules-title" id="rules-title">Three laws of contact</h2>

    <ol class="laws">
      <li class="law">
        <div class="law-head"><span class="law-num" lang="ja">一</span><strong>Contact unlocks</strong></div>
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
        <div class="law-head"><span class="law-num" lang="ja">二</span><strong>Sides are rails</strong></div>
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
        <div class="law-head"><span class="law-num" lang="ja">三</span><strong>Corners are pivots</strong></div>
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

  <div class="complete-screen" id="complete-screen" role="dialog" aria-modal="true" aria-labelledby="complete-heading" aria-hidden="true">
    <div class="sun" aria-hidden="true"></div>
    <p class="eyebrow">Form completed</p>
    <h2 class="complete-heading" id="complete-heading" lang="ja"><span id="complete-name">家</span></h2>
    <p>Settled in <strong id="final-moves">0</strong> moves.</p>
    <div class="complete-actions"><button id="play-again" class="ghost">Replay</button><button id="next-level">Next level</button></div>
  </div>
`;
