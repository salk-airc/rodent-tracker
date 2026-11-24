/**
 * The one expensive pass every paradigm shares: run a detector over every
 * frame inside the arena mask. Paradigms add their own meaning afterwards
 * (which hole, which zone) from these detections, without reading pixels again.
 */

import type { FrameSource, TrackingParams } from '../types';
import { frameTime } from '../types';
import type { Gray } from '../image/imageOps';
import { darkBlobDetector } from '../detect/darkBlob';
import type { DetectorFactory, FrameDetection } from '../detect/types';
import { scaleTrackingParams, type AnimalProfile } from '../detect/scale';

export interface DetectFramesOptions {
  /** Which detector finds the animal. Defaults to `dark-blob-v1`. */
  readonly detector?: DetectorFactory;
  /**
   * This video's px/cm over the sample clips' (`sizeScaleFor`). Omit to keep
   * the pixel sizes as tuned on the sample clips.
   */
  readonly sizeScale?: number;
  /** Physical rodent profile (defaults to adult mouse). */
  readonly animal?: AnimalProfile;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface FrameDetections {
  /** One entry per frame, in frame order. */
  readonly frames: ReadonlyArray<FrameDetection>;
  readonly detectorId: string;
  /** Median area over frames where something was found, px. */
  readonly bodyAreaPx: number;
  /** Interquartile range of that area over its median. */
  readonly bodyAreaSpread: number;
  /** Frames where something was found. */
  readonly detectedFrames: number;
}

export async function detectFrames(
  source: FrameSource,
  background: Gray,
  arenaMask: Uint8Array,
  params: TrackingParams,
  options: DetectFramesOptions = {},
): Promise<FrameDetections> {
  const { width, height } = source;
  const { sizeScale, animal } = options;
  const detector = (options.detector ?? darkBlobDetector)({
    width,
    height,
    background,
    arenaMask,
    params: sizeScale === undefined && animal === undefined ? params : scaleTrackingParams(params, sizeScale ?? 1, animal),
    ...(sizeScale === undefined ? {} : { sizeScale }),
    ...(animal === undefined ? {} : { animal }),
  });
  const detections: FrameDetection[] = [];
  await source.scan(
    { from: 0, to: source.frameCount - 1 },
    (frame, gray) => {
      detections[frame] = detector.detect(frame, gray, frameTime(source.timebase, frame));
    },
    options.onProgress,
  );
  const frames = detector.finish ? detector.finish(detections) : detections;
  const stats = areaStatistics(frames);
  return { frames, detectorId: detector.id, bodyAreaPx: stats.median, bodyAreaSpread: stats.spread, detectedFrames: stats.count };
}

/**
 * Body area for the whole recording, from the median of every frame that found
 * something.
 *
 * The median rather than the mean, and over all frames rather than a sample,
 * because the contaminants are known and are minorities: the start cylinder is
 * 10% of the Barnes clip `test51`, and the head-down frames at the end of
 * `test53` are about 20% of it. A mean would be dragged by both.
 */
function areaStatistics(frames: ReadonlyArray<FrameDetection>): { median: number; spread: number; count: number } {
  const areas = frames
    .map((f) => f.detection?.areaPx ?? 0)
    .filter((a) => a > 0)
    .sort((a, b) => a - b);
  if (areas.length === 0) return { median: 0, spread: 0, count: 0 };
  const q = (f: number) => areas[Math.min(areas.length - 1, Math.max(0, Math.round(f * (areas.length - 1))))]!;
  const med = q(0.5);
  return { median: med, spread: med > 0 ? (q(0.75) - q(0.25)) / med : 0, count: areas.length };
}
