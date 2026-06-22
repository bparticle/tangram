import {
  PIECES, PIECE_BY_ID, ROT_SNAP, SNAP_VERTEX,
  sub, dot, cross, len, unit, dist, clamp, rotateVec,
  worldPoints, edgesOf, overlaps, touches, pointOnSeg, segDist, placementFlip
} from './shared.js';

export const DEFAULT_BOARD = { minX: -4, maxX: 764, minY: -88, maxY: 484 };

// A slide is only legal where a *side* of the moving body lies along an edge of
// another piece. The collinear overlap that proves it must be at least this long
// — a bare corner grazing an edge (zero-length overlap) is not enough to ride.
export const MIN_RAIL_OVERLAP = 6;

// One drag, many shapes. These tune how a still-pending drag is read as a slide
// (motion runs *along* a rail) versus a pivot (motion arcs *across* the radius
// from a contact corner). They are shared by single pieces and groups, and by
// the game and the builder's deconstruction, so the read never drifts apart.
export const GESTURE = {
  DEAD_ZONE: 8,       // px of travel before any interpretation begins
  COMMIT_SEP: 0.16,   // alignment margin one hypothesis must lead by to lock
  MIN_SLIDE_PX: 6,    // real along-rail travel before a slide commits
  MIN_ROT_DEG: 4,     // real swept angle before a rotation commits
  HARD_COMMIT: 24,    // past this much travel, stop waiting and pick the leader
  CORNER_BIAS: 16,    // grabbing this close to a corner tip leans toward a pivot
  ROT_MAGNET: 9,      // live rotation sticks to a reachable 45° stop within this
  RAIL_NEAR_PIECE: 60,// px: a rail this near the grab is preferred (single piece)
  RAIL_NEAR_GROUP: 90 // px: same, relaxed for the larger reach of a group
};

export const placeAlong = (start, direction, distance) => [
  start[0] + distance * direction[0],
  start[1] + distance * direction[1],
  start[2],
  placementFlip(start)
];

export function placeFromPivot(worldPivot, localPivot, degrees, flip = 1) {
  const radians = degrees * Math.PI / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const localX = localPivot[0] * flip;
  return [
    worldPivot[0] - (localX * c - localPivot[1] * s),
    worldPivot[1] - (localX * s + localPivot[1] * c),
    degrees,
    flip
  ];
}

export function collinearOverlap(a, b, c, d) {
  const ab = sub(b, a);
  const length = len(ab);
  if (length < 1e-6) return null;
  const direction = [ab[0] / length, ab[1] / length];
  if (Math.abs(cross(direction, unit(sub(d, c)))) > 0.03) return null;
  if (Math.abs(cross(direction, sub(c, a))) > 0.8) return null;
  const tc = dot(sub(c, a), direction);
  const td = dot(sub(d, a), direction);
  const low = Math.max(0, Math.min(tc, td));
  const high = Math.min(length, Math.max(tc, td));
  if (high - low <= 0.8) return null;
  return [
    [a[0] + direction[0] * low, a[1] + direction[1] * low],
    [a[0] + direction[0] * high, a[1] + direction[1] * high]
  ];
}

// Does a side of polyA lie flat along an edge of polyB, overlapping for a real
// length? This is the "side along an edge" test that makes a slide legal — used
// for both single pieces and groups, so a cluster can never ride a surface on a
// single corner either.
export function edgeContact(polyA, polyB, minOverlap = MIN_RAIL_OVERLAP) {
  for (const [a, b] of edgesOf(polyA)) for (const [c, d] of edgesOf(polyB)) {
    const segment = collinearOverlap(a, b, c, d);
    if (segment && dist(segment[0], segment[1]) >= minOverlap) return true;
  }
  return false;
}

// --- shared geometry kernels ----------------------------------------------
// Both the single-piece wrappers and the rigid-body API funnel through these,
// so "what is a rail" / "what is a shared corner" has exactly one definition.

