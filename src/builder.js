import {
  PIECES, PIECE_BY_ID, ROT_SNAP, SNAP_VERTEX,
  worldPoints, transformString, pointsString, centroid, edgesOf, overlaps,
  sub, dot, cross, len, unit, dist, clamp, segDist, figureBounds, placementFlip
} from './shared.js';
import { createContactEngine, DEFAULT_BOARD, placeAlong, placeFromPivot } from './contact-engine.js';
import { createLevel, deleteLevel, listLevels, updateLevel } from './levels.js';

// Level authoring is intentionally reversible: compose a goal freely, then
// deconstruct it using the same contact rules as the game. The resulting start
// is therefore reachable by replaying the authored path in reverse.

const VERTEX_SNAP = 16;
const placements = {};
const contact = createContactEngine(placements, DEFAULT_BOARD);
let targets = {};
let phase = 'goal';
let selected = null;
let drag = null;
let moveHistory = [];
let finalizedLevel = null;
let editingId = null;
let savedLevels = [];
let saving = false;
let board;
let pieceLayer;
let goalLayer;
let guideLayer;

const TRAY = {
  mountain: [110, 120, 0], shadow: [330, 120, 0], reed: [520, 110, 45],
  stone: [110, 330, 0], bridge: [250, 330, 0], wing: [430, 330, 0], beak: [560, 330, 0]
};

export function mountBuilder(root) {
  root.innerHTML = TEMPLATE;
  board = root.querySelector('#build-board');
  pieceLayer = root.querySelector('#build-pieces');
  goalLayer = root.querySelector('#build-goal');
  guideLayer = root.querySelector('#build-guides');

  PIECES.forEach((piece) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'piece build-piece');
    group.setAttribute('data-id', piece.id);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', piece.name);
    group.style.setProperty('--piece-color', piece.color);
    const points = pointsString(piece.shape);
    group.innerHTML = `<polygon class="hit-area" points="${points}"/><polygon class="piece-face" points="${points}"/>`;
    group.addEventListener('pointerdown', (event) => beginPointer(event, piece, group));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selected = piece.id; refresh(); }
    });
    pieceLayer.appendChild(group);
  });

  wire(root);
  newLevel();
  refreshSavedLevels(root);
}

function clientToBoard(event) {
  const point = board.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(pieceLayer.getScreenCTM().inverse());
}

function beginPointer(event, piece, element) {
  if (phase === 'final') return;
  event.preventDefault();
  event.stopPropagation();
  selected = piece.id;
  if (phase === 'goal') beginFreeformDrag(event, piece, element);
  else beginContactDrag(event, piece, element);
}

function beginFreeformDrag(event, piece, element) {
  element.setPointerCapture(event.pointerId);
  const point = clientToBoard(event);
  drag = {
    type: 'freeform', id: piece.id, element, pointerId: event.pointerId,
    offset: sub([point.x, point.y], placements[piece.id]), start: [...placements[piece.id]]
  };
  pieceLayer.appendChild(element);
  refresh();
}

function beginContactDrag(event, piece, element) {
  element.setPointerCapture(event.pointerId);
  const point = clientToBoard(event);
  const grab = [point.x, point.y];
  const corners = contact.contactCorners(piece.id);
  const rails = contact.contactRails(piece.id);
  if (!corners.length && !rails.length) {
    drag = { type: 'contact', pointerId: event.pointerId, element, piece, locked: true };
    element.classList.add('is-blocked');
    navigator.vibrate?.(12);
    refresh();
    showNotice('This piece has no contact to move along.');
    return;
  }
  drag = {
    type: 'contact', pointerId: event.pointerId, element, piece, mode: 'pending',
    hood: contact.neighbourhood(piece.id), rails, corners, grab,
    start: [...placements[piece.id]], current: [...placements[piece.id]], moved: 0
  };
  pieceLayer.appendChild(element);
  refresh();
}

