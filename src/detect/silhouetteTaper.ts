/**
 * `silhouette-taper-v1`: the detector from the AIRC Barnes Maze Review app.
 *
 * 1. Each frame is reduced to a fixed pixel budget, so thresholds do not
 *    depend on the camera's resolution.
 * 2. The body is the median pixel of the most plausible foreground
 *    component, with a speed gate scaled to the arena's size. A frame is
 *    `ambiguous` when the area collapses or another component competes, and
 *    the reason is recorded.
 * 3. The nose is the end opposite the thin tail extension (v1). When that is
 *    undecided, the frame is re-read at full resolution around the animal and
 *    the end that stays thin and sparse is the tail (v2).
 * 4. After the whole video, short runs where v2 still could not decide are
 *    resolved from agreeing nose directions just before and after.
 *
 * Differences from the original app: it gets the engine's background and
 * arena mask instead of computing its own, and it refines the nose wherever
 * v1 is undecided rather than only near Barnes holes.
 */

import type { Point } from '../types';
import type { AnimalDetection, Detector, DetectorFactory, FrameDetection } from './types';
import {
  detectForegroundCandidate,
  estimateNoseFromSilhouette,
  estimateNoseFromTaperedSilhouette,
  type ForegroundCandidate,
  type NoseEstimate,
} from './silhouette';
import { resolveNoseOrientationContinuity, type NoseTrackEntry } from './orientationContinuity';
import { REFERENCE_PX_PER_CM } from './scale';

const TRACKING_PIXEL_BUDGET = 76_800;
const DIFFERENCE_THRESHOLD = 22;
const MAXIMUM_COMPONENT_AREA_PX = 600;
const MINIMUM_BODY_AREA_ARENA_RADIUS_SQUARED_FRACTION = 0.002;
const MAX_ARENA_DIAMETERS_PER_SECOND = 2;
const POSITION_TOLERANCE_ARENA_DIAMETERS = 0.01;
/** Never assume less than about half a frame passed, so duplicate timestamps do not freeze the gate. */
const MINIMUM_DISPLACEMENT_ELAPSED_S = 0.016;
/** A gap longer than this forgets the last position. */
const TRACK_RESET_GAP_S = 1;
const NOSE_REFINEMENT_CROP_RADIUS_FRACTION = 0.28;
const AREA_COLLAPSE_FRACTION = 0.6;
/** Half the 91.5 cm Barnes platform the constants above were tuned on. */
const REFERENCE_ARENA_RADIUS_CM = 45.75;
/** The tuning clips were 640×480, downsampled by half to fit the pixel budget. */
const REFERENCE_DOWNSAMPLE = 0.5;

