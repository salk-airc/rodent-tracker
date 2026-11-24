/**
 * The track every zone-based paradigm scores: the animal's position each
 * frame, in world cm, with the zones it is in.
 *
 * Two ways in, one way out:
 * - `trackInArena` finds the animal in the video: build the empty-arena
 *   background, then detect it inside the arena boundary.
 * - `trackFromPositions` takes positions from elsewhere: SLEAP or DeepLabCut,
 *   or a camera that tracks on board.
 * Both then keep the requested time window, map to world cm, smooth, and look
 * up zones the same way, so a paradigm's `score` can't tell them apart.
 */

import type { ParadigmRunOptions } from '../paradigm';
import type { FrameSource, MeasurementProvenance, Point, TrackingParams } from '../types';
import { frameTime } from '../types';
import { arenaMask, arenaPxPerCm, zonesAt, type Arena } from '../arena/arena';
import { pxPerCmAt, toImage, toWorld } from '../arena/calibration';
import type { WorldSample } from '../arena/zoneMeasures';
import { asDarkerAnimal, buildArenaBackground, type AnimalContrast } from '../image/contrast';
import { DEFAULT_TRACKING } from '../detect/defaults';
import { sizeScaleFor, type AnimalProfile } from '../detect/scale';
import { detectFrames } from './detectFrames';

export interface ArenaTrackOptions extends ParadigmRunOptions {
  readonly params?: TrackingParams;
  /** Keep only this stretch of the recording, seconds from its start. */
  readonly window?: { readonly startS?: number; readonly durationS?: number };
  /**
   * Frames in the centered running median applied to world positions.
   * Frame-to-frame jitter of a pixel or two otherwise adds up to meters over a
   * session, and flickers across zone lines. Default 5; 1 turns it off.
   */
  readonly smoothFrames?: number;
  /** Whether the animal is darker than the floor (default), lighter (an albino mouse on a dark floor), or either. */
  readonly animalContrast?: AnimalContrast;
  /** Physical rodent morphology (defaults to adult mouse). Pass e.g. `RAT_PROFILE` for rats. */
  readonly animal?: AnimalProfile;
}

export type ArenaFrameStatus = 'tracked' | 'lost';

export interface ArenaFrame {
  readonly frame: number;
  readonly timeS: number;
  readonly status: ArenaFrameStatus;
  /** Body center in image px as detected, before smoothing. */
  readonly bodyPx: Point | null;
  readonly nosePx: Point | null;
  readonly tailPx: Point | null;
  /** Smoothed body center in world cm; what body-based measures use. */
  readonly body: Point | null;
  /** Smoothed nose position in world cm; what nose-based measures use (object sniffing, head dips). */
  readonly nose: Point | null;
  /** Smoothed tail position in world cm, when available. */
  readonly tail: Point | null;
  /** Body-to-nose heading in world coordinates (radians, −π..π), or null when unavailable. */
  readonly headingRad: number | null;
  /** Visible foreground area in world cm², or null when not measured (e.g., imported pose). */
  readonly areaCm2: number | null;
  /**
   * 0..1. From video: how clearly the detector told the nose from the tail
   * (`axisConfidence`), not whether the animal was found; that is `status`.
   * Imported: the pose tool's likelihood for the points used.
   */
  readonly confidence: number;
  /** Origin of this frame's position (`auto`, `imported`, or `manual`). */
  readonly provenance: MeasurementProvenance;
  /** Optional explanation from the detector for review UIs. */
  readonly reason?: string;
  /** Ids of the arena zones the smoothed body is in. */
  readonly zones: ReadonlyArray<string>;
  /** Ids of the arena zones the smoothed nose is in. */
  readonly noseZones: ReadonlyArray<string>;
}

export interface ArenaTrack {
  readonly frames: ReadonlyArray<ArenaFrame>;
  /** Found in the video by a detector, or taken from another tracker. */
  readonly source: 'video' | 'imported';
  /** The detector's id, or the imported tracker's name. */
  readonly detectorId: string;
  /** How detector pixel sizes were scaled for this camera (1 = as tuned). */
  readonly sizeScale: number;
  /** Share of kept frames with a position. */
  readonly trackedFraction: number;
  readonly warnings: ReadonlyArray<string>;
}