function decideContactGesture(state, direction, point) {
  const pivot = state.corners.length
    ? state.corners.slice().sort((a, b) => dist(a, state.grab) - dist(b, state.grab))[0]
    : null;
  const bestRail = () => {
    let best = null;
    let bestScore = -1;
    for (const rail of state.rails) {
      const score = Math.abs(dot(direction, rail.dir)) * (segDist(state.grab, rail.seg[0], rail.seg[1]) < 55 ? 1 : 0.001);
      if (score > bestScore) { bestScore = score; best = rail; }
    }
    return best;
  };
  const startSlide = (rail) => {
    state.mode = 'slide';
    state.dir = rail.dir;
    state.negLimit = contact.slideLimit(state.piece.id, -1, rail.dir, state.hood);
    state.posLimit = contact.slideLimit(state.piece.id, 1, rail.dir, state.hood);
  };
  const startRotate = (worldPivot) => {
    state.mode = 'rotate';
    state.pivot = worldPivot;
    state.localPivot = contact.localPivot(state.piece.id, worldPivot);
    state.flip = placementFlip(state.start);
    state.startAngle = Math.atan2(point[1] - worldPivot[1], point[0] - worldPivot[0]);
    state.negLimit = contact.rotateLimit(state.piece.id, -1, worldPivot, state.localPivot, state.hood);
    state.posLimit = contact.rotateLimit(state.piece.id, 1, worldPivot, state.localPivot, state.hood);
  };
  if (pivot && dist(pivot, state.grab) <= 20) {
    startRotate(pivot);
    if (state.negLimit < 0.5 && state.posLimit < 0.5) { const rail = bestRail(); if (rail) startSlide(rail); }
  } else {
    const rail = bestRail();
    if (rail) startSlide(rail);
    else if (pivot) startRotate(pivot);
  }
  refresh();
}

function movePointer(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (drag.locked) return;
  const point = clientToBoard(event);
  if (drag.type === 'freeform') {
    const current = placements[drag.id];
    placements[drag.id] = [point.x - drag.offset[0], point.y - drag.offset[1], current[2], placementFlip(current)];
    drag.element.setAttribute('transform', transformString(placements[drag.id]));
    return;
  }
  const worldPoint = [point.x, point.y];
  if (drag.mode === 'pending') {
    const direction = sub(worldPoint, drag.grab);
    if (len(direction) < 5) return;
    decideContactGesture(drag, unit(direction), worldPoint);
    if (drag.mode === 'pending') return;
  }
  if (drag.mode === 'slide') {
    const distance = clamp(dot(sub(worldPoint, drag.grab), drag.dir), -drag.negLimit, drag.posLimit);
    drag.moved = Math.abs(distance);
    drag.current = placeAlong(drag.start, drag.dir, distance);
  } else {
    const angle = Math.atan2(worldPoint[1] - drag.pivot[1], worldPoint[0] - drag.pivot[0]);
    let delta = angle - drag.startAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const degrees = clamp(delta * 180 / Math.PI, -drag.negLimit, drag.posLimit);
    drag.moved = Math.abs(degrees);
    drag.current = placeFromPivot(drag.pivot, drag.localPivot, drag.start[2] + degrees, drag.flip);
  }
  drag.element.setAttribute('transform', transformString(drag.current));
}

function snapRotation(state, place) {
  const snapped = Math.round(place[2] / ROT_SNAP) * ROT_SNAP;
  if (snapped >= state.start[2] - state.negLimit - 0.01 && snapped <= state.start[2] + state.posLimit + 0.01) {
    const candidate = placeFromPivot(state.pivot, state.localPivot, snapped, state.flip);
    if (contact.lawful(state.piece.id, candidate, state.hood)) return candidate;
  }
  return place;
}

