/**
 * The track every zone-based paradigm starts from: build the empty-arena
 * background, detect the animal inside the arena boundary, map its body to
 * world cm and smooth it. Paradigms then score `frames` their own way.
 */

import type { ParadigmRunOptions } from '../paradigm';
import type { FrameSource, Point, TrackingParams } from '../types';
import { frameTime } from '../types';
import { arenaMask, arenaPxPerCm, zonesAt, type Arena } from '../arena/arena';
import { toWorld } from '../arena/calibration';
import type { WorldSample } from '../arena/zoneMeasures';
import { buildBackground } from '../image/background';
import { DEFAULT_TRACKING } from '../detect/defaults';
import { sizeScaleFor } from '../detect/scale';
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
}

export interface ArenaFrame {
  readonly frame: number;
  readonly timeS: number;
  /** Body center in image px as detected, before smoothing. */
  readonly bodyPx: Point | null;
  readonly nosePx: Point | null;
  /** Smoothed body center in world cm; what every measure uses. */
  readonly body: Point | null;
  /** Ids of the arena zones the smoothed body is in. */
  readonly zones: ReadonlyArray<string>;
}

export interface ArenaTrack {
  readonly frames: ReadonlyArray<ArenaFrame>;
  readonly detectorId: string;
  /** How detector pixel sizes were scaled for this camera (1 = as tuned). */
  readonly sizeScale: number;
  /** Share of kept frames with a detected animal. */
  readonly trackedFraction: number;
  readonly warnings: ReadonlyArray<string>;
}

export async function trackInArena(source: FrameSource, arena: Arena, options: ArenaTrackOptions = {}): Promise<ArenaTrack> {
  const params = options.params ?? DEFAULT_TRACKING;
  const warnings: string[] = [];

  const bg = await buildBackground(source, params.backgroundSampleFrames, 0.8, (d, t) => options.onProgress?.('background', d, t));
  warnings.push(...bg.warnings);
  const sizeScale = sizeScaleFor(arenaPxPerCm(arena));
  const detected = await detectFrames(source, bg.image, arenaMask(arena, source.width, source.height), params, {
    sizeScale,
    ...(options.detector ? { detector: options.detector } : {}),
    onProgress: (d, t) => options.onProgress?.('tracking', d, t),
  });

  const start = options.window?.startS ?? 0;
  const end = options.window?.durationS === undefined ? Number.POSITIVE_INFINITY : start + options.window.durationS;
  const raw: Array<{ frame: number; timeS: number; bodyPx: Point | null; nosePx: Point | null }> = [];
  detected.frames.forEach((f, frame) => {
    const timeS = frameTime(source.timebase, frame);
    if (timeS < start || timeS > end) return;
    raw.push({ frame, timeS, bodyPx: f.detection?.body ?? null, nosePx: f.detection?.nose ?? null });
  });

  const smooth = runningMedian(
    raw.map((r) => (r.bodyPx ? toWorld(arena.calibration, r.bodyPx) : null)),
    options.smoothFrames ?? 5,
  );
  const frames: ArenaFrame[] = raw.map((r, i) => {
    const body = smooth[i]!;
    return { ...r, body, zones: body ? zonesAt(arena, body) : [] };
  });

  const trackedFraction = frames.length ? frames.filter((f) => f.body !== null).length / frames.length : 0;
  if (trackedFraction < 0.9) {
    warnings.push(`The animal was found in ${(trackedFraction * 100).toFixed(0)}% of frames. Check the arena outline and lighting.`);
  }
  if (detected.bodyAreaSpread > 0.8) {
    warnings.push(`Animal-area spread is high (${detected.bodyAreaSpread.toFixed(2)}). Check for false detections.`);
  }
  return { frames, detectorId: detected.detectorId, sizeScale, trackedFraction, warnings };
}

export function worldSamples(frames: ReadonlyArray<ArenaFrame>): WorldSample[] {
  return frames.map((f) => ({ timeS: f.timeS, point: f.body }));
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
