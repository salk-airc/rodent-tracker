/** Detect the animal and estimate separate body and nose positions. */

import { chamferDistance, connectedComponents, type Component, type Gray } from '../geometry/imageOps';
import type { MazeGeometry, Point, TrackingParams } from '../types';

export interface AnimalDetection {
  readonly areaPx: number;
  readonly body: Point;
  readonly nose: Point;
  readonly tail: Point;
  readonly thicknessPx: number;
  readonly noseArmPx: number;
  readonly tailArmPx: number;
  /** How clearly the two ends could be told apart, 0..1. */
  readonly axisConfidence: number;
  readonly candidateCount: number;
  readonly reacquired: boolean;
}

export interface DetectionContext {
  readonly background: Gray;
  readonly geometry: MazeGeometry;
  readonly params: TrackingParams;
  /**
   * Pixel mask of the platform, precomputed once. Restricting the search to
   * the platform is what keeps the cable, the rig and a technician's sleeve
   * out of the data.
   */
  readonly platformMask: Uint8Array;
  /** Learned body area in px, or null before it is known. */
  readonly bodyAreaPx: number | null;
  /** Where the animal was last seen, for the local search window. */
  readonly previous: Point | null;
  /**
   * Direction of travel over recent frames, used only to break a tie between
   * the two ends of the body. Null when the animal has been still.
   */
  readonly heading: Point | null;
}

export interface FrameMasks {
  readonly mask: Uint8Array;
  readonly darkPixelsPx: number;
}

/**
 * Pixels that are darker than the empty-platform reference, inside the platform.
 *
 * Note what happens over a hole: the reference is already dark there, so an
 * animal on top of a hole barely differs from it and largely vanishes from this
 * mask. That is not a bug to paper over — it is the physical signal that the
 * animal is at a hole, and the event detector reads the resulting collapse in
 * visible area as evidence of an entry.
 */
export function buildFrameMask(frame: Uint8Array, cutoff: DarkCutoff, out?: Uint8Array): FrameMasks {
  const { limit, width, x0, x1, y0, y1 } = cutoff;
  const mask = out ?? new Uint8Array(limit.length);
  mask.fill(0);
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let i = y * width + x0, end = y * width + x1; i < end; i++) {
      const hit = frame[i]! < limit[i]! ? 1 : 0;
      mask[i] = hit;
      dark += hit;
    }
  }
  return { mask, darkPixelsPx: dark };
}