export const silhouetteTaperDetector: DetectorFactory = (setup): Detector => {
  const { width, height, background, arenaMask } = setup;
  const scale = Math.min(1, Math.sqrt(TRACKING_PIXEL_BUDGET / (width * height)));
  const aw = Math.max(1, Math.round(width * scale));
  const ah = Math.max(1, Math.round(height * scale));
  const sx = width / aw;
  const sy = height / ah;

  const smallBackground = downsample(background.data, width, height, aw, ah);
  const smallArena = downsample(arenaMask.map((v) => v * 255), width, height, aw, ah).map((v) => (v >= 128 ? 1 : 0));
  let arenaPixels = 0;
  for (const v of smallArena) arenaPixels += v;
  // The original tracker sizes everything off the arena radius, which assumes
  // a Barnes platform. Given a calibrated scale, use the radius a Barnes
  // platform would have at this scale instead, so sizes follow the mouse and
  // not the arena (a 40 cm open field holds the same mouse as a 92 cm platform).
  const arenaRadius =
    setup.sizeScale === undefined
      ? Math.sqrt(arenaPixels / Math.PI)
      : REFERENCE_ARENA_RADIUS_CM * REFERENCE_PX_PER_CM * setup.sizeScale * scale;
  const maximumComponentAreaPx =
    setup.sizeScale === undefined
      ? MAXIMUM_COMPONENT_AREA_PX
      : Math.ceil(MAXIMUM_COMPONENT_AREA_PX * ((setup.sizeScale * scale) / REFERENCE_DOWNSAMPLE) ** 2);
  const minimumBodyAreaPx = Math.max(10, Math.round(arenaRadius ** 2 * MINIMUM_BODY_AREA_ARENA_RADIUS_SQUARED_FRACTION));

  let previous: Point | null = null;
  let previousTimeS: number | null = null;
  const recentAreas: number[] = [];
  const noseTrack: NoseTrackEntry[] = [];

  const detect = (frame: number, gray: Uint8Array, timeS: number): FrameDetection => {
    if (previousTimeS !== null && timeS - previousTimeS > TRACK_RESET_GAP_S) {
      previous = null;
      previousTimeS = null;
    }
    const maximumDisplacementPx =
      previousTimeS === null
        ? Number.POSITIVE_INFINITY
        : arenaRadius * 2 *
          (POSITION_TOLERANCE_ARENA_DIAMETERS +
            MAX_ARENA_DIAMETERS_PER_SECOND * Math.max(timeS - previousTimeS, MINIMUM_DISPLACEMENT_ELAPSED_S));

    const small = downsample(gray, width, height, aw, ah);
    const darkPixelsPx = countForeground(small, smallBackground, smallArena) * sx * sy;
    const candidate = detectForegroundCandidate(
      small, smallBackground, smallArena, aw, ah, previous, maximumDisplacementPx,
      DIFFERENCE_THRESHOLD, minimumBodyAreaPx, maximumComponentAreaPx,
    );
    if (!candidate) {
      noseTrack[frame] = { timeS, body: null, nose: null, endpoints: null };
      return { detection: null, darkPixelsPx: Math.round(darkPixelsPx) };
    }

    const expectedArea = recentAreas.length >= 15 ? lowerMedian(recentAreas) : null;
    const collapsed = expectedArea !== null && candidate.area < expectedArea * AREA_COLLAPSE_FRACTION;
    const bodyObserved = !collapsed && candidate.competitiveCandidateCount <= 1;
    const reason = collapsed
      ? `body area collapsed (${candidate.area}px vs ${expectedArea}px expected)`
      : candidate.competitiveCandidateCount > 1
        ? `selected 1 of ${candidate.competitiveCandidateCount} similarly plausible foreground components`
        : candidate.candidateCount > 1
          ? `selected body from ${candidate.candidateCount} foreground components`
          : 'single foreground component';

    const body = { x: candidate.x * sx, y: candidate.y * sy };
    let nose: { estimate: NoseEstimate; method: NoseTrackEntry['method']; offset: Point; scale: Point } = {
      estimate: estimateNoseFromSilhouette(candidate, aw, ah),
      method: 'silhouette-tail-asymmetry-v1',
      offset: { x: 0, y: 0 },
      scale: { x: sx, y: sy },
    };
    if (bodyObserved && nose.estimate.status !== 'observed') {
      const refined = refineNose(gray, background.data, arenaMask, width, height, body, arenaRadius * Math.max(sx, sy), sx * sy, maximumComponentAreaPx);
      if (refined) nose = { ...refined, method: 'adaptive-source-detail-tail-taper-v2', scale: { x: 1, y: 1 } };
    }
    const at = (x: number | null, y: number | null): Point | null =>
      x === null || y === null ? null : { x: x * nose.scale.x + nose.offset.x, y: y * nose.scale.y + nose.offset.y };
    const nosePoint = at(nose.estimate.x, nose.estimate.y);
    const tailPoint = at(nose.estimate.alternativeX, nose.estimate.alternativeY);
    const noseStatus = bodyObserved ? nose.estimate.status : 'ambiguous';
    const confidence = bodyObserved ? nose.estimate.confidence : Math.min(0.49, nose.estimate.confidence);

    noseTrack[frame] = {
      timeS,
      body,
      bodyObserved,
      nose: nosePoint ? { point: nosePoint, status: noseStatus, confidence } : null,
      method: nose.method,
      reason: bodyObserved ? nose.estimate.uncertaintyReason : `body observation was ambiguous: ${reason}`,
      endpoints:
        nose.method === 'adaptive-source-detail-tail-taper-v2' && nosePoint && tailPoint
          ? { primary: nosePoint, alternative: tailPoint }
          : null,
    };

    previous = candidate;
    previousTimeS = timeS;
    if (!collapsed) {
      recentAreas.push(candidate.area);
      if (recentAreas.length > 300) recentAreas.shift();
    }

    return {
      detection: toDetection(candidate, body, nosePoint, tailPoint, noseStatus === 'observed' ? confidence : Math.min(0.49, confidence), sx * sy, reason),
      darkPixelsPx: Math.round(darkPixelsPx),
    };
  };

  return {
    id: 'silhouette-taper-v1',
    detect,
    finish(detections) {
      const resolved = resolveNoseOrientationContinuity(noseTrack);
      return detections.map((d, frame) => {
        const r = resolved[frame];
        if (!d.detection || !r?.changed || !r.nose) return d;
        const nose = r.nose.point;
        const body = d.detection.body;
        const tail = r.nose.point === noseTrack[frame]?.endpoints?.alternative ? noseTrack[frame]!.endpoints!.primary : d.detection.tail;
        return {
          ...d,
          detection: {
            ...d.detection,
            nose,
            tail,
            noseArmPx: Math.hypot(nose.x - body.x, nose.y - body.y),
            tailArmPx: Math.hypot(tail.x - body.x, tail.y - body.y),
            axisConfidence: r.nose.confidence,
            reason: r.reason ?? d.detection.reason,
          },
        };
      });
    },
  };
};

