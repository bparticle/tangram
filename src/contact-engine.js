import {
  PIECES, PIECE_BY_ID, sub, dot, cross, len, unit, dist,
  worldPoints, edgesOf, overlaps, touches, pointOnSeg, placementFlip
} from './shared.js';

export const DEFAULT_BOARD = { minX: -4, maxX: 764, minY: -88, maxY: 484 };

// A slide is only legal where a *side* of the moving piece lies along an edge of
// another piece. The collinear overlap that proves it must be at least this long
// — a bare corner grazing an edge (zero-length overlap) is not enough to ride.
export const MIN_RAIL_OVERLAP = 6;

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

  const contactRails = (id) => {
    const polygon = worldPoints(PIECE_BY_ID[id], placements[id]);
    const pieceEdges = edgesOf(polygon);
    const found = [];
    for (const other of PIECES) {
      if (other.id === id) continue;
      const otherPolygon = worldPoints(other, placements[other.id]);
      const otherEdges = edgesOf(otherPolygon);
      // Only edge-on-edge contact yields a rail: one of this piece's sides must
      // lie collinear with — and overlap, for a real length — one of the other's
      // edges. Vertex-on-edge contact (a corner riding an edge on a single point)
      // is deliberately *not* a rail, so a piece can never slide on a corner.
      for (const [a, b] of pieceEdges) for (const [c, d] of otherEdges) {
        const segment = collinearOverlap(a, b, c, d);
        if (segment && dist(segment[0], segment[1]) >= MIN_RAIL_OVERLAP) {
          found.push({ dir: unit(sub(b, a)), seg: segment });
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
  };

  const contactCorners = (id) => {
    const polygon = worldPoints(PIECE_BY_ID[id], placements[id]);
    const pieceEdges = edgesOf(polygon);
    const points = [];
    const add = (point) => { if (!points.some((other) => dist(other, point) < 1)) points.push(point); };
    for (const other of PIECES) {
      if (other.id === id) continue;
      const otherPolygon = worldPoints(other, placements[other.id]);
      const otherEdges = edgesOf(otherPolygon);
      for (const vertex of polygon) {
        if (otherPolygon.some((point) => dist(vertex, point) < 0.8) || otherEdges.some(([c, d]) => pointOnSeg(vertex, c, d))) add(vertex);
      }
      for (const vertex of otherPolygon) {
        if (polygon.some((point) => dist(vertex, point) < 0.8) || pieceEdges.some(([a, b]) => pointOnSeg(vertex, a, b))) add(vertex);
      }
    }
    return points;
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
    for (let angle = 0.6; angle <= 180; angle += 0.6) {
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
    connected
  };
}
