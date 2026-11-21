/**
 * Silhouette primitives from the AIRC Barnes Maze Review tracker,
 * ported with their behavior unchanged: foreground selection with a speed
 * gate and a "competing candidates" count, and two ways to tell the nose end
 * of a silhouette from the tail end without using direction of travel.
 */

import type { Point } from '../types';

export interface ForegroundCandidate extends Point {
  readonly area: number;
  readonly candidateCount: number;
  /** Candidates whose score is within a quarter of the winner's area of it. */
  readonly competitiveCandidateCount: number;
  /** Pixel indices of the chosen component, row-major. */
  readonly pixels: readonly number[];
}

export interface NoseEstimate {
  readonly x: number | null;
  readonly y: number | null;
  /** The opposite endpoint: the nose if this estimate has the ends swapped. */
  readonly alternativeX: number | null;
  readonly alternativeY: number | null;
  readonly status: 'observed' | 'ambiguous';
  readonly confidence: number;
  readonly uncertaintyReason: string;
}

const COMPETITIVE_SCORE_MARGIN_AREA_FRACTION = 0.25;

/**
 * The most plausible foreground component: pixels darker than the background
 * by `differenceThreshold`, cleaned with a 3x3 neighbour count, sized between
 * the area limits, scored by area minus twice its distance from `previous`,
 * and rejected outright when it moved further than `maximumDisplacementPx`.
 */
export function detectForegroundCandidate(
  gray: Uint8Array,
  background: Uint8Array,
  arena: Uint8Array,
  width: number,
  height: number,
  previous: Point | null,
  maximumDisplacementPx: number,
  differenceThreshold = 22,
  minimumComponentAreaPx = 10,
  maximumComponentAreaPx = 600,
): ForegroundCandidate | null {
  const raw = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    raw[i] = arena[i] === 1 && background[i]! - gray[i]! >= differenceThreshold ? 1 : 0;
  }

  const cleaned = new Uint8Array(raw.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (raw[i] === 0) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) neighbors += raw[i + dy * width + dx]!;
      }
      if (neighbors >= 3) cleaned[i] = 1;
    }
  }

  const plausible = componentPixels(cleaned, width, height).filter(
    (pixels) => pixels.length >= minimumComponentAreaPx && pixels.length <= maximumComponentAreaPx,
  );
  if (plausible.length === 0) return null;

  const candidates = plausible
    .map((pixels) => {
      const x = coordinateMedian(pixels, width, 'x');
      const y = coordinateMedian(pixels, width, 'y');
      const distance = previous ? Math.hypot(x - previous.x, y - previous.y) : 0;
      return { x, y, area: pixels.length, pixels, score: pixels.length - distance * 2 };
    })
    .sort((a, b) => b.score - a.score);
  const selected = candidates[0]!;
  if (previous && Math.hypot(selected.x - previous.x, selected.y - previous.y) > maximumDisplacementPx) {
    return null;
  }
  const competitiveCandidateCount = candidates.filter(
    (c) => selected.score - c.score <= selected.area * COMPETITIVE_SCORE_MARGIN_AREA_FRACTION,
  ).length;
  return {
    x: selected.x,
    y: selected.y,
    area: selected.area,
    candidateCount: candidates.length,
    competitiveCandidateCount,
    pixels: selected.pixels,
  };
}

const quantile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))]!;

const ambiguous = (confidence: number, uncertaintyReason: string): NoseEstimate => ({
  x: null,
  y: null,
  alternativeX: null,
  alternativeY: null,
  status: 'ambiguous',
  confidence,
  uncertaintyReason,
});

/**
 * v1: the head end is opposite the thin tail extension beyond the dense body
 * core. Deliberately ignores direction of travel, which is unreliable during
 * pauses and reversals.
 */