export async function trackInArena(source: FrameSource, arena: Arena, options: ArenaTrackOptions = {}): Promise<ArenaTrack> {
  const params = options.params ?? DEFAULT_TRACKING;
  const warnings: string[] = [];

  const contrast = options.animalContrast ?? 'darker';
  const bg = await buildArenaBackground(source, contrast, params.backgroundSampleFrames, (d, t) => options.onProgress?.('background', d, t));
  warnings.push(...bg.warnings);
  const sizeScale = sizeScaleFor(arenaPxPerCm(arena));
  const seen = asDarkerAnimal(source, bg.image, contrast);
  const detected = await detectFrames(seen.source, seen.background, arenaMask(arena, source.width, source.height), params, {
    sizeScale,
    ...(options.animal ? { animal: options.animal } : {}),
    ...(options.detector ? { detector: options.detector } : {}),
    onProgress: (d, t) => options.onProgress?.('tracking', d, t),
  });

  const raw: RawPosition[] = detected.frames.map((f, frame) => {
    const det = f.detection;
    const localScale = det ? pxPerCmAt(arena.calibration, det.body) : 0;
    return {
      frame,
      timeS: frameTime(source.timebase, frame),
      bodyPx: det?.body ?? null,
      nosePx: det?.nose ?? null,
      tailPx: det?.tail ?? null,
      areaCm2: det && localScale > 0 ? det.areaPx / (localScale * localScale) : null,
      confidence: det ? Math.max(0, Math.min(1, det.axisConfidence)) : 0,
      provenance: 'auto',
      ...(det?.reason ? { reason: det.reason } : {}),
    };
  });
  const placed = place(raw, arena, options);
  warnings.push(...placed.warnings);
  if (detected.bodyAreaSpread > 0.8) {
    warnings.push(`Animal-area spread is high (${detected.bodyAreaSpread.toFixed(2)}). Check for false detections.`);
  }
  return { frames: placed.frames, source: 'video', detectorId: detected.detectorId, sizeScale, trackedFraction: placed.trackedFraction, warnings };
}

/** One position from another tracker. */
export interface PositionSample {
  readonly frame: number;
  readonly timeS: number;
  /** Body center, or null when the tracker lost the animal. */
  readonly body: Point | null;
  readonly nose?: Point | null;
  readonly tail?: Point | null;
  /** Tracker confidence for this frame, 0..1. */
  readonly confidence?: number;
  readonly provenance?: MeasurementProvenance;
}

export interface PositionTrackOptions {
  /** Whether positions are image px (SLEAP, DeepLabCut) or already world cm. Default `image`. */
  readonly space?: 'image' | 'world';
  /** Names the tracker in results, e.g. `sleap`. Default `imported`. */
  readonly sourceId?: string;
  readonly window?: ArenaTrackOptions['window'];
  readonly smoothFrames?: number;
}

/** A track from positions found by another tracker, ready for a paradigm's `score`. */
export function trackFromPositions(samples: ReadonlyArray<PositionSample>, arena: Arena, options: PositionTrackOptions = {}): ArenaTrack {
  const px = (p: Point | null | undefined): Point | null => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return options.space === 'world' ? toImage(arena.calibration, p) : p;
  };
  const raw: RawPosition[] = samples.map((s) => {
    const bodyPx = px(s.body);
    return {
      frame: s.frame,
      timeS: s.timeS,
      bodyPx,
      nosePx: px(s.nose),
      tailPx: px(s.tail),
      areaCm2: null,
      confidence: s.confidence !== undefined ? Math.max(0, Math.min(1, s.confidence)) : bodyPx ? 1 : 0,
      provenance: s.provenance ?? 'imported',
    };
  });
  const placed = place(raw, arena, options);
  return {
    frames: placed.frames,
    source: 'imported',
    detectorId: options.sourceId ?? 'imported',
    sizeScale: 1,
    trackedFraction: placed.trackedFraction,
    warnings: placed.warnings,
  };
}

interface RawPosition {
  readonly frame: number;
  readonly timeS: number;
  readonly bodyPx: Point | null;
  readonly nosePx: Point | null;
  readonly tailPx: Point | null;
  readonly areaCm2: number | null;
  readonly confidence: number;
  readonly provenance: MeasurementProvenance;
  readonly reason?: string;
}

