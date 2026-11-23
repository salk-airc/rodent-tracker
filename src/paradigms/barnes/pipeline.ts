/**
 * Pixel analysis and fast re-analysis from stored observations.
 *
 * The engine's three parts, in order: find the arena (`findBarnesArena`, or a
 * confirmed rig template, or geometry the user fixed), track the animal
 * (`trackVideo`), then score (`reanalyze`: trial start, events, measures).
 * Scoring is kept apart because it reruns on every correction while the
 * pixels are analyzed once.
 */

import type {
  AnalysisParams,
  FrameSource,
  HoleEvent,
  MazeGeometry,
  TrackObservation,
  TrackingSource,
  TrialMeasures,
  TrialStart,
} from './types';
import type { Gray } from '../../image/imageOps';
import { asDarkerAnimal, buildArenaBackground, type AnimalContrast } from '../../image/contrast';
import { applyTemplate, type RigTemplate } from './geometry/detect';
import { findBarnesArena } from './arena';
import { trackVideo } from './tracking/track';
import type { DetectorFactory } from '../../detect/types';
import { sizeScaleFor, type AnimalProfile } from '../../detect/scale';
import { pxPerCm } from './types';
import { detectTrialStart } from './tracking/trialStart';
import {
  resolveTrack,
  type GapReport,
  type ManualCorrection,
  type ResolvedTrack,
} from './tracking/resolve';
import { detectEvents, type TargetSuggestion } from './events';
import { computeMeasures } from './measures/compute';

export interface AnalyzeOptions {
  readonly params: AnalysisParams;
  /** Reuse a confirmed rig from an earlier video in the cohort. */
  readonly template?: RigTemplate;
  /** Skip detection entirely; the user has already fixed the geometry. */
  readonly geometry?: MazeGeometry;
  /** Which detector finds the animal in each frame. Defaults to `dark-blob-v1`. */
  readonly detector?: DetectorFactory;
  /**
   * Rescale detector pixel sizes by the platform's measured px/cm. Off by
   * default for the Barnes maze, whose sizes were tuned on these very clips
   * and whose regression outputs depend on them; turn it on for a rig whose
   * camera images the animal at a different size.
   */
  readonly scaleSizesToCalibration?: boolean;
  /** Whether the animal is darker than the platform (default), lighter (albino on dark platform), or either. */
  readonly animalContrast?: AnimalContrast;
  /** Physical rodent morphology (defaults to adult mouse). */
  readonly animal?: AnimalProfile;
  readonly onProgress?: (stage: AnalysisStage, done: number, total: number) => void;
}

export type AnalysisStage = 'background' | 'geometry' | 'tracking';

/**
 * Everything measured from the pixels, plus the geometry it was measured
 * against. This is what gets stored; it is the reloadable intermediate the
 * facility needs so that re-running analysis does not mean re-tracking.
 */
export interface VideoObservations {
  readonly videoId: string;
  readonly width: number;
  readonly height: number;
  readonly geometry: MazeGeometry;
  readonly trackingSource: TrackingSource;
  readonly observations: ReadonlyArray<TrackObservation>;
  readonly bodyAreaPx: number;
  readonly bodyAreaSpread: number;
  readonly detectedTrialStart: TrialStart;
  readonly backgroundImage: Gray;
  readonly notes: ReadonlyArray<string>;
}

export interface AnalysisOutcome {
  readonly observations: VideoObservations;
  readonly track: ResolvedTrack;
  readonly events: ReadonlyArray<HoleEvent>;
  readonly measures: TrialMeasures;
  readonly targetSuggestion: TargetSuggestion | null;
  readonly gaps: ReadonlyArray<GapReport>;
  readonly warnings: ReadonlyArray<string>;
}

