/**
 * Finding the platform: a bright disk on a dark surround.
 */

import { otsuThreshold, connectedComponents, largestComponent, type Gray } from '../../../image/imageOps';
import type { Point } from '../types';
import { median } from '../../../stats';

export interface PlatformFit {
  readonly center: Point;
  readonly radiusPx: number;
  /** Median absolute deviation of the traced edge from the fitted circle, px. */
  readonly residualPx: number;
  /** Fraction of rays that produced a usable edge sample. */
  readonly edgeCoverage: number;
  readonly threshold: number;
  readonly warnings: ReadonlyArray<string>;
}

const RAY_COUNT = 720;
const RAY_STEP_PX = 0.5;
/** An edge sample counts only if the mask was solid for this many steps behind it. */
const SOLID_RUN = 4;

/**
 * Trace the outermost solid transition along radial rays. This excludes the
 * internal hole boundaries from the platform fit.
 */
export function fitPlatform(img: Gray): PlatformFit {
  const warnings: string[] = [];
  const threshold = otsuThreshold(img);
  const { width, height, data } = img;

  const noPlatform = (why: string): PlatformFit => ({
    center: { x: width / 2, y: height / 2 },
    radiusPx: Math.min(width, height) / 4,
    residualPx: Number.NaN,
    edgeCoverage: 0,
    threshold,
    warnings: [why],
  });

  // Reject flat images before thresholding; otherwise the frame border can be
  // mistaken for a platform circle.
  if (spread(data) < 25) {
    return noPlatform(
      'No platform could be found because image contrast is too low. Check the recording and lighting.',
    );
  }

  const bright = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) bright[i] = data[i]! > threshold ? 1 : 0;

  const cc = connectedComponents(bright, width, height, { minAreaPx: 200 });
  const blob = largestComponent(cc);
  if (!blob) return noPlatform('No platform-sized bright region detected. Check the recording.');

  // A visible platform boundary must lie inside the frame.
  if (blob.areaPx > 0.9 * width * height) {
    return noPlatform(
      'The bright region fills the whole frame, so no platform boundary could be found. ' +
        'The camera may be zoomed in past the edge of the platform.',
    );
  }

  // Fill the interior so ray casting is not stopped by a hole. A pixel is
  // "inside" if it carries the platform's label, or lies between two pixels
  // that do on the same scanline.
  const inside = new Uint8Array(width * height);
  for (let y = blob.minY; y <= blob.maxY; y++) {
    let first = -1;
    let last = -1;
    for (let x = blob.minX; x <= blob.maxX; x++) {
      if (cc.labels[y * width + x] === blob.label) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) for (let x = first; x <= last; x++) inside[y * width + x] = 1;
  }

  let cx = blob.sumX / blob.areaPx;
  let cy = blob.sumY / blob.areaPx;

  // Two passes: the first center estimate is the filled blob's centroid, which
  // is biased if the disk is clipped or shadowed; refit from the traced edge.
  let radiusPx = Math.sqrt(blob.areaPx / Math.PI);
  let residualPx = Number.NaN;
  let edgeCoverage = 0;
  let clippedRays = 0;

  for (let pass = 0; pass < 2; pass++) {
    const maxR = Math.hypot(width, height) / 2;
    const xs: number[] = [];
    const ys: number[] = [];
    clippedRays = 0;

    for (let a = 0; a < RAY_COUNT; a++) {
      const th = (a * 2 * Math.PI) / RAY_COUNT;
      const dx = Math.cos(th);
      const dy = Math.sin(th);
      let run = 0;
      let lastSolidR = -1;
      let leftFrame = false;
      for (let r = 1; r <= maxR; r += RAY_STEP_PX) {
        const px = Math.round(cx + dx * r);
        const py = Math.round(cy + dy * r);
        if (px < 0 || py < 0 || px >= width || py >= height) {
          leftFrame = run > 0;
          break;
        }
        if (inside[py * width + px]) {
          run++;
          if (run >= SOLID_RUN) lastSolidR = r;
        } else {
          run = 0;
        }
      }
      if (leftFrame) {
        clippedRays++;
        continue; // platform runs off the frame on this ray; it tells us nothing
      }
      if (lastSolidR > 0) {
        xs.push(cx + dx * lastSolidR);
        ys.push(cy + dy * lastSolidR);
      }
    }

    edgeCoverage = xs.length / RAY_COUNT;
    if (xs.length < 50) {
      warnings.push('Platform edge could not be traced; falling back to the blob centroid.');
      break;
    }

    const fit = robustCircleFit(xs, ys);
    cx = fit.cx;
    cy = fit.cy;
    radiusPx = fit.r;
    residualPx = fit.residual;
  }

  if (clippedRays > RAY_COUNT * 0.02) {
    warnings.push(
      `Platform runs off the edge of the frame in ${Math.round((100 * clippedRays) / RAY_COUNT)}% of directions. Check the extrapolated outline.`,
    );
  }
  if (residualPx > 3) {
    warnings.push(
      `Platform circle residual is high (${residualPx.toFixed(1)} px). Check the outline.`,
    );
  }

  return { center: { x: cx, y: cy }, radiusPx, residualPx, edgeCoverage, threshold, warnings };
}

