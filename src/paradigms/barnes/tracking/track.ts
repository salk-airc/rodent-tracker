/**
 * The one expensive pass: video in, per-frame observations out.
 *
 * Everything interpretive happens afterwards, on the observations, in
 * `resolve.ts`. This file's only job is to measure.
 */

import type { FrameSource, MazeGeometry, TrackObservation, TrackingParams } from '../types';
import { nearestHole } from '../types';
import type { Gray } from '../../../image/imageOps';
import { buildPlatformMask } from '../geometry/mask';
import type { DetectorFactory } from '../../../detect/types';
import type { AnimalProfile } from '../../../detect/scale';
import { detectFrames } from '../../../tracking/detectFrames';

export interface TrackResult {
  readonly observations: ReadonlyArray<TrackObservation>;
  /** Learned body area, px: the median area over frames that had a plausible animal. */
  readonly bodyAreaPx: number;
  /** Spread of the area distribution, as the interquartile range over the median. */
  readonly bodyAreaSpread: number;
  /** The detector that produced the positions, e.g. `dark-blob-v1`. */
  readonly detectorId: string;
  readonly warnings: ReadonlyArray<string>;
}

/** Detect the animal on the platform, then add the Barnes fields (nearest hole, radial position). */
export async function trackVideo(
  source: FrameSource,
  background: Gray,
  geometry: MazeGeometry,
  params: TrackingParams,
  onProgress?: (done: number, total: number) => void,
  detectorFactory?: DetectorFactory,
  sizeScale?: number,
  animal?: AnimalProfile,
): Promise<TrackResult> {
  const arenaMask = buildPlatformMask(geometry, source.width, source.height);
  const detected = await detectFrames(source, background, arenaMask, params, {
    ...(detectorFactory ? { detector: detectorFactory } : {}),
    ...(sizeScale === undefined ? {} : { sizeScale }),
    ...(animal === undefined ? {} : { animal }),
    ...(onProgress ? { onProgress } : {}),
  });
  const finished = detected.frames;

  const observations: TrackObservation[] = finished.map(({ detection: det, darkPixelsPx }, frame) => {
    if (!det) return missingObservation(frame, darkPixelsPx);
    const nearest = nearestHole(geometry, det.nose);
    const radial = Math.hypot(det.body.x - geometry.center.x, det.body.y - geometry.center.y) / geometry.platformRadiusPx;
    return {
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
    };
  });

  const stats = { median: detected.bodyAreaPx, spread: detected.bodyAreaSpread, count: detected.detectedFrames };
  const warnings: string[] = [];
  if (stats.count < 10) {
    warnings.push('Animal detected in fewer than 10 frames. Check the threshold and platform outline.');
  }
  if (stats.spread > 0.8) {
    warnings.push(
      `Animal-area spread is high (${stats.spread.toFixed(2)}). Check for false detections or partial entries.`,
    );
  }

  return { observations, bodyAreaPx: stats.median, bodyAreaSpread: stats.spread, detectorId: detected.detectorId, warnings };
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