/** Per-pixel cutoff for `buildFrameMask` and the platform's bounding box [x0, x1) × [y0, y1). */
export interface DarkCutoff {
  readonly limit: Int16Array;
  readonly width: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Built once per recording so each frame costs one comparison per platform
 * pixel. For integer gray levels f and b, b − f > t  ⇔  f < ⌈b − t⌉; off the
 * platform the cutoff is −1, which no pixel is below.
 */
export function buildDarkCutoff(background: Gray, platformMask: Uint8Array, darkThreshold: number, width: number): DarkCutoff {
  const limit = new Int16Array(platformMask.length);
  let x0 = width, x1 = 0, y0 = Infinity, y1 = 0;
  for (let i = 0; i < limit.length; i++) {
    if (!platformMask[i]) {
      limit[i] = -1;
      continue;
    }
    limit[i] = Math.ceil(background.data[i]! - darkThreshold);
    const x = i % width, y = (i - x) / width;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
  }
  if (y0 === Infinity) y0 = 0;
  return { limit, width, x0, x1, y0, y1 };
}

/** Pixels within the platform, with a small margin so a rim-hugging animal is not clipped. */
export function buildPlatformMask(geometry: MazeGeometry, width: number, height: number, margin = 1.02): Uint8Array {
  const mask = new Uint8Array(width * height);
  const r2 = (geometry.platformRadiusPx * margin) ** 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - geometry.center.x;
      const dy = y - geometry.center.y;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Half-width of the local search box, in px. Generous: a mouse covers ~5 px per frame. */
const SEARCH_HALF_WIDTH = 70;

export function detectAnimal(mask: Uint8Array, ctx: DetectionContext, width: number, height: number): AnimalDetection | null {
  const { previous } = ctx;

  // Look near where the animal was; fall back to the whole platform. Searching
  // locally first is most of the speed, and searching globally on failure is
  // what stops one bad frame from losing the animal for the rest of the trial.
  let result = searchWindow(mask, ctx, width, height, previous, false);
  if (!result && previous) result = searchWindow(mask, ctx, width, height, null, true);
  if (!result) return null;

  const { chosen, candidateCount, reacquired } = result;
  const geom = describeBlob(mask, width, height, chosen, ctx);
  if (!geom) return null;

  // Retain oversized blobs so trial-start detection can identify the cylinder.
  return {
    areaPx: chosen.areaPx,
    ...geom,
    candidateCount,
    reacquired,
  };
}

function searchWindow(
  mask: Uint8Array,
  ctx: DetectionContext,
  width: number,
  height: number,
  near: Point | null,
  reacquired: boolean,
): { chosen: Component; candidateCount: number; reacquired: boolean } | null {
  const window = near
    ? {
        x0: Math.floor(near.x - SEARCH_HALF_WIDTH),
        y0: Math.floor(near.y - SEARCH_HALF_WIDTH),
        x1: Math.ceil(near.x + SEARCH_HALF_WIDTH),
        y1: Math.ceil(near.y + SEARCH_HALF_WIDTH),
      }
    : undefined;

  const cc = connectedComponents(mask, width, height, {
    minAreaPx: ctx.params.minBlobPx,
    ...(window ? { window } : {}),
  });
  if (cc.components.length === 0) return null;

  const chosen = pickAnimal(cc.components, ctx, near);
  if (!chosen) return null;
  return { chosen, candidateCount: cc.components.length, reacquired };
}

/** Choose a candidate using learned animal size, not size alone. */
function pickAnimal(candidates: ReadonlyArray<Component>, ctx: DetectionContext, near: Point | null): Component | null {
  const { bodyAreaPx } = ctx;
  let best: Component | null = null;
  let bestScore = -Infinity;

  for (const c of candidates) {
    let score = 0;

    if (bodyAreaPx) {
      // Log-ratio, so half the expected size and twice it are penalized alike.
      const ratio = c.areaPx / bodyAreaPx;
      score -= Math.abs(Math.log(ratio)) * 3;
      if (ratio > ctx.params.maxAreaRatio) score -= 10;
    } else {
      // Nothing learned yet: prefer bigger, since the alternative is noise.
      score += Math.log(c.areaPx);
    }

    if (near) {
      const cx = c.sumX / c.areaPx;
      const cy = c.sumY / c.areaPx;
      score -= Math.hypot(cx - near.x, cy - near.y) / 20;
    }

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

interface BlobGeometry {
  readonly body: Point;
  readonly nose: Point;
  readonly tail: Point;
  readonly thicknessPx: number;
  readonly noseArmPx: number;
  readonly tailArmPx: number;
  readonly axisConfidence: number;
}

/**
 * Body center, body axis, and which end is which.
 *
 * Body center is the peak of the distance transform — the thickest point of the
 * animal, which the tail cannot move. The axis comes from the second moments of
 * the *eroded* body core, so a tail swinging to one side does not rotate it.
 *
 * The ends are told apart by which one tapers into a thin tail (`tailTaper`).
 * When that is inconclusive, about 1% of frames on the sample clips, the arms
 * walked out along the axis are compared on length and thickness: a tail is
 * long and thin, a nose is short and blunt. Direction of travel is used only to
 * break a genuine tie, because a mouse backing out of a hole would otherwise
 * have its nose and tail swapped.
 */
function describeBlob(
  mask: Uint8Array,
  width: number,
  height: number,
  comp: Component,
  ctx: DetectionContext,
): BlobGeometry | null {
  const pad = 3;
  const win = {
    x0: Math.max(0, comp.minX - pad),
    y0: Math.max(0, comp.minY - pad),
    x1: Math.min(width - 1, comp.maxX + pad),
    y1: Math.min(height - 1, comp.maxY + pad),
  };

  // Isolate this component so a neighboring blob cannot leak into the distance
  // transform and inflate the apparent body thickness.
  const local = new Uint8Array(width * height);
  const cc = connectedComponents(mask, width, height, { minAreaPx: 1, window: win });
  let label = 0;
  {
    // The component we were handed came from a possibly different window, so
    // re-find it by locating its centroid pixel.
    const seedX = Math.round(comp.sumX / comp.areaPx);
    const seedY = Math.round(comp.sumY / comp.areaPx);
    label = cc.labels[seedY * width + seedX] ?? 0;
    if (label === 0) {
      // Centroid can fall in a concavity (a curled animal). Fall back to the
      // largest component in the window.
      let bestArea = 0;
      for (const c of cc.components) {
        if (c.areaPx > bestArea) {
          bestArea = c.areaPx;
          label = c.label;
        }
      }
    }
    if (label === 0) return null;
  }
  for (let y = win.y0; y <= win.y1; y++) {
    for (let x = win.x0; x <= win.x1; x++) {
      const i = y * width + x;
      if (cc.labels[i] === label) local[i] = 1;
    }
  }

  const dist = chamferDistance(local, width, height, win);

  let bodyX = 0;
  let bodyY = 0;
  let thickness = 0;
  for (let y = win.y0; y <= win.y1; y++) {
    for (let x = win.x0; x <= win.x1; x++) {
      const i = y * width + x;
      if (local[i] && dist.data[i]! > thickness) {
        thickness = dist.data[i]!;
        bodyX = x;
        bodyY = y;
      }
    }
  }
  if (thickness <= 0) return null;

  // Body core: the part of the animal thick enough not to be tail. The
  // threshold is capped relative to measured thickness so a thin, stretched
  // animal does not erode away entirely.
  const coreCut = Math.min(ctx.params.bodyCoreErodePx, thickness * 0.6);
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = win.y0; y <= win.y1; y++) {
    for (let x = win.x0; x <= win.x1; x++) {
      const i = y * width + x;
      if (!local[i] || dist.data[i]! < coreCut) continue;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
  }

  let axis: Point;
  if (n >= 4) {
    const mx = sx / n;
    const my = sy / n;
    const cxx = sxx / n - mx * mx;
    const cyy = syy / n - my * my;
    const cxy = sxy / n - mx * my;
    // Principal eigenvector of the 2x2 covariance matrix.
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    axis = { x: Math.cos(theta), y: Math.sin(theta) };
  } else if (ctx.heading) {
    axis = ctx.heading;
  } else {
    axis = { x: 1, y: 0 };
  }

  const body = { x: bodyX, y: bodyY };
  const taper = tailTaper(local, width, height, win);
  if (taper?.decided) {
    return {
      body,
      nose: taper.nose,
      tail: taper.tail,
      thicknessPx: thickness,
      noseArmPx: Math.hypot(taper.nose.x - bodyX, taper.nose.y - bodyY),
      tailArmPx: Math.hypot(taper.tail.x - bodyX, taper.tail.y - bodyY),
      axisConfidence: taper.confidence,
    };
  }

  const plus = walkArm(local, width, height, win, bodyX, bodyY, axis, dist);
  const minus = walkArm(local, width, height, win, bodyX, bodyY, { x: -axis.x, y: -axis.y }, dist);

  // Tail score: long and thin. Higher means more tail-like.
  const tailiness = (arm: Arm) => arm.lengthPx / Math.max(0.75, arm.meanThickness);
  let noseArm = plus;
  let tailArm = minus;
  if (tailiness(plus) > tailiness(minus)) {
    noseArm = minus;
    tailArm = plus;
  }

  // If both ends look alike the axis is not telling us much (a curled animal,
  // or a tail folded alongside the body). Prefer the direction of travel.
  const scores = [tailiness(plus), tailiness(minus)].sort((a, b) => b - a);
  const separation = scores[0]! > 0 ? (scores[0]! - scores[1]!) / scores[0]! : 0;
  let axisConfidence = Math.min(1, separation * 2.5);
  if (separation < 0.2 && ctx.heading) {
    const dotPlus = axis.x * ctx.heading.x + axis.y * ctx.heading.y;
    if (dotPlus >= 0) {
      noseArm = plus;
      tailArm = minus;
    } else {
      noseArm = minus;
      tailArm = plus;
    }
    axisConfidence = 0.35;
  }
  // The taper test is the better one; when it could not decide, say so.
  if (taper) axisConfidence = Math.min(axisConfidence, taper.confidence);

  return {
    body,
    nose: noseArm.tip,
    tail: tailArm.tip,
    thicknessPx: thickness,
    noseArmPx: noseArm.lengthPx,
    tailArmPx: tailArm.lengthPx,
    axisConfidence,
  };
}

/**
 * Which end of the whole silhouette carries the tail. A tail is a thin, sparse
 * strip, so the tail end is the one whose pixels have the fewest neighbors and
 * whose band is narrowest against the middle of the body. Unlike walking out
 * from the body center, this still works when the tail curves off the body
 * axis or the head is hidden over a hole, which is where hole visits are
 * decided. Weights and thresholds come from an independent implementation;
 * tests/reviewed-labels.test.ts holds the evidence.
 */
function tailTaper(
  local: Uint8Array,
  width: number,
  height: number,
  win: { x0: number; y0: number; x1: number; y1: number },
): { nose: Point; tail: Point; decided: boolean; confidence: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = win.y0; y <= win.y1; y++) {
    for (let x = win.x0; x <= win.x1; x++) {
      if (local[y * width + x]) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const n = xs.length;
  if (n < 40) return null;

  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ax = Math.cos(theta);
  const ay = Math.sin(theta);
  const along = xs.map((x, i) => (x - mx) * ax + (ys[i]! - my) * ay);
  const across = xs.map((x, i) => -(x - mx) * ay + (ys[i]! - my) * ax);
  let low = Infinity;
  let high = -Infinity;
  for (const a of along) {
    if (a < low) low = a;
    if (a > high) high = a;
  }
  const span = high - low;
  if (span < 8) return null;

  const neighbors = (x: number, y: number) => {
    let count = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && local[ny * width + nx]) count++;
      }
    }
    return count;
  };
  /** Spread of the middle 80% across the axis, for pixels whose position along it passes `keep`. */
  const bandWidth = (keep: (a: number) => boolean) => {
    const values = across.filter((_, i) => keep(along[i]!)).sort((a, b) => a - b);
    if (values.length === 0) return 0;
    return values[Math.floor(0.9 * (values.length - 1))]! - values[Math.floor(0.1 * (values.length - 1))]!;
  };
  const centralWidth = Math.max(1, bandWidth((a) => a >= low + span * 0.35 && a <= high - span * 0.35));
  const tailScore = (keep: (a: number) => boolean) => {
    let density = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!keep(along[i]!)) continue;
      density += neighbors(xs[i]!, ys[i]!);
      count++;
    }
    const sparse = Math.max(0, 1 - density / Math.max(1, count) / 25);
    const narrow = Math.max(0, 1 - bandWidth(keep) / centralWidth);
    return 0.7 * sparse + 0.3 * narrow;
  };
  const tip = (keep: (a: number) => boolean): Point => {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!keep(along[i]!)) continue;
      sx += xs[i]!;
      sy += ys[i]!;
      count++;
    }
    return { x: sx / count, y: sy / count };
  };

  const lowTail = tailScore((a) => a <= low + span * 0.2);
  const highTail = tailScore((a) => a >= high - span * 0.2);
  const lowTip = tip((a) => a <= low + span * 0.06);
  const highTip = tip((a) => a >= high - span * 0.06);
  const tailIsLow = lowTail > highTail;
  const difference = Math.abs(lowTail - highTail);
  return {
    nose: tailIsLow ? highTip : lowTip,
    tail: tailIsLow ? lowTip : highTip,
    decided: difference >= 0.075 && Math.max(lowTail, highTail) >= 0.2,
    confidence: Math.min(0.95, 0.5 + difference * 2),
  };
}

