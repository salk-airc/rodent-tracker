/**
 * Barnes-maze adapter for DeepLabCut and SLEAP analysis CSV tracks.
 *
 * The format sniffing, CSV parsing and keypoint extraction live in the shared
 * engine (`src/io/pose.ts`); this file adapts them to Barnes `TrackObservation`
 * and `TrackFrame` records, enforcing separate nose and body coordinates so a
 * body point is never silently substituted for a nose-based hole visit.
 */

import {
  exportDeepLabCutPoseCsv,
  parseCsv,
  parsePoseCsv,
  sniffPoseFormat,
  type PoseColumnMapping,
  type PoseExportOptions,
  type PoseFormat,
  type PoseImportOptions,
} from '../../../io/pose';
import type { TrackFrame, TrackObservation } from '../types';

export { parseCsv, sniffPoseFormat, type PoseExportOptions, type PoseFormat, type PoseImportOptions };

export interface PoseImportResult {
  readonly format: Exclude<PoseFormat, 'unknown'>;
  readonly observations: ReadonlyArray<TrackObservation>;
  /** Body-part names found in the file, and what each was taken to mean. */
  readonly mapping: ReadonlyArray<PoseColumnMapping>;
  readonly frameCount: number;
  /** Frames whose confidence fell below the threshold and are treated as absent. */
  readonly lowConfidenceFrames: number;
  readonly warnings: ReadonlyArray<string>;
}

export function importPoseTrack(text: string, options: PoseImportOptions = {}): PoseImportResult {
  const parsed = parsePoseCsv(text, { ...options, requireNose: true });
  const observations: TrackObservation[] = parsed.frames.map((f) => {
    const present = f.body !== null && f.nose !== null;
    return {
      frame: f.frame,
      // A pose file has no area. Keep that absence explicit; the resolver uses
      // coordinate presence rather than a made-up neutral area value.
      areaMeasured: false,
      areaPx: 0,
      darkPixelsPx: 0,
      body: present ? f.body : null,
      nose: present ? f.nose : null,
      tail: f.tail,
      thicknessPx: 0,
      noseArmPx: present ? Math.hypot(f.nose!.x - f.body!.x, f.nose!.y - f.body!.y) : 0,
      tailArmPx: f.tail && f.body ? Math.hypot(f.tail.x - f.body.x, f.tail.y - f.body.y) : 0,
      nearestHole: -1,
      nearestHoleDistPx: Number.POSITIVE_INFINITY,
      radialFraction: Number.NaN,
      candidateCount: present ? 1 : 0,
      reacquired: false,
      // A pose file states which end is which, so the axis is not in doubt.
      // Scaled by what the pose tool itself reported, so a shaky detection does
      // not arrive here looking certain.
      axisConfidence:
        f.tail && f.nose
          ? Math.min(f.noseConf, f.tailConf)
          : present
            ? 0.5 * Math.min(f.noseConf, f.bodyConf)
            : 0,
    };
  });

  return {
    format: parsed.format,
    observations,
    mapping: parsed.mapping,
    frameCount: parsed.frameCount,
    lowConfidenceFrames: parsed.lowConfidenceFrames,
    warnings: [
      'Pose CSV has no visible area measurement. Entry latency remains censored unless an entry is marked from video.',
      ...parsed.warnings,
    ],
  };
}

/** Apply reviewed point corrections without exporting inferred positions as measurements. */
export function reviewedPoseObservations(
  observations: ReadonlyArray<TrackObservation>,
  frames: ReadonlyArray<TrackFrame>,
): TrackObservation[] {
  const reviewed = new Map(frames.map((frame) => [frame.frame, frame]));
  return observations.map((observation) => {
    const frame = reviewed.get(observation.frame);
    const usable = frame && !frame.interpolated && (frame.status === 'tracked' || frame.status === 'partial');
    return {
      ...observation,
      body: usable ? frame.body : null,
      nose: usable ? frame.nose : null,
      tail: usable ? observation.tail : null,
    };
  });
}

/**
 * Write a track as a DeepLabCut-style CSV.
 *
 * The confidence column carries our own per-frame confidence, and frames with no
 * position are written empty rather than as a coordinate of zero, which
 * DeepLabCut also does and which stops a missing frame being read as the animal
 * visiting the top-left corner.
 */
export function exportDeepLabCutCsv(
  observations: ReadonlyArray<TrackObservation>,
  confidenceOf: (o: TrackObservation) => number,
  options: PoseExportOptions = {},
): string {
  return exportDeepLabCutPoseCsv(
    observations.map((o) => ({
      frame: o.frame,
      body: o.body,
      nose: o.nose,
      tail: o.tail,
      confidence: confidenceOf(o),
    })),
    { scorer: options.scorer ?? 'barnes-maze-analyzer' },
  );
}