export async function analyzeVideo(
  videoId: string,
  source: FrameSource,
  opts: AnalyzeOptions,
): Promise<VideoObservations> {
  const notes: string[] = [];

  const contrast = opts.animalContrast ?? 'darker';
  const bg = await buildArenaBackground(
    source,
    contrast,
    opts.params.tracking.backgroundSampleFrames,
    (d, t) => opts.onProgress?.('background', d, t),
  );
  notes.push(...bg.warnings);

  opts.onProgress?.('geometry', 0, 1);
  let geometry: MazeGeometry;
  if (opts.geometry) {
    geometry = opts.geometry;
  } else if (opts.template) {
    const match = applyTemplate(bg.image, opts.template);
    geometry = match.geometry;
    notes.push(...match.notes);
    if (match.agrees) {
      notes.push(
        `Applied rig “${opts.template.name}”. The re-detected outline matches.`,
      );
    }
  } else {
    geometry = findBarnesArena(bg.image).geometry;
  }
  notes.push(...geometry.fit.warnings);
  opts.onProgress?.('geometry', 1, 1);

  const seen = asDarkerAnimal(source, bg.image, contrast);
  const tracked = await trackVideo(
    seen.source,
    seen.background,
    geometry,
    opts.params.tracking,
    (d, t) => opts.onProgress?.('tracking', d, t),
    opts.detector,
    opts.scaleSizesToCalibration ? sizeScaleFor(pxPerCm(geometry)) : undefined,
    opts.animal,
  );
  notes.push(...tracked.warnings);

  const detectedTrialStart = detectTrialStart(
    tracked.observations,
    source.timebase,
    opts.params.tracking,
    tracked.bodyAreaPx,
    geometry,
  );

  return {
    videoId,
    width: source.width,
    height: source.height,
    geometry,
    trackingSource: 'video',
    observations: tracked.observations,
    bodyAreaPx: tracked.bodyAreaPx,
    bodyAreaSpread: tracked.bodyAreaSpread,
    detectedTrialStart,
    backgroundImage: bg.image,
    notes,
  };
}

export interface ReanalyzeOptions {
  readonly params: AnalysisParams;
  readonly timebase: import('./types').Timebase;
  /** Override the detected geometry, e.g. after the user picks the target hole. */
  readonly geometry?: MazeGeometry;
  readonly trialStart?: TrialStart;
  readonly corrections?: ReadonlyMap<number, ManualCorrection>;
}

/**
 * Re-derive everything downstream of the pixels.
 *
 * Pure and fast. Called on every parameter change, every manual correction, and
 * every time the target hole is set.
 */
export function reanalyze(obs: VideoObservations, opts: ReanalyzeOptions): AnalysisOutcome {
  const geometry = opts.geometry ?? obs.geometry;
  const detectedTrialStart = detectTrialStart(
    obs.observations,
    opts.timebase,
    opts.params.tracking,
    obs.bodyAreaPx,
    geometry,
  );
  const trialStart = opts.trialStart ?? detectedTrialStart;

  const track = resolveTrack({
    observations: obs.observations,
    timebase: opts.timebase,
    geometry,
    params: opts.params,
    bodyAreaPx: obs.bodyAreaPx,
    trialStart,
    positionProvenance: obs.trackingSource !== 'video' ? 'imported' : 'auto',
    ...(opts.corrections ? { corrections: opts.corrections } : {}),
  });

  const detected = detectEvents({
    frames: track.frames,
    geometry,
    params: opts.params,
    timebase: opts.timebase,
    bodyAreaPx: obs.bodyAreaPx,
    trialStartFrame: trialStart.frame,
  });

  const measures = computeMeasures({
    videoId: obs.videoId,
    frames: track.frames,
    events: detected.events,
    geometry,
    params: opts.params,
    timebase: opts.timebase,
    trialStartFrame: trialStart.frame,
    quality: track.quality,
  });

  return {
    observations: { ...obs, geometry, observations: track.registeredObservations, detectedTrialStart },
    track,
    events: detected.events,
    measures,
    targetSuggestion: detected.targetSuggestion,
    gaps: track.gaps,
    warnings: [...obs.notes, ...detected.warnings, ...track.quality.warnings, ...measures.warnings],
  };
}
