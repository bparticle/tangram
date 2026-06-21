import {
  PIECES, PIECE_BY_ID, ROT_SNAP, SNAP_VERTEX,
  worldPoints, transformString, pointsString, centroid, edgesOf, overlaps, touches, pointOnSeg,
  sub, dot, cross, len, unit, dist, clamp, rotateVec, normalizedAngleDelta, segDist, figureBounds, placementFlip
} from './shared.js';
import { createContactEngine, DEFAULT_BOARD, placeAlong, placeFromPivot } from './contact-engine.js';
import { createLevel, deleteLevel, listLevels, updateLevel } from './levels.js';
import { getSession, login, logout } from './auth.js';
import { createModifierZone, coarsePointer } from './modifier-zone.js';

// Level authoring is intentionally reversible: compose a goal freely, then
// deconstruct it using the same contact rules as the game. The resulting start
// is therefore reachable by replaying the authored path in reverse.

const VERTEX_SNAP = 28;   // px: how far a corner/edge can reach to seat onto a neighbour
const SEAT_FINE = 1.5;    // px: corners this close are treated as the same point
const REST_GRID = 15;     // px: resting grid used only when a piece touches nothing
const placements = {};
const contact = createContactEngine(placements, DEFAULT_BOARD);
let targets = {};
let phase = 'goal';
let selected = null;
const selection = new Set();
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
let modifierZone = null;
let snapToggle = null;
// Goal-phase preference: when on (default), a freely-dropped piece seats its
// corners onto neighbours. When off, the author can translate to arbitrary
// positions. Only governs translation — rotation always stays in 45° steps,
// and the deconstruct/game contact snapping is untouched so reverse moves stay
// reproducible in the game. Persists across levels as a tool setting.
let snapEnabled = true;
let builderCleanup = null;

export function unmountBuilder() {
  builderCleanup?.();
  builderCleanup = null;
  modifierZone?.destroy();
  modifierZone = null;
  snapToggle?.destroy();
  snapToggle = null;
}

const TRAY = {
  mountain: [110, 120, 0], shadow: [330, 120, 0], reed: [520, 110, 45],
  stone: [110, 330, 0], bridge: [250, 330, 0], wing: [430, 330, 0], beak: [560, 330, 0]
};

// The editor is for the single author only. Reads are public, so the game plays
// for everyone, but composing levels requires a session. Gate the route behind a
// login screen and only build the editor once authenticated.
export async function mountBuilder(root) {
  unmountBuilder();
  let session;
  try { session = await getSession(); } catch { session = { authenticated: false }; }
  if (session.authenticated) buildEditor(root);
  else mountLogin(root);
}

function mountLogin(root) {
  root.innerHTML = LOGIN_TEMPLATE;
  const form = root.querySelector('#login-form');
  const input = root.querySelector('#login-password');
  const error = root.querySelector('#login-error');
  const ac = new AbortController();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await login(input.value);
      buildEditor(root);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      input.select();
    }
  }, { signal: ac.signal });
  input.focus();
  builderCleanup = () => ac.abort();
}

function buildEditor(root) {
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
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSelection(piece.id); refresh(); }
    });
    pieceLayer.appendChild(group);
  });

  builderCleanup = wire(root);
  newLevel();
  refreshSavedLevels(root);
}

function clientToBoard(event) {
  const point = board.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(pieceLayer.getScreenCTM().inverse());
}

function selectOnly(id) { selection.clear(); if (id) selection.add(id); selected = id; }
function clearSelection() { selection.clear(); selected = null; }
function toggleSelection(id) {
  if (selection.has(id)) {
    selection.delete(id);
    if (selected === id) selected = selection.size ? [...selection][selection.size - 1] : null;
  } else { selection.add(id); selected = id; }
}

