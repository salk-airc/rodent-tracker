/** Refine each predicted hole center against its local image neighborhood. */

import { sampleBilinear, type Gray } from '../../../image/imageOps';
import type { Hole, Point, Provenance } from '../types';

export interface RefinedHoles {
  readonly holes: ReadonlyArray<Hole>;
  /** Median distance the refinement moved a hole, px. Large values mean a poor ring fit. */
  readonly medianShiftPx: number;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Snap each predicted hole onto the local dark spot, then fit its rim.
 *
 * The dark-spot centroid finds the hole but doesn't center it: light falls
 * into each hole from one side, and an oblique camera sees holes near the
 * edge as crescents, so the darkest part sits off the opening's center. The
 * opening's rim, the step from dark hole to bright platform, is where the hole
 * is; `fitHoleRim` fits a circle to it and is used whenever the rim is traced
 * around enough of the hole.
 *
 * `platformLevel` is the typical bright-surface value; darkness is measured
 * relative to it so uneven lighting across the platform does not bias the
 * centroid toward the dim side.
 */
export function refineHoles(
  img: Gray,
  center: Point,
  predicted: ReadonlyArray<Point>,
  platformLevel: number,
  provenance: Provenance,
): RefinedHoles {
  const n = predicted.length;
  const spacingPx = n > 1 ? (2 * Math.PI * distance(center, predicted[0]!)) / n : 40;
  const guessRadius = Math.max(3, 0.175 * spacingPx);
  const searchRadius = Math.max(guessRadius * 1.6, 6);

  const holes: Hole[] = [];
  const shifts: number[] = [];
  let lowContrast = 0;

  for (let i = 0; i < n; i++) {
    const start = predicted[i]!;
    let cx = start.x;
    let cy = start.y;

    for (let iter = 0; iter < 3; iter++) {
      let wsum = 0;
      let wx = 0;
      let wy = 0;
      const r = searchRadius;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (dx * dx + dy * dy > r * r) continue;
          const v = sampleBilinear(img, cx + dx, cy + dy);
          const w = Math.max(0, platformLevel - v);
          wsum += w;
          wx += w * (cx + dx);
          wy += w * (cy + dy);
        }
      }
      if (wsum <= 0) break;
      cx = wx / wsum;
      cy = wy / wsum;
    }

    let radiusPx = measureHoleRadius(img, { x: cx, y: cy }, platformLevel, searchRadius * 1.4);
    const rim = fitHoleRim(img, { x: cx, y: cy }, guessRadius);
    if (rim) {
      cx = rim.center.x;
      cy = rim.center.y;
      radiusPx = rim.radiusPx;
    }
    const shift = Math.hypot(cx - start.x, cy - start.y);
    shifts.push(shift);

    const centerValue = sampleBilinear(img, cx, cy);
    if (platformLevel - centerValue < 12) lowContrast++;

    holes.push({ index: i, center: { x: cx, y: cy }, radiusPx, provenance });
  }

  const warnings: string[] = [];
  const sorted = [...shifts].sort((a, b) => a - b);
  const medianShiftPx = sorted.length ? sorted[sorted.length >> 1]! : 0;
  if (medianShiftPx > guessRadius) {
    warnings.push(
      `Hole alignment shifted by a median ${medianShiftPx.toFixed(1)} px. Check the ring overlay.`,
    );
  }
  if (lowContrast > 0) {
    warnings.push(
      `${lowContrast} of ${n} holes have low contrast. Check their positions.`,
    );
  }

  return { holes, medianShiftPx, warnings };
}

/** Rim samples around a candidate circle; the brightness step across the rim at each. */
const RIM_SAMPLES = 64;
/** A step this large (gray levels, outside minus inside) counts as rim. */
const RIM_STEP = 10;
/** The rim must be traced around at least this share of the circle to be trusted. */
const MIN_RIM_COVERAGE = 0.45;

/**
 * The circle whose rim has the strongest dark-to-bright step, searched around
 * `start`. Only the strongest 70% of the rim is scored, so the lit far wall
 * inside a crescent-looking hole doesn't pull the fit. Null when no rim is
 * traced around enough of the hole.
 */