function snapSlide(state, place) {
  const distance = dot(sub(place, state.start), state.dir);
  const moving = worldPoints(state.piece, place);
  let bestDistance = distance;
  let bestDelta = SNAP_VERTEX;
  for (const other of state.hood) for (const neighbour of other) for (const vertex of moving) {
    const difference = sub(neighbour, vertex);
    if (Math.abs(cross(state.dir, difference)) > SNAP_VERTEX) continue;
    const along = dot(difference, state.dir);
    if (Math.abs(along) >= bestDelta) continue;
    const candidateDistance = distance + along;
    if (candidateDistance < -state.negLimit - 0.01 || candidateDistance > state.posLimit + 0.01) continue;
    if (contact.lawful(state.piece.id, placeAlong(state.start, state.dir, candidateDistance), state.hood)) {
      bestDelta = Math.abs(along);
      bestDistance = candidateDistance;
    }
  }
  return placeAlong(state.start, state.dir, bestDistance);
}

function endPointer(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const state = drag;
  drag = null;
  if (state.element.hasPointerCapture?.(event.pointerId)) state.element.releasePointerCapture(event.pointerId);
  state.element.classList.remove('is-blocked');
  if (state.type === 'freeform') {
    snapToNeighbours(state.id);
    refresh();
    return;
  }
  if (state.locked || state.mode === 'pending') { refresh(); return; }
  let target = state.current;
  if (state.mode === 'rotate') target = snapRotation(state, target);
  else target = snapSlide(state, target);
  const before = placements[state.piece.id];
  const changed = dist(target, before) > 0.5 || Math.abs(target[2] - before[2]) > 0.1;
  if (changed && contact.lawful(state.piece.id, target, state.hood)) {
    moveHistory.push(snapshot());
    placements[state.piece.id] = target;
    showNotice(state.mode === 'rotate' ? 'Reverse pivot recorded.' : 'Reverse slide recorded.');
  } else {
    state.element.setAttribute('transform', transformString(before));
  }
  refresh();
}

function cancelPointer(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const state = drag;
  drag = null;
  state.element.classList.remove('is-blocked');
  if (state.type === 'freeform') placements[state.id] = state.start;
  else if (state.start) placements[state.piece.id] = state.start;
  refresh();
}