export function estimateNoseFromSilhouette(candidate: ForegroundCandidate, width: number, height: number): NoseEstimate {
  if (candidate.pixels.length < 20 || width <= 0 || height <= 0) {
    return ambiguous(0, 'silhouette is too small to separate head from tail');
  }

  const mask = new Set(candidate.pixels);
  const core = candidate.pixels.filter((index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    let neighbors = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (mask.has(ny * width + nx)) neighbors++;
      }
    }
    return neighbors >= 12;
  });
  if (core.length < 12) return ambiguous(0.1, 'no sufficiently dense body core was visible');

  const { mean, axis } = principalAxis(core.map((index) => ({ x: index % width, y: Math.floor(index / width) })));
  const project = (index: number) =>
    (index % width - mean.x) * axis.x + (Math.floor(index / width) - mean.y) * axis.y;
  const coreProjections = core.map(project).sort((a, b) => a - b);
  const allProjections = candidate.pixels.map(project).sort((a, b) => a - b);
  const coreLow = quantile(coreProjections, 0.05);
  const coreHigh = quantile(coreProjections, 0.95);
  const bodyLength = coreHigh - coreLow;
  if (bodyLength < 3) return ambiguous(0.1, 'body axis was too short to orient reliably');

  const first = allProjections[0]!;
  const last = allProjections[allProjections.length - 1]!;
  const lowExtension = coreLow - first;
  const highExtension = last - coreHigh;
  const extensionDifference = Math.abs(highExtension - lowExtension);
  const minimumTailEvidence = Math.max(2, bodyLength * 0.2);
  const tailIsHigh = highExtension > lowExtension;
  const outerTolerance = Math.max(1, bodyLength * 0.08);
  const nose = meanOf(
    candidate.pixels.filter((i) => (tailIsHigh ? project(i) <= first + outerTolerance : project(i) >= last - outerTolerance)),
    width,
  );
  const alternative = meanOf(
    candidate.pixels.filter((i) => (tailIsHigh ? project(i) >= last - outerTolerance : project(i) <= first + outerTolerance)),
    width,
  );

  const confidence = Math.max(0, Math.min(1, 0.35 + extensionDifference / Math.max(1, bodyLength)));
  const observed = extensionDifference >= minimumTailEvidence && confidence >= 0.55;
  return {
    x: nose.x,
    y: nose.y,
    alternativeX: alternative.x,
    alternativeY: alternative.y,
    status: observed ? 'observed' : 'ambiguous',
    confidence: Math.round(confidence * 1000) / 1000,
    uncertaintyReason: observed
      ? `thin tail extension resolved the opposite silhouette endpoint as the nose (${extensionDifference.toFixed(1)} px asymmetry)`
      : `head and tail endpoints were not sufficiently asymmetric (${extensionDifference.toFixed(1)} px; ${minimumTailEvidence.toFixed(1)} px required)`,
  };
}

/**
 * v2: the tail end is the one that stays thin and sparse, measured as
 * endpoint width across the body axis and local pixel density. Used on a
 * full-resolution crop when v1 could not decide.
 */
