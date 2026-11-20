/**
 * Image pixels to world centimeters.
 *
 * A camera straight overhead needs only a scale: two points a known distance
 * apart. A camera at an angle, or an arena that is not square to the image,
 * needs a homography from four or more reference points (the arena's corners,
 * say). Either way every measure in cm goes through `toWorld`, so the choice
 * is made once, at calibration.
 */

import type { Point } from '../types';

export type Calibration =
  | {
      readonly kind: 'scale';
      readonly pxPerCm: number;
      /** The image point that maps to world (0, 0). */
      readonly originPx: Point;
    }
  | {
      readonly kind: 'homography';
      /** Row-major 3×3, image px → world cm, normalized so `h[8] === 1`. */
      readonly h: ReadonlyArray<number>;
    };

export interface Correspondence {
  readonly image: Point;
  readonly world: Point;
}

/** A scale from two image points a known distance apart; world origin at `a`. */
export function scaleFromTwoPoints(a: Point, b: Point, distanceCm: number): Calibration {
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(px > 0) || !(distanceCm > 0)) throw new RangeError('calibration points must be distinct and the distance positive');
  return { kind: 'scale', pxPerCm: px / distanceCm, originPx: a };
}

/**
 * Least-squares homography (direct linear transform) from four or more
 * correspondences. Image points are normalized first (Hartley), which keeps
 * the solve well conditioned at video resolutions.
 */
export function homographyFromPoints(pairs: ReadonlyArray<Correspondence>): Calibration {
  if (pairs.length < 4) throw new RangeError('a homography needs at least four points');
  const ni = normalizer(pairs.map((p) => p.image));
  const nw = normalizer(pairs.map((p) => p.world));
  // Unknowns h0..h7 with h8 = 1, two equations per pair.
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const { image, world } of pairs) {
    const { x, y } = apply(ni.t, image);
    const { x: u, y: v } = apply(nw.t, world);
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }
  const sol = leastSquares(rows, rhs);
  const hn = [...sol, 1];
  // Undo normalization: H = Tw⁻¹ · Hn · Ti.
  const h = multiply(multiply(nw.inverse, hn), ni.t);
  const s = h[8]!;
  if (Math.abs(s) < 1e-12) throw new RangeError('degenerate calibration points');
  return { kind: 'homography', h: h.map((v) => v / s) };
}

export function toWorld(cal: Calibration, p: Point): Point {
  if (cal.kind === 'scale') return { x: (p.x - cal.originPx.x) / cal.pxPerCm, y: (p.y - cal.originPx.y) / cal.pxPerCm };
  return apply(cal.h, p);
}

export function toImage(cal: Calibration, p: Point): Point {
  if (cal.kind === 'scale') return { x: p.x * cal.pxPerCm + cal.originPx.x, y: p.y * cal.pxPerCm + cal.originPx.y };
  return apply(invert3(cal.h), p);
}

/**
 * Local pixels per centimeter at an image point. Constant for a scale; varies
 * across the image under perspective. Detector sizes use this at the arena center.
 */
export function pxPerCmAt(cal: Calibration, p: Point): number {
  if (cal.kind === 'scale') return cal.pxPerCm;
  const step = 1;
  const o = toWorld(cal, p);
  const dx = toWorld(cal, { x: p.x + step, y: p.y });
  const dy = toWorld(cal, { x: p.x, y: p.y + step });
  // Square root of the Jacobian determinant: the geometric-mean scale.
  const det = Math.abs((dx.x - o.x) * (dy.y - o.y) - (dx.y - o.y) * (dy.x - o.x));
  return step / Math.sqrt(det);
}

/** Largest distance, in cm, between where calibration puts each reference point and where it really is. */
export function calibrationResidualCm(cal: Calibration, pairs: ReadonlyArray<Correspondence>): number {
  return Math.max(0, ...pairs.map(({ image, world }) => {
    const w = toWorld(cal, image);
    return Math.hypot(w.x - world.x, w.y - world.y);
  }));
}

// --- small linear algebra -------------------------------------------------

function apply(h: ReadonlyArray<number>, p: Point): Point {
  const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
  return { x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w, y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w };
}

function multiply(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c]! += a[r * 3 + k]! * b[k * 3 + c]!;
  return out;
}

function invert3(m: ReadonlyArray<number>): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new RangeError('calibration is not invertible');
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

/** Translate to the centroid and scale to mean distance √2. Returns T and T⁻¹. */
function normalizer(pts: ReadonlyArray<Point>): { t: number[]; inverse: number[] } {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const mean = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  const s = mean > 0 ? Math.SQRT2 / mean : 1;
  return { t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], inverse: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1] };
}

/** Solve min ‖Ax − b‖ through the normal equations with partial pivoting. */
function leastSquares(a: ReadonlyArray<ReadonlyArray<number>>, b: ReadonlyArray<number>): number[] {
  const n = a[0]!.length;
  const m: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    for (let k = 0; k < a.length; k++) {
      for (let j = 0; j < n; j++) row[j]! += a[k]![i]! * a[k]![j]!;
      row[n]! += a[k]![i]! * b[k]!;
    }
    return row;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) throw new RangeError('calibration points are collinear or repeated');
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}