function beginPointer(event, piece, element) {
  if (phase === 'final') return;
  event.preventDefault();
  event.stopPropagation();
  // Shift/ctrl/meta toggles group membership. Dragging a piece that is part of a
  // 2+ selection moves the whole group; otherwise it moves just that piece. The
  // group moves freely while composing the goal, but rides the contact rules
  // while deconstructing — so a connected cluster travels together and no piece
  // is stranded behind it.
  if (modifierZone?.isGroupModifier(event)) { toggleSelection(piece.id); refresh(); return; }
  if (selection.size >= 2 && selection.has(piece.id)) {
    if (phase === 'goal') beginGroupFreeformDrag(event, element);
    else beginGroupContactDrag(event, element);
    return;
  }
  selectOnly(piece.id);
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

function beginGroupFreeformDrag(event, element) {
  element.setPointerCapture(event.pointerId);
  const point = clientToBoard(event);
  const members = [...selection];
  const starts = {};
  members.forEach((id) => { starts[id] = [...placements[id]]; });
  drag = { type: 'group', kind: 'free', pointerId: event.pointerId, element, members, starts, grab: [point.x, point.y] };
  // Raise the whole group so it reads as one moving cluster.
  members.forEach((id) => { const node = pieceLayer.querySelector(`[data-id="${id}"]`); if (node) pieceLayer.appendChild(node); });
  refresh();
}

// Deconstruct-phase group move: the selection travels as one rigid cluster but
// obeys the contact rules against the pieces left behind (the "static" set) —
// it stays touching them and never overlaps. Grab near a shared corner to pivot
// the cluster, anywhere else to slide it.
function beginGroupContactDrag(event, element) {
  element.setPointerCapture(event.pointerId);
  const point = clientToBoard(event);
  const grab = [point.x, point.y];
  const members = [...selection];
  const starts = {};
  members.forEach((id) => { starts[id] = [...placements[id]]; });
  const staticPolys = PIECES.filter((piece) => !selection.has(piece.id)).map((piece) => worldPoints(piece, placements[piece.id]));
  drag = { type: 'group', kind: 'contact', pointerId: event.pointerId, element, members, starts, staticPolys, grab, delta: [0, 0], angle: 0, moved: 0, mode: 'translate' };
  const pivot = groupCorners(members).sort((a, b) => dist(a, grab) - dist(b, grab))[0];
  if (pivot && dist(pivot, grab) <= 20) {
    drag.mode = 'rotate';
    drag.pivot = pivot;
    drag.startAngle = Math.atan2(grab[1] - pivot[1], grab[0] - pivot[0]);
    drag.negLimit = groupRotationLimit(drag, -1);
    drag.posLimit = groupRotationLimit(drag, 1);
    if (drag.negLimit < 0.5 && drag.posLimit < 0.5) drag.mode = 'translate';
  }
  members.forEach((id) => { const node = pieceLayer.querySelector(`[data-id="${id}"]`); if (node) pieceLayer.appendChild(node); });
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
  if (drag.type === 'group') {
    if (drag.kind === 'contact') {
      if (drag.mode === 'rotate') {
        const angle = Math.atan2(point.y - drag.pivot[1], point.x - drag.pivot[0]);
        drag.angle = clamp(normalizedAngleDelta(angle - drag.startAngle) * 180 / Math.PI, -drag.negLimit, drag.posLimit);
        drag.moved = Math.abs(drag.angle);
      } else {
        drag.delta = marchGroupContact(drag, sub([point.x, point.y], drag.grab));
        drag.moved = len(drag.delta);
      }
      applyGroupContactTransforms(drag);
      return;
    }
    const dx = point.x - drag.grab[0];
    const dy = point.y - drag.grab[1];
    for (const id of drag.members) {
      const s = drag.starts[id];
      placements[id] = [s[0] + dx, s[1] + dy, s[2], placementFlip(s)];
      pieceLayer.querySelector(`[data-id="${id}"]`).setAttribute('transform', transformString(placements[id]));
    }
    return;
  }
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
  if (state.type === 'group') {
    if (state.kind === 'contact') endGroupContact(state);
    else { snapGroupToNeighbours(state.members); refresh(); }
    return;
  }
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
  if (state.type === 'group') { for (const id of state.members) placements[id] = state.starts[id]; }
  else if (state.type === 'freeform') placements[state.id] = state.start;
  else if (state.start) placements[state.piece.id] = state.start;
  refresh();
}

// Find the single translation (within snap reach) that best seats a set of
// moving polygons against the fixed `outside` neighbours. Rotation is fixed
// (goal pieces only turn in 45° steps) and the pieces are grid-congruent, so a
// single correct corner coincidence seats them. Rather than snapping to the
// nearest vertex (which mistakes a near edge-projection for the intended corner
// and leaves gaps), we score every reachable translation by how cleanly it
// tiles: shared corners first, then edge contact, then least movement. Works
// for one piece or a whole group — a group just moves rigidly by one offset.
function bestSeatingOffset(movingPolys, outside) {
  if (!outside.length) return null;
  const closestPoint = (point, a, b) => {
    const ab = sub(b, a);
    const lengthSquared = dot(ab, ab);
    if (lengthSquared < 1e-9) return a;
    const t = clamp(dot(sub(point, a), ab) / lengthSquared, 0, 1);
    return [a[0] + ab[0] * t, a[1] + ab[1] * t];
  };
  const movingEdges = movingPolys.map(edgesOf);

  const offsets = [[0, 0]];
  const consider = (offset) => { if (len(offset) <= VERTEX_SNAP + 1e-6) offsets.push(offset); };
  movingPolys.forEach((poly, index) => {
    for (const neighbour of outside) {
      for (const vertex of poly) for (const point of neighbour.poly) consider(sub(point, vertex));
      for (const vertex of poly) for (const [a, b] of neighbour.edges) consider(sub(closestPoint(vertex, a, b), vertex));
      for (const point of neighbour.poly) for (const [a, b] of movingEdges[index]) consider(sub(point, closestPoint(point, a, b)));
    }
  });

  let best = null;
  for (const offset of offsets) {
    const shifted = movingPolys.map((poly) => poly.map(([x, y]) => [x + offset[0], y + offset[1]]));
    if (shifted.some((poly) => outside.some((neighbour) => overlaps(poly, neighbour.poly, 0.5)))) continue;
    let corners = 0;
    let contact = 0;
    for (const poly of shifted) {
      const polyEdges = edgesOf(poly);
      for (const neighbour of outside) {
        for (const vertex of poly) {
          if (neighbour.poly.some((point) => dist(vertex, point) < SEAT_FINE)) corners += 1;
          else if (neighbour.edges.some(([a, b]) => pointOnSeg(vertex, a, b))) contact += 1;
        }
        for (const point of neighbour.poly) {
          if (polyEdges.some(([a, b]) => pointOnSeg(point, a, b))) contact += 1;
        }
      }
    }
    const residual = len(offset);
    if (!best || corners > best.corners
        || (corners === best.corners && contact > best.contact)
        || (corners === best.corners && contact === best.contact && residual < best.residual)) {
      best = { corners, contact, residual, offset };
    }
  }
  return best && (best.corners > 0 || best.contact > 0) ? best.offset : null;
}

function outsideNeighbours(memberSet) {
  return PIECES
    .filter((piece) => !memberSet.has(piece.id))
    .map((piece) => { const poly = worldPoints(piece, placements[piece.id]); return { poly, edges: edgesOf(poly) }; });
}

function snapToNeighbours(id) {
  if (!snapEnabled) return;
  const current = placements[id];
  const flip = placementFlip(current);
  const offset = bestSeatingOffset([worldPoints(PIECE_BY_ID[id], current)], outsideNeighbours(new Set([id])));
  if (offset) { placements[id] = [current[0] + offset[0], current[1] + offset[1], current[2], flip]; return; }
  placements[id] = [Math.round(current[0] / REST_GRID) * REST_GRID, Math.round(current[1] / REST_GRID) * REST_GRID, current[2], flip];
}

// Seat a moved group as one rigid cluster: its internal arrangement is already
// fixed, so we only look for an offset that seats it against the outside pieces.
// No grid fallback — that would shear the group apart; a freely-placed group
// just stays where it was dropped.
function snapGroupToNeighbours(members) {
  if (!snapEnabled) return;
  const memberSet = new Set(members);
  const movingPolys = members.map((id) => worldPoints(PIECE_BY_ID[id], placements[id]));
  const offset = bestSeatingOffset(movingPolys, outsideNeighbours(memberSet));
  if (!offset) return;
  for (const id of members) {
    const place = placements[id];
    placements[id] = [place[0] + offset[0], place[1] + offset[1], place[2], placementFlip(place)];
  }
}

// --- contact-constrained group moves (deconstruct phase) -------------------
// A translated/rotated cluster is valid when every member stays in bounds, none
// overlaps a static piece, and the cluster still touches the static set (so it
// can never drift free and orphan the rest). Ported from the in-game group move
// so an authored group reverse-move is always reproducible by a group play-move.

function groupContactValid(delta, d) {
  let inContact = d.staticPolys.length === 0;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(PIECE_BY_ID[id], [s[0] + delta[0], s[1] + delta[1], s[2], placementFlip(s)]);
    if (!contact.withinBounds(poly)) return false;
    for (const staticPoly of d.staticPolys) {
      if (overlaps(poly, staticPoly)) return false;
      if (!inContact && touches(poly, staticPoly)) inContact = true;
    }
  }
  return inContact;
}