export function estimateNoseFromTaperedSilhouette(
  candidate: ForegroundCandidate,
  width: number,
  height: number,
): NoseEstimate {
  if (candidate.pixels.length < 40 || width <= 0 || height <= 0) {
    return ambiguous(0, 'silhouette is too small to measure head-tail taper');
  }

  const mask = new Set(candidate.pixels);
  const points = candidate.pixels.map((index) => ({ x: index % width, y: Math.floor(index / width) }));
  const { mean, axis } = principalAxis(points);
  const transverse = { x: -axis.y, y: axis.x };
  const projected = points.map((p) => ({
    ...p,
    along: (p.x - mean.x) * axis.x + (p.y - mean.y) * axis.y,
    across: (p.x - mean.x) * transverse.x + (p.y - mean.y) * transverse.y,
  }));
  const along = projected.map((p) => p.along).sort((a, b) => a - b);
  const low = along[0]!;
  const high = along[along.length - 1]!;
  const span = high - low;
  if (span < 8) return ambiguous(0.1, 'body axis was too short to measure head-tail taper');

  const localNeighbors = (p: { x: number; y: number }) => {
    let count = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const y = p.y + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const x = p.x + dx;
        if (x < 0 || x >= width) continue;
        if (mask.has(y * width + x)) count++;
      }
    }
    return count;
  };
  const endpointStats = (side: 'low' | 'high') => {
    const band = projected.filter((p) => (side === 'low' ? p.along <= low + span * 0.2 : p.along >= high - span * 0.2));
    const across = band.map((p) => p.across).sort((a, b) => a - b);
    const widthPx = quantile(across, 0.9) - quantile(across, 0.1);
    const meanNeighbors = band.reduce((t, p) => t + localNeighbors(p), 0) / Math.max(1, band.length);
    return { widthPx, meanNeighbors };
  };
  const lowStats = endpointStats('low');
  const highStats = endpointStats('high');
  const centralAcross = projected
    .filter((p) => p.along >= low + span * 0.35 && p.along <= high - span * 0.35)
    .map((p) => p.across)
    .sort((a, b) => a - b);
  const centralWidth =
    centralAcross.length === 0 ? 1 : Math.max(1, quantile(centralAcross, 0.9) - quantile(centralAcross, 0.1));
  const tailScore = (s: typeof lowStats) =>
    Math.max(0, 1 - s.meanNeighbors / 25) * 0.7 + Math.max(0, 1 - s.widthPx / centralWidth) * 0.3;
  const lowTailScore = tailScore(lowStats);
  const highTailScore = tailScore(highStats);
  const scoreDifference = Math.abs(lowTailScore - highTailScore);
  const noseIsLow = !(lowTailScore > highTailScore);
  const edge = (lowSide: boolean) =>
    centroid(projected.filter((p) => (lowSide ? p.along <= low + span * 0.06 : p.along >= high - span * 0.06)));
  const nose = edge(noseIsLow);
  const alternative = edge(!noseIsLow);

  const observed = scoreDifference >= 0.075 && Math.max(lowTailScore, highTailScore) >= 0.2;
  const confidence = Math.min(0.95, 0.5 + scoreDifference * 2);
  return {
    x: nose.x,
    y: nose.y,
    alternativeX: alternative.x,
    alternativeY: alternative.y,
    status: observed ? 'observed' : 'ambiguous',
    confidence: Math.round(confidence * 1000) / 1000,
    uncertaintyReason: observed
      ? `tail taper resolved the opposite silhouette endpoint as the nose (${lowStats.widthPx.toFixed(1)} px vs ${highStats.widthPx.toFixed(1)} px endpoint width)`
      : `head and tail taper remained too similar (${lowStats.widthPx.toFixed(1)} px vs ${highStats.widthPx.toFixed(1)} px endpoint width)`,
  };
}

function principalAxis(points: ReadonlyArray<Point>): { mean: Point; axis: Point } {
  const mean = centroid(points);
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const p of points) {
    const dx = p.x - mean.x;
    const dy = p.y - mean.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  return { mean, axis: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function centroid(points: ReadonlyArray<Point>): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}

function meanOf(indices: readonly number[], width: number): Point {
  return centroid(indices.map((i) => ({ x: i % width, y: Math.floor(i / width) })));
}

/** 8-connected components of a binary mask, as lists of pixel indices. */
function componentPixels(mask: Uint8Array, width: number, height: number): number[][] {
  const seen = new Uint8Array(mask.length);
  const components: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    const pixels: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] === 1 && seen[n] === 0) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    components.push(pixels);
  }
  return components;
}

function coordinateMedian(pixels: readonly number[], width: number, axis: 'x' | 'y'): number {
  const values = pixels.map((i) => (axis === 'x' ? i % width : Math.floor(i / width))).sort((a, b) => a - b);
  // The lower median, a whole pixel coordinate, as in the original.
  return values[Math.ceil(values.length / 2) - 1] ?? 0;
}