/** The shared second half: keep the window, map to world cm, smooth, look up zones. */
function place(
  all: ReadonlyArray<RawPosition>,
  arena: Arena,
  options: Pick<ArenaTrackOptions, 'window' | 'smoothFrames'>,
): { frames: ArenaFrame[]; trackedFraction: number; warnings: string[] } {
  const start = options.window?.startS ?? 0;
  const end = options.window?.durationS === undefined ? Number.POSITIVE_INFINITY : start + options.window.durationS;
  const raw = all.filter((r) => r.timeS >= start && r.timeS <= end);
  const smoothWindow = options.smoothFrames ?? 5;

  const smoothBody = runningMedian(
    raw.map((r) => (r.bodyPx ? toWorld(arena.calibration, r.bodyPx) : null)),
    smoothWindow,
  );
  const smoothNose = runningMedian(
    raw.map((r) => (r.nosePx ? toWorld(arena.calibration, r.nosePx) : null)),
    smoothWindow,
  );
  const smoothTail = runningMedian(
    raw.map((r) => (r.tailPx ? toWorld(arena.calibration, r.tailPx) : null)),
    smoothWindow,
  );
  const frames: ArenaFrame[] = raw.map((r, i) => {
    const body = smoothBody[i]!;
    const nose = smoothNose[i]!;
    const tail = smoothTail[i]!;
    const headingRad =
      body && nose && Math.hypot(nose.x - body.x, nose.y - body.y) > 1e-6
        ? Math.atan2(nose.y - body.y, nose.x - body.x)
        : null;
    return {
      frame: r.frame,
      timeS: r.timeS,
      status: body ? 'tracked' : 'lost',
      bodyPx: r.bodyPx,
      nosePx: r.nosePx,
      tailPx: r.tailPx,
      body,
      nose,
      tail,
      headingRad,
      areaCm2: r.areaCm2,
      confidence: r.confidence,
      provenance: r.provenance,
      ...(r.reason ? { reason: r.reason } : {}),
      zones: body ? zonesAt(arena, body) : [],
      noseZones: nose ? zonesAt(arena, nose) : [],
    };
  });

  const warnings: string[] = [];
  const trackedFraction = frames.length ? frames.filter((f) => f.body !== null).length / frames.length : 0;
  if (trackedFraction < 0.9) {
    warnings.push(`The animal was found in ${(trackedFraction * 100).toFixed(0)}% of frames. Check the arena outline and lighting.`);
  }
  return { frames, trackedFraction, warnings };
}

export function worldSamples(frames: ReadonlyArray<ArenaFrame>, point: 'body' | 'nose' = 'body'): WorldSample[] {
  return frames.map((f) => ({ timeS: f.timeS, point: point === 'nose' ? f.nose : f.body }));
}

/**
 * Time spent in frames matching `where`, with the zone-measure convention:
 * each interval goes to its earlier frame, and gaps over `maxGapS` count for nothing.
 */
export function timeWhere<F extends ArenaFrame>(frames: ReadonlyArray<F>, where: (f: F) => boolean, maxGapS = 0.5): number {
  let total = 0;
  for (let i = 0; i + 1 < frames.length; i++) {
    const dt = frames[i + 1]!.timeS - frames[i]!.timeS;
    if (dt <= maxGapS && where(frames[i]!)) total += dt;
  }
  return total;
}

/** Centered running median of x and y separately, over positions that exist. Gaps stay gaps. */
export function runningMedian(points: ReadonlyArray<Point | null>, window: number): Array<Point | null> {
  if (window <= 1) return [...points];
  const half = Math.floor(window / 2);
  const mid = (v: number[]) => {
    v.sort((a, b) => a - b);
    const n = v.length;
    return n % 2 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
  };
  return points.map((p, i) => {
    if (!p) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
      const q = points[j];
      if (q) {
        xs.push(q.x);
        ys.push(q.y);
      }
    }
    return { x: mid(xs), y: mid(ys) };
  });
}

/** The settings every arena paradigm's config shares with `trackInArena`. */
export interface ArenaTrackConfig {
  readonly params?: TrackingParams;
  readonly window?: ArenaTrackOptions['window'];
  readonly smoothFrames?: number;
  readonly animalContrast?: AnimalContrast;
  readonly animal?: AnimalProfile;
}

/** `trackInArena` options from a paradigm's config and run options. */
export function arenaTrackOptions(config: ArenaTrackConfig, options: ParadigmRunOptions = {}): ArenaTrackOptions {
  return {
    ...options,
    ...(config.params ? { params: config.params } : {}),
    ...(config.window ? { window: config.window } : {}),
    ...(config.smoothFrames !== undefined ? { smoothFrames: config.smoothFrames } : {}),
    ...(config.animalContrast ? { animalContrast: config.animalContrast } : {}),
    ...(config.animal ? { animal: config.animal } : {}),
  };
}