function marchGroupContact(d, desired) {
  let cur = d.delta;
  for (let i = 0; i < 280; i += 1) {
    const toGoal = sub(desired, cur);
    const distance = len(toGoal);
    if (distance < 0.4) break;
    const step = Math.min(2, distance);
    const u = [toGoal[0] / distance, toGoal[1] / distance];
    let advanced = false;
    for (const deg of [0, 12, -12, 25, -25, 40, -40, 58, -58, 75, -75]) {
      const dir = deg === 0 ? u : rotateVec(u, deg * Math.PI / 180);
      const cand = [cur[0] + dir[0] * step, cur[1] + dir[1] * step];
      if (groupContactValid(cand, d)) { cur = cand; advanced = true; break; }
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
    result[id] = [d.pivot[0] + dx * c - dy * s, d.pivot[1] + dx * s + dy * c, start[2] + angle, placementFlip(start)];
  }
  return result;
}

function groupRotationValid(angle, d) {
  const rotated = groupRotatedPlacements(d, angle);
  let inContact = d.staticPolys.length === 0;
  for (const id of d.members) {
    const poly = worldPoints(PIECE_BY_ID[id], rotated[id]);
    if (!contact.withinBounds(poly)) return false;
    for (const staticPoly of d.staticPolys) {
      if (overlaps(poly, staticPoly)) return false;
      if (!inContact && touches(poly, staticPoly)) inContact = true;
    }
  }
  return inContact;
}

function groupRotationLimit(d, sign) {
  let last = 0;
  for (let angle = 0.6; angle <= 180; angle += 0.6) {
    if (!groupRotationValid(sign * angle, d)) break;
    last = angle;
  }
  return last;
}

// Shared corners between the selected cluster and the static pieces — the points
// the cluster can pivot around.
function groupCorners(members) {
  const set = new Set(members);
  const points = [];
  const add = (point) => { if (!points.some((other) => dist(other, point) < 1)) points.push(point); };
  for (const id of members) {
    const poly = worldPoints(PIECE_BY_ID[id], placements[id]);
    const mineEdges = edgesOf(poly);
    for (const other of PIECES) {
      if (set.has(other.id)) continue;
      const otherPoly = worldPoints(other, placements[other.id]);
      const otherEdges = edgesOf(otherPoly);
      for (const vertex of poly) if (otherPoly.some((w) => dist(vertex, w) < 0.8) || otherEdges.some(([c, d]) => pointOnSeg(vertex, c, d))) add(vertex);
      for (const w of otherPoly) if (poly.some((vertex) => dist(vertex, w) < 0.8) || mineEdges.some(([a, b]) => pointOnSeg(w, a, b))) add(w);
    }
  }
  return points;
}

function applyGroupContactTransforms(d) {
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

function snapGroupContact(d) {
  let best = null;
  let bestDelta = SNAP_VERTEX;
  for (const id of d.members) {
    const s = d.starts[id];
    const poly = worldPoints(PIECE_BY_ID[id], [s[0] + d.delta[0], s[1] + d.delta[1], s[2], placementFlip(s)]);
    for (const vertex of poly) for (const staticPoly of d.staticPolys) for (const w of staticPoly) {
      const off = sub(w, vertex);
      const dd = len(off);
      if (dd >= bestDelta) continue;
      const cand = [d.delta[0] + off[0], d.delta[1] + off[1]];
      if (groupContactValid(cand, d)) { bestDelta = dd; best = cand; }
    }
  }
  if (best) d.delta = best;
}

function endGroupContact(d) {
  if (d.mode === 'rotate') {
    const snapped = Math.round(d.angle / ROT_SNAP) * ROT_SNAP;
    if (snapped >= -d.negLimit - 0.01 && snapped <= d.posLimit + 0.01 && groupRotationValid(snapped, d)) d.angle = snapped;
    if (Math.abs(d.angle) > 0.5 && groupRotationValid(d.angle, d)) {
      moveHistory.push(snapshot());
      const rotated = groupRotatedPlacements(d, d.angle);
      for (const id of d.members) placements[id] = rotated[id];
      showNotice(`Reverse-pivoted ${d.members.length} pieces together.`);
    }
    refresh();
    return;
  }
  snapGroupContact(d);
  if (len(d.delta) > 0.5 && groupContactValid(d.delta, d)) {
    moveHistory.push(snapshot());
    for (const id of d.members) { const s = d.starts[id]; placements[id] = [s[0] + d.delta[0], s[1] + d.delta[1], s[2], placementFlip(s)]; }
    showNotice(`Reverse-slid ${d.members.length} pieces together.`);
  }
  refresh();
}

// Place `piece` so its centroid lands exactly at `worldCenter` with the given
// rotation/flip. The building block for spinning a piece — or a group — in place.
function placeWithCentroidAt(piece, worldCenter, rotation, flip) {
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

function placeAroundCentroid(piece, place, rotation, flip) {
  return placeWithCentroidAt(piece, centroid(worldPoints(piece, place)), rotation, flip);
}

function rotateGoal(delta) {
  if (phase !== 'goal') return;
  const members = selection.size ? [...selection] : (selected ? [selected] : []);
  if (!members.length) return;
  if (members.length === 1) {
    const id = members[0];
    const place = placements[id];
    const rotation = ((place[2] + delta) % 360 + 360) % 360;
    placements[id] = placeAroundCentroid(PIECE_BY_ID[id], place, rotation, placementFlip(place));
    snapToNeighbours(id);
  } else {
    // Rotate the cluster rigidly about its shared centroid so internal contacts
    // are preserved, then seat the whole group against the outside pieces.
    const centers = members.map((id) => centroid(worldPoints(PIECE_BY_ID[id], placements[id])));
    const pivot = [
      centers.reduce((sum, c) => sum + c[0], 0) / centers.length,
      centers.reduce((sum, c) => sum + c[1], 0) / centers.length
    ];
    const radians = delta * Math.PI / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    members.forEach((id, index) => {
      const place = placements[id];
      const dx = centers[index][0] - pivot[0];
      const dy = centers[index][1] - pivot[1];
      const center = [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c];
      const rotation = ((place[2] + delta) % 360 + 360) % 360;
      placements[id] = placeWithCentroidAt(PIECE_BY_ID[id], center, rotation, placementFlip(place));
    });
    snapGroupToNeighbours(members);
  }
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
  if (phase !== 'deconstruct' || drag?.locked) return;
  if (selection.size >= 2) {
    // Show the corners the cluster can pivot around; sliding works anywhere else.
    for (const [cx, cy] of groupCorners([...selection])) {
      guideLayer.insertAdjacentHTML('beforeend', `<circle class="pivot-point" cx="${cx}" cy="${cy}" r="4"/>`);
    }
    return;
  }
  if (!selected) return;
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
  snapToggle?.setVisible(phase === 'goal');
  primary.hidden = phase === 'final';
  primary.textContent = phase === 'goal' ? 'Begin deconstruction' : 'Finalize level';
  undo.hidden = phase !== 'deconstruct';
  undo.disabled = moveHistory.length === 0;
  fresh.hidden = phase !== 'final';
  exportPanel.hidden = phase !== 'final';
  const save = document.querySelector('#save-level');
  if (!saving) save.textContent = editingId ? 'Update level' : 'Save level';
  document.querySelectorAll('.editor-steps li').forEach((step) => step.toggleAttribute('aria-current', step.dataset.phase === phase));
  const groupHint = coarsePointer() ? 'toggle Group' : 'shift-click';
  const copy = phase === 'goal'
    ? `Compose the finished silhouette freely — ${groupHint} to move or rotate pieces as a group. Name it before moving on.`
    : phase === 'deconstruct'
      ? `Move pieces only along real contact rails and pivots — ${groupHint} to move a connected cluster together so nothing is left stranded. Each reverse move raises the authored difficulty.`
      : 'The start and goal are locked. Save the level to the shared database.';
  document.querySelector('#phase-copy').textContent = copy;
}

function refresh() {
  const dragging = drag?.type === 'group' ? new Set(drag.members)
    : drag?.type === 'freeform' ? new Set([drag.id])
    : drag?.piece ? new Set([drag.piece.id]) : null;
  PIECES.forEach((piece) => {
    const element = pieceLayer.querySelector(`[data-id="${piece.id}"]`);
    if (!dragging || !dragging.has(piece.id)) element.setAttribute('transform', transformString(placements[piece.id]));
    element.classList.toggle('is-selected', selection.has(piece.id));
    element.setAttribute('aria-pressed', String(selection.has(piece.id)));
  });
  renderGoal();
  renderGuides();
  document.querySelector('#build-preview').innerHTML = previewMarkup(phase === 'goal' ? placements : targets);
  const status = document.querySelector('#build-status');
  if (phase === 'goal') {
    const overlapsFound = overlapPairs().length;
    if (overlapsFound) { status.textContent = `${overlapsFound} overlap${overlapsFound > 1 ? 's' : ''}`; status.className = 'build-status bad'; }
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
  targets = snapshot();
  moveHistory = [];
  clearSelection();
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
  clearSelection();
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
  clearSelection();
  refresh();
  showNotice('Last reverse move removed.');
}

function newLevel() {
  PIECES.forEach((piece) => { placements[piece.id] = [...TRAY[piece.id]]; });
  targets = {};
  phase = 'goal';
  clearSelection();
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
  clearSelection();
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

// A Snap toggle that sits beside the Group toggle. On by default; turning it off
// lets freeform drops (and post-rotate/flip reseats) land at arbitrary positions
// instead of seating corners onto neighbours. Only meaningful while composing the
// goal, so it hides itself once deconstruction begins.
function createSnapToggle(container, signal) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'snap-zone';
  button.innerHTML = '<span class="snap-zone-key" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4v7a6 6 0 0 0 12 0V4h-3.5v7a2.5 2.5 0 0 1-5 0V4z"/></svg></span><span class="snap-zone-label">Snap</span>';
  const apply = () => {
    button.classList.toggle('is-off', !snapEnabled);
    button.setAttribute('aria-pressed', String(snapEnabled));
    button.setAttribute('aria-label', snapEnabled
      ? 'Snapping on — dropped pieces seat corners onto neighbours. Tap to translate freely.'
      : 'Snapping off — dropped pieces stay where placed. Tap to seat corners onto neighbours.');
  };
  button.addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    apply();
    navigator.vibrate?.(6);
    showNotice(snapEnabled ? 'Snapping on — corners seat onto neighbours.' : 'Snapping off — pieces translate freely.');
  }, { signal });
  apply();
  container.appendChild(button);
  return {
    setVisible(on) { button.hidden = !on; },
    destroy() { button.remove(); }
  };
}

function wire(root) {
  const ac = new AbortController();
  const { signal } = ac;
  window.addEventListener('pointermove', movePointer, { passive: false, signal });
  window.addEventListener('pointerup', endPointer, { signal });
  window.addEventListener('pointercancel', cancelPointer, { signal });
  board.addEventListener('pointerdown', () => { if (!drag) { clearSelection(); refresh(); } }, { signal });
  root.querySelector('#rotate-ccw').addEventListener('click', () => rotateGoal(-45), { signal });
  root.querySelector('#rotate-cw').addEventListener('click', () => rotateGoal(45), { signal });
  root.querySelector('#flip-piece').addEventListener('click', flipParallelogram, { signal });
  root.querySelector('#editor-primary').addEventListener('click', primaryAction, { signal });
  root.querySelector('#editor-undo').addEventListener('click', undoMove, { signal });
  root.querySelector('#editor-new').addEventListener('click', newLevel, { signal });
  root.querySelector('#save-level').addEventListener('click', () => saveFinalized(root), { signal });
  root.querySelector('#editor-logout').addEventListener('click', async () => {
    try { await logout(); } finally { unmountBuilder(); mountLogin(root); }
  }, { signal });
  document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (phase === 'goal' && event.key === '[') { event.preventDefault(); rotateGoal(-45); }
    if (phase === 'goal' && event.key === ']') { event.preventDefault(); rotateGoal(45); }
    if (phase === 'goal' && (event.key === 'f' || event.key === 'F')) flipParallelogram();
    if (phase === 'deconstruct' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoMove(); }
  }, { signal });
  modifierZone = createModifierZone(root.querySelector('.build-stage'), { signal });
  snapToggle = createSnapToggle(root.querySelector('.build-stage'), signal);
  return () => {
    modifierZone?.destroy();
    modifierZone = null;
    snapToggle?.destroy();
    snapToggle = null;
    ac.abort();
  };
}

