/**
 * The one expensive pass: video in, per-frame observations out.
 *
 * Everything interpretive happens afterwards, on the observations, in
 * `resolve.ts`. This file's only job is to measure.
 */

import type { FrameSource, MazeGeometry, Point, TrackObservation, TrackingParams } from '../types';
import { nearestHole } from '../types';
import type { Gray } from '../geometry/imageOps';
import { buildDarkCutoff, buildFrameMask, buildPlatformMask, detectAnimal, type DetectionContext } from './detectAnimal';
import { median } from '../stats';

export interface TrackResult {
  readonly observations: ReadonlyArray<TrackObservation>;
  /** Learned body area, px: the median area over frames that had a plausible animal. */
  readonly bodyAreaPx: number;
  /** Spread of the area distribution, as the interquartile range over the median. */
  readonly bodyAreaSpread: number;
  readonly warnings: ReadonlyArray<string>;
}

/** How many frames of history feed the direction-of-travel estimate. */
const HEADING_WINDOW = 5;
/** Below this movement the heading is meaningless, so it is not used. */
const HEADING_MIN_PX = 3;

export async function trackVideo(
  source: FrameSource,
  background: Gray,
  geometry: MazeGeometry,
  params: TrackingParams,
  onProgress?: (done: number, total: number) => void,
): Promise<TrackResult> {
  const { width, height } = source;
  const platformMask = buildPlatformMask(geometry, width, height);
  const darkCutoff = buildDarkCutoff(background, platformMask, params.darkThreshold, width);

  const observations: TrackObservation[] = [];
  const maskBuffer = new Uint8Array(width * height);
  const recentBodies: Point[] = [];

  // Body area is learned as we go, from a running median of what we have
  // accepted so far. It starts unknown, which is why the blob chooser falls
  // back to "prefer larger" for the first frames, and why the statuses are
  // finalized in a second, cheap pass once the whole distribution is in.
  const acceptedAreas: number[] = [];
  let bodyAreaPx: number | null = null;

  await source.scan(
    { from: 0, to: source.frameCount - 1 },
    (frame, gray) => {
      const previous = recentBodies.length ? recentBodies[recentBodies.length - 1]! : null;
      const heading = estimateHeading(recentBodies);

      const ctx: DetectionContext = {
        background,
        geometry,
        params,
        platformMask,
        bodyAreaPx,
        previous,
        heading,
      };

      const { mask, darkPixelsPx } = buildFrameMask(gray, darkCutoff, maskBuffer);
      const det = detectAnimal(mask, ctx, width, height);

      if (!det) {
        observations.push(missingObservation(frame, darkPixelsPx));
        // Do not clear the position history: the animal is most likely inside a
        // hole at the last known spot, and the next frame should look there
        // first rather than searching the whole platform.
        return;
      }

      const nearest = nearestHole(geometry, det.nose);
      const radial = Math.hypot(det.body.x - geometry.center.x, det.body.y - geometry.center.y) / geometry.platformRadiusPx;

      observations.push({
        frame,
        areaMeasured: true,
        areaPx: det.areaPx,
        darkPixelsPx,
        body: det.body,
        nose: det.nose,
        tail: det.tail,
        thicknessPx: det.thicknessPx,
        noseArmPx: det.noseArmPx,
        tailArmPx: det.tailArmPx,
        nearestHole: nearest?.hole.index ?? -1,
        nearestHoleDistPx: nearest?.distPx ?? Number.POSITIVE_INFINITY,
        radialFraction: radial,
        candidateCount: det.candidateCount,
        reacquired: det.reacquired,
        axisConfidence: det.axisConfidence,
      });

      recentBodies.push(det.body);
      if (recentBodies.length > HEADING_WINDOW) recentBodies.shift();

      // Only frames that look like a whole animal feed the size estimate. A
      // head-down animal or the start cylinder would both bias it.
      if (bodyAreaPx === null || (det.areaPx < bodyAreaPx * params.maxAreaRatio && det.areaPx > bodyAreaPx * 0.5)) {
        acceptedAreas.push(det.areaPx);
        if (acceptedAreas.length % 16 === 0 || bodyAreaPx === null) bodyAreaPx = median(acceptedAreas);
      }
    },
    onProgress,
  );

  const stats = areaStatistics(observations);
  const warnings: string[] = [];
  if (stats.count < 10) {
    warnings.push('Animal detected in fewer than 10 frames. Check the threshold and platform outline.');
  }
  if (stats.spread > 0.8) {
    warnings.push(
      `Animal-area spread is high (${stats.spread.toFixed(2)}). Check for false detections or partial entries.`,
    );
  }

  return { observations, bodyAreaPx: stats.median, bodyAreaSpread: stats.spread, warnings };
}

/**
 * Body area for the whole recording, from the median of every frame that found
 * something.
 *
 * The median rather than the mean, and over all frames rather than a sample,
 * because the contaminants are known and are minorities: the start cylinder is
 * 10% of `test51`, and the head-down frames at the end of `test53` are about
 * 20% of it. A mean would be dragged by both.
 */
function areaStatistics(observations: ReadonlyArray<TrackObservation>): { median: number; spread: number; count: number } {
  const areas = observations.filter((o) => o.areaPx > 0).map((o) => o.areaPx).sort((a, b) => a - b);
  if (areas.length === 0) return { median: 0, spread: 0, count: 0 };
  const q = (f: number) => areas[Math.min(areas.length - 1, Math.max(0, Math.round(f * (areas.length - 1))))]!;
  const med = q(0.5);
  return { median: med, spread: med > 0 ? (q(0.75) - q(0.25)) / med : 0, count: areas.length };
}

/** A measured frame in which no animal was found. */
export function missingObservation(frame: number, darkPixelsPx = 0): TrackObservation {
  return {
    frame,
    areaMeasured: true,
    areaPx: 0,
    darkPixelsPx,
    body: null,
    nose: null,
    tail: null,
    thicknessPx: 0,
    noseArmPx: 0,
    tailArmPx: 0,
    nearestHole: -1,
    nearestHoleDistPx: Number.POSITIVE_INFINITY,
    radialFraction: Number.NaN,
    candidateCount: 0,
    reacquired: false,
    axisConfidence: 0,
  };
}

function estimateHeading(recent: ReadonlyArray<Point>): Point | null {
  if (recent.length < 2) return null;
  const a = recent[0]!;
  const b = recent[recent.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < HEADING_MIN_PX) return null;
  return { x: dx / len, y: dy / len };
}