export function fitHoleRim(img: Gray, start: Point, guessRadius: number): { center: Point; radiusPx: number; coverage: number } | null {
  const edge = Math.max(0.75, guessRadius * 0.08);
  // Unit directions around the rim, once: the coarse pass needs half as many.
  const ring = (n: number) => Array.from({ length: n }, (_, i) => [Math.cos((i * 2 * Math.PI) / n), Math.sin((i * 2 * Math.PI) / n)] as const);
  const fine = ring(RIM_SAMPLES);
  const coarse = ring(RIM_SAMPLES / 2);
  let dirs = coarse;
  const steps = new Float64Array(RIM_SAMPLES);
  const score = (cx: number, cy: number, r: number) => {
    const n = dirs.length;
    for (let i = 0; i < n; i++) {
      const [ux, uy] = dirs[i]!;
      steps[i] = sampleBilinear(img, cx + ux * (r + edge), cy + uy * (r + edge)) - sampleBilinear(img, cx + ux * (r - edge), cy + uy * (r - edge));
    }
    const sorted = steps.subarray(0, n).sort().reverse();
    const keep = Math.ceil(n * 0.7);
    let total = 0;
    let rim = 0;
    for (let i = 0; i < n; i++) {
      if (i < keep) total += sorted[i]!;
      if (sorted[i]! >= RIM_STEP) rim++;
    }
    const coverage = rim / n;
    return { value: (total / keep) * Math.min(1, coverage / 0.65), coverage };
  };
  const search = (c: Point, reach: number, step: number, rMin: number, rMax: number, rStep: number) => {
    let best = { x: c.x, y: c.y, r: (rMin + rMax) / 2, value: Number.NEGATIVE_INFINITY, coverage: 0 };
    for (let dy = -reach; dy <= reach + 1e-9; dy += step) {
      for (let dx = -reach; dx <= reach + 1e-9; dx += step) {
        for (let r = rMin; r <= rMax + 1e-9; r += rStep) {
          const s = score(c.x + dx, c.y + dy, r);
          if (s.value > best.value) best = { x: c.x + dx, y: c.y + dy, r, ...s };
        }
      }
    }
    return best;
  };
  // Coarse over the neighborhood, then fine around the best.
  // Coarse over the neighborhood with half the rim samples, then fine around the best.
  const found = search(start, Math.max(2, guessRadius * 0.6), 1, guessRadius * 0.6, guessRadius * 1.5, 1);
  dirs = fine;
  const best = search({ x: found.x, y: found.y }, 1, 0.25, Math.max(2, found.r - 1), found.r + 1, 0.125);
  if (best.coverage < MIN_RIM_COVERAGE) return null;
  return { center: { x: best.x, y: best.y }, radiusPx: best.r, coverage: best.coverage };
}

/**
 * Hole radius as the distance at which brightness recovers halfway from the
 * hole's darkest level back to the platform level.
 */
function measureHoleRadius(img: Gray, c: Point, platformLevel: number, maxR: number): number {
  const dark = sampleBilinear(img, c.x, c.y);
  const half = (dark + platformLevel) / 2;
  const rays = 16;
  const found: number[] = [];
  for (let a = 0; a < rays; a++) {
    const th = (a * 2 * Math.PI) / rays;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    for (let r = 1; r <= maxR; r += 0.25) {
      if (sampleBilinear(img, c.x + dx * r, c.y + dy * r) >= half) {
        found.push(r);
        break;
      }
    }
  }
  if (found.length === 0) return maxR / 2;
  found.sort((p, q) => p - q);
  return found[found.length >> 1]!;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The typical bright-platform gray level: a high percentile of the pixels
 * inside the platform, which skips the holes without needing to know where
 * they are yet.
 */
export function platformBrightness(img: Gray, center: Point, radiusPx: number): number {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(radiusPx / 60));
  for (let y = Math.max(0, Math.floor(center.y - radiusPx)); y < Math.min(img.height, center.y + radiusPx); y += step) {
    for (let x = Math.max(0, Math.floor(center.x - radiusPx)); x < Math.min(img.width, center.x + radiusPx); x += step) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy > radiusPx * radiusPx * 0.98) continue;
      vals.push(img.data[y * img.width + x]!);
    }
  }
  if (!vals.length) return 200;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.75)]!;
}