const LOGIN_TEMPLATE = `
  <div class="editor-login">
    <form id="login-form" class="login-card" novalidate>
      <div class="brand"><span class="brand-mark" lang="ja">間</span><span class="brand-name">MA · Editor</span></div>
      <p class="login-copy">This area is for the level author. Enter the password to continue.</p>
      <label class="field"><span>Password</span><input id="login-password" type="password" autocomplete="current-password" autofocus/></label>
      <p id="login-error" class="login-error" role="alert"></p>
      <button type="submit">Enter editor</button>
      <a class="text-button" href="#">← Back to game</a>
    </form>
  </div>
`;

const TEMPLATE = `
  <div class="builder editor">
    <header class="build-head">
      <div class="brand"><span class="brand-mark" lang="ja">間</span><span class="brand-name">MA · Editor</span></div>
      <div class="build-status ok" id="build-status">Goal is valid</div>
      <div class="build-head-actions">
        <button type="button" class="text-button" id="editor-logout">Log out</button>
        <a class="text-button" href="#">← Back to game</a>
      </div>
    </header>
    <ol class="editor-steps" aria-label="Level creation progress">
      <li data-phase="goal" aria-current="true"><span>01</span><strong>Compose goal</strong></li>
      <li data-phase="deconstruct"><span>02</span><strong>Deconstruct</strong></li>
      <li data-phase="final"><span>03</span><strong>Finalize</strong></li>
    </ol>
    <div class="build-main editor-main">
      <div class="build-stage">
        <svg id="build-board" class="build-board" viewBox="0 -90 760 570" role="group" aria-label="Tangram level editor">
          <defs>
            <pattern id="editor-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#e7e2d6" stroke-width="1"/></pattern>
            <filter id="paper-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#342d23" flood-opacity=".16" /></filter>
            <filter id="edge-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
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