interface Arm {
  readonly tip: Point;
  readonly lengthPx: number;
  readonly meanThickness: number;
}

/**
 * Walk out from the body center along a direction to the far edge of the blob.
 *
 * Small gaps are tolerated (compression can punch a pixel out of a thin tail)
 * but a long gap ends the arm, so the walk cannot jump to a different object.
 */
function walkArm(
  local: Uint8Array,
  width: number,
  height: number,
  win: { x0: number; y0: number; x1: number; y1: number },
  bx: number,
  by: number,
  dir: Point,
  dist: { data: Float32Array },
): Arm {
  const step = 0.5;
  const maxGap = 3;
  let tipX = bx;
  let tipY = by;
  let length = 0;
  let gap = 0;
  let thicknessSum = 0;
  let thicknessCount = 0;

  for (let r = step; r < 400; r += step) {
    const x = Math.round(bx + dir.x * r);
    const y = Math.round(by + dir.y * r);
    if (x < win.x0 || x > win.x1 || y < win.y0 || y > win.y1 || x < 0 || y < 0 || x >= width || y >= height) break;
    const i = y * width + x;
    if (local[i]) {
      gap = 0;
      tipX = x;
      tipY = y;
      length = r;
      thicknessSum += dist.data[i]!;
      thicknessCount++;
    } else {
      gap += step;
      if (gap > maxGap) break;
    }
  }

  return {
    tip: { x: tipX, y: tipY },
    lengthPx: length,
    meanThickness: thicknessCount ? thicknessSum / thicknessCount : 0,
  };
}