/**
 * Kasa algebraic circle fit, reweighted three times to shrug off outliers
 * (shadows, the cable at the frame edge, a hand reaching in).
 */
export function robustCircleFit(
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
): { cx: number; cy: number; r: number; residual: number } {
  const n = xs.length;
  let weights = new Float64Array(n).fill(1);
  let cx = 0;
  let cy = 0;
  let r = 0;
  let residual = Number.NaN;

  for (let iter = 0; iter < 4; iter++) {
    // Solve the 3x3 normal equations for x^2+y^2 = a*x + b*y + c.
    let sww = 0;
    const A = new Float64Array(9);
    const B = new Float64Array(3);
    for (let i = 0; i < n; i++) {
      const w = weights[i]!;
      if (w === 0) continue;
      const x = xs[i]!;
      const y = ys[i]!;
      const z = x * x + y * y;
      sww += w;
      A[0] = A[0]! + w * x * x;
      A[1] = A[1]! + w * x * y;
      A[2] = A[2]! + w * x;
      A[4] = A[4]! + w * y * y;
      A[5] = A[5]! + w * y;
      A[8] = A[8]! + w;
      B[0] = B[0]! + w * z * x;
      B[1] = B[1]! + w * z * y;
      B[2] = B[2]! + w * z;
    }
    A[3] = A[1]!;
    A[6] = A[2]!;
    A[7] = A[5]!;
    if (sww < 3) break;
    const sol = solve3x3(A, B);
    if (!sol) break;
    cx = sol[0]! / 2;
    cy = sol[1]! / 2;
    const rr = sol[2]! + cx * cx + cy * cy;
    r = rr > 0 ? Math.sqrt(rr) : 0;

    const dev = new Float64Array(n);
    for (let i = 0; i < n; i++) dev[i] = Math.abs(Math.hypot(xs[i]! - cx, ys[i]! - cy) - r);
    residual = median(dev);
    // Floor the Tukey-style cutoff to retain subpixel deviations.
    const cut = Math.max(1.5, 3 * residual);
    weights = new Float64Array(n);
    for (let i = 0; i < n; i++) weights[i] = dev[i]! <= cut ? 1 : 0;
  }

  return { cx, cy, r, residual };
}

function solve3x3(A: Float64Array, B: Float64Array): Float64Array | null {
  const m = Float64Array.from(A);
  const b = Float64Array.from(B);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row * 3 + col]!) > Math.abs(m[pivot * 3 + col]!)) pivot = row;
    }
    if (Math.abs(m[pivot * 3 + col]!) < 1e-12) return null;
    if (pivot !== col) {
      for (let k = 0; k < 3; k++) {
        const t = m[col * 3 + k]!;
        m[col * 3 + k] = m[pivot * 3 + k]!;
        m[pivot * 3 + k] = t;
      }
      const t = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = t;
    }
    for (let row = col + 1; row < 3; row++) {
      const f = m[row * 3 + col]! / m[col * 3 + col]!;
      for (let k = col; k < 3; k++) m[row * 3 + k] = m[row * 3 + k]! - f * m[col * 3 + k]!;
      b[row] = b[row]! - f * b[col]!;
    }
  }
  const out = new Float64Array(3);
  for (let row = 2; row >= 0; row--) {
    let s = b[row]!;
    for (let k = row + 1; k < 3; k++) s -= m[row * 3 + k]! * out[k]!;
    out[row] = s / m[row * 3 + row]!;
  }
  return out;
}

/** Robust dynamic range: the gap between the 5th and 95th percentile. */
function spread(data: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]!] = hist[data[i]!]! + 1;
  const total = data.length;
  const at = (q: number): number => {
    let seen = 0;
    const want = q * total;
    for (let v = 0; v < 256; v++) {
      seen += hist[v]!;
      if (seen >= want) return v;
    }
    return 255;
  };
  return at(0.95) - at(0.05);
}