// Rails between a set of moving edge-lists and the surrounding static polygons.
// A rail is a side of the moving body lying collinear with — and overlapping for
// a real length — an edge of a static piece. If none exist, a corner-trap
// fallback finds collinear edge pairs that have shrunk to a near-zero overlap
// (the body slid to the very end of a shared edge): those let it slide back
// along the shared direction without ever crossing onto another surface.
function railsBetween(memberEdgeLists, staticPolys) {
  const staticEdgeLists = staticPolys.map(edgesOf);
  const found = [];
  for (const me of memberEdgeLists) {
    for (const se of staticEdgeLists) {
      for (const [a, b] of me) for (const [c, d] of se) {
        const segment = collinearOverlap(a, b, c, d);
        if (segment && dist(segment[0], segment[1]) >= MIN_RAIL_OVERLAP) {
          found.push({ dir: unit(sub(b, a)), seg: segment });
        }
      }
    }
  }
  if (found.length === 0) {
    for (const me of memberEdgeLists) {
      for (const se of staticEdgeLists) {
        for (const [a, b] of me) {
          const ab = sub(b, a);
          const l = len(ab);
          if (l < 1e-6) continue;
          const dir = [ab[0] / l, ab[1] / l];
          for (const [c, d] of se) {
            const cd = sub(d, c);
            const lcd = len(cd);
            if (lcd < 1e-6) continue;
            if (Math.abs(cross(dir, [cd[0] / lcd, cd[1] / lcd])) > 0.03) continue;
            if (Math.abs(cross(dir, sub(c, a))) > 0.8) continue;
            const tc = dot(sub(c, a), dir);
            const td = dot(sub(d, a), dir);
            const overlapLow = Math.max(0, Math.min(tc, td));
            const overlapHigh = Math.min(l, Math.max(tc, td));
            const overlap = overlapHigh - overlapLow;
            if (overlap > -0.8 && overlap < MIN_RAIL_OVERLAP) found.push({ dir, seg: [a, b] });
          }
        }
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

// Shared corners between a set of moving polygons and the static polygons — the
// points the body can pivot around (a member vertex meeting a static vertex/edge,
// or vice versa).
function cornersBetween(memberPolys, staticPolys) {
  const staticEdgeLists = staticPolys.map(edgesOf);
  const points = [];
  const add = (point) => { if (!points.some((other) => dist(other, point) < 1)) points.push(point); };
  for (const poly of memberPolys) {
    const memberEdges = edgesOf(poly);
    staticPolys.forEach((staticPoly, index) => {
      const staticEdges = staticEdgeLists[index];
      for (const vertex of poly) {
        if (staticPoly.some((point) => dist(vertex, point) < 0.8) || staticEdges.some(([c, d]) => pointOnSeg(vertex, c, d))) add(vertex);
      }
      for (const vertex of staticPoly) {
        if (poly.some((point) => dist(vertex, point) < 0.8) || memberEdges.some(([a, b]) => pointOnSeg(vertex, a, b))) add(vertex);
      }
    });
  }
  return points;
}

export function createContactEngine(placements, boardBounds = DEFAULT_BOARD) {
  const withinBounds = (polygon) => polygon.every(([x, y]) => (
    x >= boardBounds.minX && x <= boardBounds.maxX
    && y >= boardBounds.minY && y <= boardBounds.maxY
  ));

  const neighbourhood = (id) => PIECES
    .filter((piece) => piece.id !== id)
    .map((piece) => worldPoints(piece, placements[piece.id]));

  const lawful = (id, place, others = neighbourhood(id)) => {
    const polygon = worldPoints(PIECE_BY_ID[id], place);
    if (!withinBounds(polygon)) return false;
    let contact = false;
    for (const other of others) {
      if (overlaps(polygon, other)) return false;
      if (!contact && touches(polygon, other)) contact = true;
    }
    return contact;
  };

  const localPivot = (id, worldPivot) => {
    const place = placements[id];
    const radians = -place[2] * Math.PI / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const dx = worldPivot[0] - place[0];
    const dy = worldPivot[1] - place[1];
    return [(dx * c - dy * s) * placementFlip(place), dx * s + dy * c];
  };

  // --- single-piece wrappers (live placements, all other pieces are static) -
  const contactRails = (id) => railsBetween(
    [edgesOf(worldPoints(PIECE_BY_ID[id], placements[id]))],
    neighbourhood(id)
  );

  const contactCorners = (id) => cornersBetween(
    [worldPoints(PIECE_BY_ID[id], placements[id])],
    neighbourhood(id)
  );

  const slideLimit = (id, sign, direction, others) => {
    const start = placements[id];
    let last = 0;
    for (let distance = 0.6; distance <= 520; distance += 0.6) {
      if (!lawful(id, placeAlong(start, direction, sign * distance), others)) break;
      last = distance;
    }
    return last;
  };

  const rotateLimit = (id, sign, worldPivot, pivot, others) => {
    const start = placements[id];
    const flip = placementFlip(start);
    let last = 0;
    for (let angle = 0.6; angle < 360; angle += 0.6) {
      if (!lawful(id, placeFromPivot(worldPivot, pivot, start[2] + sign * angle, flip), others)) break;
      last = angle;
    }
    return last;
  };

  const cornerCanRotate = (id, pivot, others) => {
    const local = localPivot(id, pivot);
    const place = placements[id];
    const flip = placementFlip(place);
    return lawful(id, placeFromPivot(pivot, local, place[2] + 3, flip), others)
      || lawful(id, placeFromPivot(pivot, local, place[2] - 3, flip), others);
  };

  const connected = () => {
    const seen = new Set([PIECES[0].id]);
    const stack = [PIECES[0].id];
    while (stack.length) {
      const current = stack.pop();
      const currentPolygon = worldPoints(PIECE_BY_ID[current], placements[current]);
      for (const other of PIECES) {
        if (seen.has(other.id)) continue;
        if (touches(currentPolygon, worldPoints(other, placements[other.id]))) {
          seen.add(other.id);
          stack.push(other.id);
        }
      }
    }
    return seen.size === PIECES.length;
  };

  // --- rigid-body API -------------------------------------------------------
  // A body is one or more members moved as a single rigid shape. A single piece
  // is just a one-member body. `starts` captures each member's placement at the
  // moment the drag began; `staticPolys` are the surrounding pieces it must stay
  // in contact with and never overlap. Every physical operation below works the
  // same whether the body has one member or seven.

  const makeBody = (ids) => {
    const members = [...ids];
    const memberSet = new Set(members);
    const starts = {};
    members.forEach((id) => { starts[id] = [...placements[id]]; });
    const staticPolys = PIECES
      .filter((piece) => !memberSet.has(piece.id))
      .map((piece) => worldPoints(piece, placements[piece.id]));
    return { members, memberSet, starts, staticPolys };
  };

  // Placement of every member after translating the whole body by `delta`.
  const bodyTranslate = (body, delta) => {
    const result = {};
    for (const id of body.members) {
      const s = body.starts[id];
      result[id] = [s[0] + delta[0], s[1] + delta[1], s[2], placementFlip(s)];
    }
    return result;
  };

  // Placement of every member after rotating the whole body about `pivot` by
  // `angle` degrees. For a single member this is identical to placeFromPivot
  // around the contact corner — the body simply has one point.
  const bodyRotate = (body, pivot, angle) => {
    const radians = angle * Math.PI / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const result = {};
    for (const id of body.members) {
      const start = body.starts[id];
      const dx = start[0] - pivot[0];
      const dy = start[1] - pivot[1];
      result[id] = [
        pivot[0] + dx * c - dy * s,
        pivot[1] + dx * s + dy * c,
        start[2] + angle,
        placementFlip(start)
      ];
    }
    return result;
  };

  // A placement set is valid when every member stays in bounds, none overlaps a
  // static piece, and the body still touches the static set. `contact` is 'touch'
  // for slides and pivots (so a slide may end on a single corner) or 'edge' for
  // the free 2D march (a side must stay flush). When nothing is static (the whole
  // figure selected) contact is trivially satisfied — free translation.
  const bodyValid = (body, placementMap, contact = 'touch') => {
    let inContact = body.staticPolys.length === 0;
    for (const id of body.members) {
      const polygon = worldPoints(PIECE_BY_ID[id], placementMap[id]);
      if (!withinBounds(polygon)) return false;
      for (const staticPoly of body.staticPolys) {
        if (overlaps(polygon, staticPoly)) return false;
        if (!inContact && (contact === 'edge' ? edgeContact(polygon, staticPoly) : touches(polygon, staticPoly))) inContact = true;
      }
    }
    return inContact;
  };

  const bodyRails = (body) => railsBetween(
    body.members.map((id) => edgesOf(worldPoints(PIECE_BY_ID[id], body.starts[id]))),
    body.staticPolys
  );

  const bodyCorners = (body) => cornersBetween(
    body.members.map((id) => worldPoints(PIECE_BY_ID[id], body.starts[id])),
    body.staticPolys
  );

  // How far the body can slide along `dir` before the first collision / loss of
  // contact. Stops the body dead at an obstruction, but lets it ride all the way
  // to a far corner — the fixed direction prevents corner-walking.
  const bodySlideLimit = (body, dir, sign) => {
    let last = 0;
    for (let distance = 0.6; distance <= 520; distance += 0.6) {
      if (!bodyValid(body, bodyTranslate(body, [sign * distance * dir[0], sign * distance * dir[1]]), 'touch')) break;
      last = distance;
    }
    return last;
  };

  // How far the body can pivot about `pivot` before the first collision, up to
  // nearly a full turn (the ceiling is just shy of 360° so a corner with clear
  // space all around can keep turning past 180° yet still land back at start is
  // excluded).
  const bodyRotateLimit = (body, pivot, sign) => {
    let last = 0;
    for (let angle = 0.6; angle < 360; angle += 0.6) {
      if (!bodyValid(body, bodyRotate(body, pivot, sign * angle), 'touch')) break;
      last = angle;
    }
    return last;
  };

  const bodyCornerCanRotate = (body, pivot) => bodyValid(body, bodyRotate(body, pivot, 3), 'touch')
    || bodyValid(body, bodyRotate(body, pivot, -3), 'touch');

  // The free 2D contact-following march, used only when the whole figure is
  // selected (nothing static to ride). Steps toward the desired delta, trying a
  // fan of directions so it can hug a surface, but every step keeps edge contact.
  const bodyMarch = (body, desired, from = [0, 0]) => {
    let current = from;
    for (let i = 0; i < 280; i += 1) {
      const toGoal = sub(desired, current);
      const distance = len(toGoal);
      if (distance < 0.4) break;
      const step = Math.min(2, distance);
      const u = [toGoal[0] / distance, toGoal[1] / distance];
      let advanced = false;
      for (const deg of [0, 12, -12, 25, -25, 40, -40, 58, -58, 75, -75]) {
        const dir = deg === 0 ? u : rotateVec(u, deg * Math.PI / 180);
        const candidate = [current[0] + dir[0] * step, current[1] + dir[1] * step];
        if (bodyValid(body, bodyTranslate(body, candidate), 'edge')) { current = candidate; advanced = true; break; }
      }
      if (!advanced) break;
    }
    return current;
  };

  // Read a still-pending drag. The read is geometric: how well the accumulated
  // motion lies *along* the best rail (slide) versus *across* the radius from a
  // rotatable corner (arc). Returns null while still ambiguous, or a committed
  // intent. `railNear` lets a group prefer rails over a wider reach than a piece.
  const bodyInterpret = (body, { grab, rails, corners, point, railNear = GESTURE.RAIL_NEAR_PIECE }) => {
    const motion = sub(point, grab);
    const m = len(motion);
    if (m < GESTURE.DEAD_ZONE) return null;
    const u = [motion[0] / m, motion[1] / m];

    // Best rail: the one the motion runs most along, preferring nearby edges.
    let rail = null; let railScore = -1;
    for (const r of rails) {
      const score = Math.abs(dot(u, r.dir)) * (segDist(grab, r.seg[0], r.seg[1]) < railNear ? 1 : 0.001);
      if (score > railScore) { railScore = score; rail = r; }
    }
    const along = rail ? dot(motion, rail.dir) : 0;
    const railLimit = rail ? bodySlideLimit(body, rail.dir, along >= 0 ? 1 : -1) : 0;
    const railFeasible = !!rail && railLimit > 8;
    const slideAlign = rail ? Math.abs(dot(u, rail.dir)) : 0;

    // Best pivot: the rotatable contact corner whose arc-tangent the motion best
    // follows. A grab right on a tip (tiny radius) reads as a pivot outright.
    let pivot = null; let rotAlign = 0; let pivotRadius = 0; let nearestCorner = Infinity;
    for (const c of corners) {
      nearestCorner = Math.min(nearestCorner, dist(grab, c));
      if (!bodyCornerCanRotate(body, c)) continue;
      const rad = sub(grab, c);
      const rl = len(rad);
      const tanAlign = rl < 12 ? 1 : Math.abs(dot(u, [-rad[1] / rl, rad[0] / rl]));
      if (tanAlign > rotAlign) { rotAlign = tanAlign; pivot = c; pivotRadius = rl; }
    }
    const rotFeasible = !!pivot;
    const sweptDeg = !pivot ? 0
      : pivotRadius < 1 ? 90
      : Math.abs(dot(motion, [-(grab[1] - pivot[1]) / pivotRadius, (grab[0] - pivot[0]) / pivotRadius])) / pivotRadius * 180 / Math.PI;

    const makeSlide = () => ({ mode: 'slide', rail, dir: rail.dir, negLimit: bodySlideLimit(body, rail.dir, -1), posLimit: bodySlideLimit(body, rail.dir, 1) });
    const makeRotate = () => ({ mode: 'rotate', pivot, negLimit: bodyRotateLimit(body, pivot, -1), posLimit: bodyRotateLimit(body, pivot, 1) });

    if (railFeasible && !rotFeasible) return makeSlide();
    if (rotFeasible && !railFeasible) return (sweptDeg >= GESTURE.MIN_ROT_DEG || nearestCorner < GESTURE.CORNER_BIAS) ? makeRotate() : null;
    if (!railFeasible && !rotFeasible) return null;

    // Both possible: commit to whichever the motion clearly favours, once it has
    // travelled far enough to be deliberate. A corner-tip grab tips ties to pivot.
    let sep = slideAlign - rotAlign;
    if (nearestCorner < GESTURE.CORNER_BIAS) sep -= 0.25;
    if (sep > GESTURE.COMMIT_SEP && Math.abs(along) >= GESTURE.MIN_SLIDE_PX) return makeSlide();
    if (sep < -GESTURE.COMMIT_SEP && sweptDeg >= GESTURE.MIN_ROT_DEG) return makeRotate();
    if (m >= GESTURE.HARD_COMMIT) return (sep >= 0 && railFeasible) ? makeSlide() : makeRotate();
    return null;
  };

  // Click a sliding body onto a vertex alignment along its rail, so it lands on
  // a surface's end corner rather than a hair short. Returns the chosen along-rail
  // distance (`s0` is the current one). Works for one member or many.
  const bodySnapSlide = (body, dir, s0, negLimit, posLimit) => {
    let bestS = s0;
    let bestDelta = SNAP_VERTEX;
    for (const id of body.members) {
      const verts = worldPoints(PIECE_BY_ID[id], body.starts[id]);
      for (const v of verts) {
        const current = [v[0] + s0 * dir[0], v[1] + s0 * dir[1]];
        for (const staticPoly of body.staticPolys) for (const w of staticPoly) {
          const diff = sub(w, current);
          if (Math.abs(cross(dir, diff)) > SNAP_VERTEX) continue;
          const offset = dot(diff, dir);
          if (Math.abs(offset) >= bestDelta) continue;
          const candidate = s0 + offset;
          if (candidate < -negLimit - 0.01 || candidate > posLimit + 0.01) continue;
          if (bodyValid(body, bodyTranslate(body, [candidate * dir[0], candidate * dir[1]]), 'touch')) { bestDelta = Math.abs(offset); bestS = candidate; }
        }
      }
    }
    return bestS;
  };

  // Choose the angle a finished pivot lands on: the nearest 45° stop, else the
  // previous reachable stop, else no turn. Returned as a delta from the start
  // orientation, valid within the swept limits. `raw` is the live delta angle.
  const bodySnapRotation = (body, pivot, raw, negLimit, posLimit) => {
    const previous = raw > 0.01 ? Math.floor(raw / ROT_SNAP) * ROT_SNAP
      : raw < -0.01 ? Math.ceil(raw / ROT_SNAP) * ROT_SNAP
      : 0;
    const candidates = [Math.round(raw / ROT_SNAP) * ROT_SNAP, previous, 0];
    for (const angle of candidates) {
      if (angle < -negLimit - 0.01 || angle > posLimit + 0.01) continue;
      if (bodyValid(body, bodyRotate(body, pivot, angle), 'touch')) return angle;
    }
    return 0;
  };

  // Seat a freely-marched body (whole-figure move) by snapping any member vertex
  // onto a static vertex. Returns the chosen delta vector.
  const bodySnapFree = (body, delta0) => {
    let best = delta0;
    let bestDelta = SNAP_VERTEX;
    for (const id of body.members) {
      const s = body.starts[id];
      const poly = worldPoints(PIECE_BY_ID[id], [s[0] + delta0[0], s[1] + delta0[1], s[2], placementFlip(s)]);
      for (const v of poly) for (const staticPoly of body.staticPolys) for (const w of staticPoly) {
        const off = sub(w, v);
        const d = len(off);
        if (d >= bestDelta) continue;
        const candidate = [delta0[0] + off[0], delta0[1] + off[1]];
        if (bodyValid(body, bodyTranslate(body, candidate), 'edge')) { bestDelta = d; best = candidate; }
      }
    }
    return best;
  };

  return {
    withinBounds,
    neighbourhood,
    lawful,
    lawfulNow: (id, place) => lawful(id, place),
    contactRails,
    contactCorners,
    localPivot,
    slideLimit,
    rotateLimit,
    cornerCanRotate,
    connected,
    // rigid-body API (single piece = one-member body)
    makeBody,
    bodyTranslate,
    bodyRotate,
    bodyValid,
    bodyRails,
    bodyCorners,
    bodySlideLimit,
    bodyRotateLimit,
    bodyCornerCanRotate,
    bodyMarch,
    bodyInterpret,
    bodySnapSlide,
    bodySnapRotation,
    bodySnapFree
  };
}