function snapToNeighbours(id) {
  const current = placements[id];
  const mine = worldPoints(PIECE_BY_ID[id], current);
  const candidates = [];
  const addCandidate = (offset, priority) => {
    const distance = len(offset);
    if (distance <= VERTEX_SNAP + 1e-6) candidates.push({ offset, distance, priority });
  };
  const closestPoint = (point, a, b) => {
    const ab = sub(b, a);
    const lengthSquared = dot(ab, ab);
    if (lengthSquared < 1e-9) return a;
    const t = clamp(dot(sub(point, a), ab) / lengthSquared, 0, 1);
    return [a[0] + ab[0] * t, a[1] + ab[1] * t];
  };
  const mineEdges = edgesOf(mine);
  for (const other of PIECES) {
    if (other.id === id) continue;
    const otherPoints = worldPoints(other, placements[other.id]);
    const otherEdges = edgesOf(otherPoints);
    for (const vertex of mine) for (const neighbour of otherPoints) {
      addCandidate(sub(neighbour, vertex), 0);
    }
    for (const vertex of mine) for (const [a, b] of otherEdges) {
      addCandidate(sub(closestPoint(vertex, a, b), vertex), 1);
    }
    for (const neighbour of otherPoints) for (const [a, b] of mineEdges) {
      addCandidate(sub(neighbour, closestPoint(neighbour, a, b)), 1);
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.priority - b.priority);
  for (const candidate of candidates) {
    const place = [current[0] + candidate.offset[0], current[1] + candidate.offset[1], current[2], placementFlip(current)];
    const polygon = worldPoints(PIECE_BY_ID[id], place);
    const clear = PIECES.every((other) => other.id === id || !overlaps(polygon, worldPoints(other, placements[other.id]), 1.2));
    if (clear) { placements[id] = place; return; }
  }
  placements[id] = [Math.round(current[0] / 15) * 15, Math.round(current[1] / 15) * 15, current[2], placementFlip(current)];
}

function placeAroundCentroid(piece, place, rotation, flip) {
  const worldCenter = centroid(worldPoints(piece, place));
  const localCenter = centroid(piece.shape);
  const radians = rotation * Math.PI / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const localX = localCenter[0] * flip;
  return [
    worldCenter[0] - (localX * c - localCenter[1] * s),
    worldCenter[1] - (localX * s + localCenter[1] * c),
    rotation,
    flip
  ];
}

function rotateFreeform(delta) {
  if (phase !== 'goal' || !selected) return;
  const place = placements[selected];
  const rotation = ((place[2] + delta) % 360 + 360) % 360;
  placements[selected] = placeAroundCentroid(PIECE_BY_ID[selected], place, rotation, placementFlip(place));
  snapToNeighbours(selected);
  refresh();
}

function flipParallelogram() {
  if (phase !== 'goal' || selected !== 'bridge') return;
  const place = placements.bridge;
  placements.bridge = placeAroundCentroid(PIECE_BY_ID.bridge, place, place[2], -placementFlip(place));
  snapToNeighbours('bridge');
  refresh();
}

function overlapPairs() {
  const polygons = PIECES.map((piece) => worldPoints(piece, placements[piece.id]));
  const bad = [];
  for (let i = 0; i < polygons.length; i += 1) for (let j = i + 1; j < polygons.length; j += 1) {
    if (overlaps(polygons[i], polygons[j], 1.2)) bad.push(`${PIECES[i].id}/${PIECES[j].id}`);
  }
  return bad;
}

function allWithinBounds() {
  return PIECES.every((piece) => contact.withinBounds(worldPoints(piece, placements[piece.id])));
}

const rounded = (value) => Math.round(value * 1000) / 1000;
function currentPlacements() {
  const result = {};
  PIECES.forEach((piece) => {
    const place = placements[piece.id];
    result[piece.id] = [rounded(place[0]), rounded(place[1]), rounded(place[2])];
    if (placementFlip(place) === -1) result[piece.id].push(-1);
  });
  return result;
}

function snapshot() {
  return Object.fromEntries(PIECES.map((piece) => [piece.id, [...placements[piece.id]]]));
}

function restore(values) {
  PIECES.forEach((piece) => { placements[piece.id] = [...values[piece.id]]; });
}

function previewMarkup(values) {
  const bounds = figureBounds(values);
  const pad = 16;
  const polygons = PIECES.map((piece) => `<polygon points="${pointsString(worldPoints(piece, values[piece.id]))}"/>`).join('');
  return `<svg viewBox="${bounds.minX - pad} ${bounds.minY - pad} ${bounds.w + 2 * pad} ${bounds.h + 2 * pad}" preserveAspectRatio="xMidYMid meet">${polygons}</svg>`;
}

function difficultyFor(moves) {
  if (moves <= 4) return 'Easy';
  if (moves <= 9) return 'Medium';
  return 'Hard';
}

function renderGoal() {
  if (phase === 'goal') { goalLayer.innerHTML = ''; return; }
  goalLayer.innerHTML = PIECES.map((piece) => `<polygon class="silhouette" points="${pointsString(worldPoints(piece, targets[piece.id]))}"/>`).join('');
}

function renderGuides() {
  guideLayer.innerHTML = '';
  if (phase !== 'deconstruct' || !selected || drag?.locked) return;
  contact.contactRails(selected).forEach(({ seg }) => {
    const [[x1, y1], [x2, y2]] = seg;
    guideLayer.insertAdjacentHTML('beforeend', `<line class="available-edge-halo" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><line class="available-edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
  });
  const hood = contact.neighbourhood(selected);
  contact.contactCorners(selected).filter((pivot) => contact.cornerCanRotate(selected, pivot, hood))
    .forEach(([cx, cy]) => guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-point" cx="${cx}" cy="${cy}" r="4"/>`));
}

function updatePhaseUI() {
  const input = document.querySelector('#build-name');
  const primary = document.querySelector('#editor-primary');
  const undo = document.querySelector('#editor-undo');
  const fresh = document.querySelector('#editor-new');
  const exportPanel = document.querySelector('#export-panel');
  const controls = document.querySelector('#goal-controls');
  input.disabled = phase !== 'goal';
  controls.hidden = phase !== 'goal';
  primary.hidden = phase === 'final';
  primary.textContent = phase === 'goal' ? 'Begin deconstruction' : 'Finalize level';
  undo.hidden = phase !== 'deconstruct';
  undo.disabled = moveHistory.length === 0;
  fresh.hidden = phase !== 'final';
  exportPanel.hidden = phase !== 'final';
  const save = document.querySelector('#save-level');
  if (!saving) save.textContent = editingId ? 'Update level' : 'Save level';
  document.querySelectorAll('.editor-steps li').forEach((step) => step.toggleAttribute('aria-current', step.dataset.phase === phase));
  const copy = phase === 'goal'
    ? 'Compose the finished silhouette freely. Name it before moving on.'
    : phase === 'deconstruct'
      ? 'Move pieces only along real contact rails and pivots. Each reverse move raises the authored difficulty.'
      : 'The start and goal are locked. Save the level to the shared database.';
  document.querySelector('#phase-copy').textContent = copy;
}

function refresh() {
  PIECES.forEach((piece) => {
    const element = pieceLayer.querySelector(`[data-id="${piece.id}"]`);
    if (!drag || drag.piece?.id !== piece.id) element.setAttribute('transform', transformString(placements[piece.id]));
    element.classList.toggle('is-selected', selected === piece.id);
    element.setAttribute('aria-pressed', String(selected === piece.id));
  });
  renderGoal();
  renderGuides();
  document.querySelector('#build-preview').innerHTML = previewMarkup(phase === 'goal' ? placements : targets);
  const status = document.querySelector('#build-status');
  if (phase === 'goal') {
    const overlapsFound = overlapPairs().length;
    if (overlapsFound) { status.textContent = `${overlapsFound} overlap${overlapsFound > 1 ? 's' : ''}`; status.className = 'build-status bad'; }
    else if (!contact.connected()) { status.textContent = 'Goal must be connected'; status.className = 'build-status bad'; }
    else { status.textContent = 'Goal is valid'; status.className = 'build-status ok'; }
  } else {
    const moves = moveHistory.length;
    status.textContent = phase === 'final' ? `Finalized · ${difficultyFor(moves)}` : `${moves} reverse move${moves === 1 ? '' : 's'} · ${difficultyFor(moves)}`;
    status.className = 'build-status ok';
  }
  document.querySelector('#move-total').textContent = String(moveHistory.length).padStart(2, '0');
  document.querySelector('#difficulty').textContent = moveHistory.length ? difficultyFor(moveHistory.length) : '—';
  const flipButton = document.querySelector('#flip-piece');
  flipButton.disabled = selected !== 'bridge';
  flipButton.setAttribute('aria-pressed', String(selected === 'bridge' && placementFlip(placements.bridge) === -1));
  updatePhaseUI();
}

function beginDeconstruction() {
  const name = document.querySelector('#build-name').value.trim();
  if (!name) { flash('Name the level first'); document.querySelector('#build-name').focus(); return; }
  if (overlapPairs().length) { flash('Fix overlaps before deconstructing'); return; }
  if (!allWithinBounds()) { flash('Keep every piece inside the board'); return; }
  if (!contact.connected()) { flash('The goal must be one connected figure'); return; }
  targets = snapshot();
  moveHistory = [];
  selected = null;
  phase = 'deconstruct';
  refresh();
  flash('Goal locked. Now deconstruct it.');
}

function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'level'; }

function finalizeLevel() {
  if (!moveHistory.length) { flash('Record at least one reverse move first'); return; }
  const name = document.querySelector('#build-name').value.trim();
  const moves = moveHistory.length;
  finalizedLevel = {
    id: editingId || slug(name),
    name,
    difficulty: difficultyFor(moves).toLowerCase(),
    solutionMoves: moves,
    start: currentPlacements(),
    targets: Object.fromEntries(PIECES.map((piece) => {
      const place = targets[piece.id];
      const value = [rounded(place[0]), rounded(place[1]), rounded(place[2])];
      if (placementFlip(place) === -1) value.push(-1);
      return [piece.id, value];
    }))
  };
  selected = null;
  phase = 'final';
  refresh();
  flash('Level finalized.');
}

function primaryAction() {
  if (phase === 'goal') beginDeconstruction();
  else if (phase === 'deconstruct') finalizeLevel();
}

function undoMove() {
  if (phase !== 'deconstruct' || !moveHistory.length) return;
  restore(moveHistory.pop());
  selected = null;
  refresh();
  showNotice('Last reverse move removed.');
}

function newLevel() {
  PIECES.forEach((piece) => { placements[piece.id] = [...TRAY[piece.id]]; });
  targets = {};
  phase = 'goal';
  selected = null;
  drag = null;
  moveHistory = [];
  finalizedLevel = null;
  editingId = null;
  document.querySelector('#build-name').value = '';
  refresh();
}

function editLevel(level) {
  editingId = level.id;
  finalizedLevel = null;
  targets = {};
  phase = 'goal';
  selected = null;
  drag = null;
  moveHistory = [];
  PIECES.forEach((piece) => {
    const placement = level.targets[piece.id];
    placements[piece.id] = placement ? [...placement] : [...TRAY[piece.id]];
  });
  document.querySelector('#build-name').value = level.name;
  refresh();
  flash(`Editing ${level.name}`);
}

function renderSavedLevels(root) {
  const list = root.querySelector('#saved-list');
  list.replaceChildren();
  if (!savedLevels.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No levels in the database.';
    list.appendChild(empty);
    return;
  }
  for (const level of savedLevels) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = level.name;
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => editLevel(level));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${level.name}”?`)) return;
      try {
        await deleteLevel(level.id);
        if (editingId === level.id) newLevel();
        await refreshSavedLevels(root);
        flash('Level deleted');
      } catch (error) { flash(error.message); }
    });
    actions.append(edit, remove);
    item.append(name, actions);
    list.appendChild(item);
  }
}

async function refreshSavedLevels(root) {
  const list = root.querySelector('#saved-list');
  list.innerHTML = '<li class="empty">Loading levels…</li>';
  try {
    savedLevels = await listLevels();
    renderSavedLevels(root);
  } catch (error) {
    list.innerHTML = '<li class="empty">Could not load levels.</li>';
    flash(error.message);
  }
}

async function saveFinalized(root) {
  if (!finalizedLevel || saving) return;
  const button = root.querySelector('#save-level');
  saving = true;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const saved = editingId
      ? await updateLevel(editingId, { ...finalizedLevel, id: editingId })
      : await createLevel(finalizedLevel);
    editingId = saved.id;
    finalizedLevel = saved;
    await refreshSavedLevels(root);
    button.textContent = 'Saved';
    flash('Level saved to database');
  } catch (error) {
    flash(error.message);
  } finally {
    saving = false;
    button.disabled = false;
  }
}

let noticeTimer;
function showNotice(message) {
  const notice = document.querySelector('#build-notice');
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.add('is-visible');
  noticeTimer = setTimeout(() => notice.classList.remove('is-visible'), 2200);
}

let flashTimer;
function flash(message) {
  const element = document.querySelector('#build-flash');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => element.classList.remove('show'), 2400);
}

function wire(root) {
  window.addEventListener('pointermove', movePointer, { passive: false });
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', cancelPointer);
  board.addEventListener('pointerdown', () => { if (!drag) { selected = null; refresh(); } });
  root.querySelector('#rotate-ccw').addEventListener('click', () => rotateFreeform(-45));
  root.querySelector('#rotate-cw').addEventListener('click', () => rotateFreeform(45));
  root.querySelector('#flip-piece').addEventListener('click', flipParallelogram);
  root.querySelector('#editor-primary').addEventListener('click', primaryAction);
  root.querySelector('#editor-undo').addEventListener('click', undoMove);
  root.querySelector('#editor-new').addEventListener('click', newLevel);
  root.querySelector('#save-level').addEventListener('click', () => saveFinalized(root));
  document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (phase === 'goal' && event.key === '[') { event.preventDefault(); rotateFreeform(-45); }
    if (phase === 'goal' && event.key === ']') { event.preventDefault(); rotateFreeform(45); }
    if (phase === 'goal' && (event.key === 'f' || event.key === 'F')) flipParallelogram();
    if (phase === 'deconstruct' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoMove(); }
  });
}

const TEMPLATE = `
  <div class="builder editor">
    <header class="build-head">
      <div class="brand"><span class="brand-mark">間</span><span class="brand-name">MA · Editor</span></div>
      <div class="build-status ok" id="build-status">Goal is valid</div>
      <a class="text-button" href="#">← Back to game</a>
    </header>
    <ol class="editor-steps" aria-label="Level creation progress">
      <li data-phase="goal" aria-current="true"><span>01</span><strong>Compose goal</strong></li>
      <li data-phase="deconstruct"><span>02</span><strong>Deconstruct</strong></li>
      <li data-phase="final"><span>03</span><strong>Finalize</strong></li>
    </ol>
    <div class="build-main editor-main">
      <div class="build-stage">
        <svg id="build-board" class="build-board" viewBox="0 -90 760 570" role="group" aria-label="Tangram level editor">
          <defs><pattern id="editor-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#e7e2d6" stroke-width="1"/></pattern></defs>
          <rect x="0" y="-90" width="760" height="570" fill="url(#editor-grid)"/>
          <g id="build-goal" aria-hidden="true"></g>
          <g id="build-pieces"></g>
          <g id="build-guides" aria-hidden="true"></g>
        </svg>
        <p class="build-tip" id="phase-copy">Compose the finished silhouette freely. Name it before moving on.</p>
        <div id="build-notice" class="notice build-notice" role="status" aria-live="polite"></div>
      </div>
      <aside class="build-panel">
        <label class="field"><span>Level name</span><input id="build-name" placeholder="e.g. Owl" autocomplete="off"/></label>
        <div id="goal-controls" class="build-rotate"><button class="ghost" id="rotate-ccw">⟲ 45°</button><button class="ghost" id="rotate-cw">45° ⟳</button><button class="ghost" id="flip-piece" disabled>Mirror</button></div>
        <div class="editor-metrics"><div><span id="move-total">00</span><small>REVERSE MOVES</small></div><div><strong id="difficulty">—</strong><small>AUTHORED ROUTE</small></div></div>
        <div class="build-preview-wrap"><span class="eyebrow">Goal silhouette</span><div id="build-preview" class="build-preview"></div></div>
        <div class="build-actions editor-actions"><button id="editor-primary">Begin deconstruction</button><button class="ghost" id="editor-undo" hidden disabled>Undo move</button><button class="ghost" id="editor-new" hidden>New level</button></div>
        <div id="export-panel" class="export-panel" hidden>
          <button id="save-level" class="save-level">Save level</button>
        </div>
        <div class="saved"><span class="eyebrow">Database levels</span><ul id="saved-list"><li class="empty">Loading levels…</li></ul></div>
      </aside>
    </div>
    <div id="build-flash" class="build-flash"></div>
  </div>
`;
