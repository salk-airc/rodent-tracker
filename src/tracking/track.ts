/**
 * The one expensive pass: video in, per-frame observations out.
 *
 * Everything interpretive happens afterwards, on the observations, in
 * `resolve.ts`. This file's only job is to measure.
 */

import type { FrameSource, MazeGeometry, TrackObservation, TrackingParams } from '../types';
import { frameTime, nearestHole } from '../types';
import type { Gray } from '../geometry/imageOps';
import { buildPlatformMask } from './detectAnimal';
import { darkBlobDetector } from '../detect/darkBlob';
import type { DetectorFactory, FrameDetection } from '../detect/types';
import { scaleTrackingParams } from '../detect/scale';

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

export async function trackVideo(
  source: FrameSource,
  background: Gray,
  geometry: MazeGeometry,
  params: TrackingParams,
  onProgress?: (done: number, total: number) => void,
  detectorFactory: DetectorFactory = darkBlobDetector,
  /**
   * This video's px/cm over the sample clips' (`sizeScaleFor`). Omit to keep
   * the pixel sizes as tuned on the sample clips.
   */
  sizeScale?: number,
): Promise<TrackResult> {
  const { width, height } = source;
  const arenaMask = buildPlatformMask(geometry, width, height);
  const detector = detectorFactory({
    width,
    height,
    background,
    arenaMask,
    params: sizeScale === undefined ? params : scaleTrackingParams(params, sizeScale),
    ...(sizeScale === undefined ? {} : { sizeScale }),
  });
  const detections: FrameDetection[] = [];
  await source.scan(
    { from: 0, to: source.frameCount - 1 },
    (frame, gray) => {
      detections[frame] = detector.detect(frame, gray, frameTime(source.timebase, frame));
    },
    onProgress,
  );
  const finished = detector.finish ? detector.finish(detections) : detections;

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

  return { observations, bodyAreaPx: stats.median, bodyAreaSpread: stats.spread, detectorId: detector.id, warnings };
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
