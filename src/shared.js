// Shared tangram definitions + geometry, used by both the game and the builder.
export const SQRT2 = Math.sqrt(2);

// The seven classic pieces (shape + identity only; placement is per-context).
export const PIECES = [
  { id: 'mountain', name: 'Large triangle A', shape: [[0, 0], [120, 0], [0, 120]], color: '#27332f' },
  { id: 'shadow', name: 'Large triangle B', shape: [[0, 0], [120, 0], [0, 120]], color: '#56665e' },
  { id: 'reed', name: 'Medium triangle', shape: [[0, 0], [60 * SQRT2, 0], [0, 60 * SQRT2]], color: '#9b8d6c' },
  { id: 'stone', name: 'Square', shape: [[0, 0], [60, 0], [60, 60], [0, 60]], color: '#a14d38' },
  { id: 'bridge', name: 'Parallelogram', shape: [[0, 0], [60, 0], [120, 60], [60, 60]], color: '#c0aa82' },
  { id: 'wing', name: 'Small triangle A', shape: [[0, 0], [60, 0], [0, 60]], color: '#d6c7aa' },
  { id: 'beak', name: 'Small triangle B', shape: [[0, 0], [60, 0], [0, 60]], color: '#7d2d24' }
];

export const PIECE_BY_ID = Object.fromEntries(PIECES.map((p) => [p.id, p]));
export const PIECE_IDS = PIECES.map((p) => p.id);

export const COLLIDE_EPS = 0.4;
export const CONTACT_EPS = 0.8;
export const ROT_SNAP = 45;
export const SNAP_VERTEX = 7;

// --- vectors ---------------------------------------------------------------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const rotateVec = (v, a) => { const c = Math.cos(a); const s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };

export const pointsString = (points) => points.map(([x, y]) => `${x},${y}`).join(' ');
export const placementFlip = (value) => value?.[3] === -1 ? -1 : 1;
export const transformString = (value) => {
  const [x, y, rotation] = value;
  const flip = placementFlip(value);
  return `translate(${x} ${y}) rotate(${rotation})${flip === -1 ? ' scale(-1 1)' : ''}`;
};

export function worldPoints(piece, value) {
  const radians = value[2] * Math.PI / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const flip = placementFlip(value);
  return piece.shape.map(([x, y]) => {
    const fx = x * flip;
    return [value[0] + fx * c - y * s, value[1] + fx * s + y * c];
  });
}

export function centroid(points) {
  let x = 0;
  let y = 0;
  for (const [px, py] of points) { x += px; y += py; }
  return [x / points.length, y / points.length];
}

export const edgesOf = (poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);

export function polygonAxes(polygon) {
  return polygon.map((point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });
}

// SAT overlap. With negative eps it reports "within |eps|" (contact).
export function overlaps(first, second, eps = COLLIDE_EPS) {
  for (const axis of [...polygonAxes(first), ...polygonAxes(second)]) {
    const a = first.map(([x, y]) => x * axis[0] + y * axis[1]);
    const b = second.map(([x, y]) => x * axis[0] + y * axis[1]);
    if (Math.max(...a) <= Math.min(...b) + eps || Math.max(...b) <= Math.min(...a) + eps) return false;
  }
  return true;
}

export const touches = (a, b) => overlaps(a, b, -CONTACT_EPS);

export function pointOnSeg(p, a, b) {
  const ab = sub(b, a);
  const l = len(ab);
  if (l < 1e-6) return dist(p, a) < CONTACT_EPS;
  const u = [ab[0] / l, ab[1] / l];
  const t = dot(sub(p, a), u);
  if (t < -CONTACT_EPS || t > l + CONTACT_EPS) return false;
  return Math.abs(cross(u, sub(p, a))) < CONTACT_EPS;
}

export function segDist(p, a, b) {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 < 1e-9) return dist(p, a);
  const t = clamp(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2, 0, 1);
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}

export function normalizedAngleDelta(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

// Bounding box of a figure's target placements (map id -> [x,y,rot]).
export function figureBounds(targets) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of PIECES) {
    if (!targets[p.id]) continue;
    for (const [x, y] of worldPoints(p, targets[p.id])) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// Two figures match if every piece covers the same silhouette area (vertex sets
// agree within tolerance — symmetry-aware for the square).
export function sameShape(a, b, tol = 3.5) {
  return a.length === b.length
    && a.every((p) => b.some((q) => dist(p, q) < tol))
    && b.every((q) => a.some((p) => dist(p, q) < tol));
}