/** Re-detect the animal at full resolution around `body` and judge the ends by taper. */
function refineNose(
  gray: Uint8Array,
  background: Uint8Array,
  arena: Uint8Array,
  width: number,
  height: number,
  body: Point,
  arenaRadiusPx: number,
  areaScale: number,
  maximumComponentAreaPx: number,
): { estimate: NoseEstimate; offset: Point } | null {
  const cropRadius = Math.max(24, Math.ceil(arenaRadiusPx * NOSE_REFINEMENT_CROP_RADIUS_FRACTION));
  const left = Math.max(0, Math.floor(body.x - cropRadius));
  const top = Math.max(0, Math.floor(body.y - cropRadius));
  const right = Math.min(width, Math.ceil(body.x + cropRadius));
  const bottom = Math.min(height, Math.ceil(body.y + cropRadius));
  const cw = right - left;
  const ch = bottom - top;
  if (cw < 8 || ch < 8) return null;

  const cropGray = new Uint8Array(cw * ch);
  const cropBackground = new Uint8Array(cw * ch);
  const cropArena = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const src = (top + y) * width + left;
    cropGray.set(gray.subarray(src, src + cw), y * cw);
    cropBackground.set(background.subarray(src, src + cw), y * cw);
    cropArena.set(arena.subarray(src, src + cw), y * cw);
  }
  const candidate = detectForegroundCandidate(
    cropGray, cropBackground, cropArena, cw, ch,
    { x: body.x - left, y: body.y - top }, cropRadius, DIFFERENCE_THRESHOLD,
    Math.max(10, Math.floor(10 * areaScale)), Math.ceil(maximumComponentAreaPx * areaScale),
  );
  if (!candidate) return null;
  return { estimate: estimateNoseFromTaperedSilhouette(candidate, cw, ch), offset: { x: left, y: top } };
}

function toDetection(
  c: ForegroundCandidate,
  body: Point,
  nose: Point | null,
  tail: Point | null,
  axisConfidence: number,
  areaScale: number,
  reason: string,
): AnimalDetection {
  const n = nose ?? body;
  const t = tail ?? body;
  const noseArmPx = Math.hypot(n.x - body.x, n.y - body.y);
  const tailArmPx = Math.hypot(t.x - body.x, t.y - body.y);
  const areaPx = Math.round(c.area * areaScale);
  return {
    areaPx,
    body,
    nose: n,
    tail: t,
    // Half-width, approximating the silhouette as a rectangle along its length.
    thicknessPx: noseArmPx + tailArmPx > 0 ? areaPx / (2 * (noseArmPx + tailArmPx)) : Math.sqrt(areaPx / Math.PI),
    noseArmPx,
    tailArmPx,
    axisConfidence: nose ? axisConfidence : 0,
    candidateCount: c.candidateCount,
    reacquired: false,
    reason,
  };
}

/** Box-filter `src` (w×h) down to aw×ah. */
function downsample(src: Uint8Array, w: number, h: number, aw: number, ah: number): Uint8Array {
  if (aw === w && ah === h) return src;
  const out = new Uint8Array(aw * ah);
  for (let y = 0; y < ah; y++) {
    const y0 = Math.floor((y * h) / ah);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / ah));
    for (let x = 0; x < aw; x++) {
      const x0 = Math.floor((x * w) / aw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / aw));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * w + xx]!;
      out[y * aw + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

function countForeground(gray: Uint8Array, background: Uint8Array, arena: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < gray.length; i++) if (arena[i] === 1 && background[i]! - gray[i]! >= DIFFERENCE_THRESHOLD) n++;
  return n;
}

function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
