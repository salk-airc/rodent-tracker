/**
 * Open field: a bare box. Locomotion and anxiety-like behavior read from
 * where the animal goes: how far, how fast, and how much it avoids the
 * center for the walls (thigmotaxis).
 *
 * Built entirely from engine parts (background, a detector, an arena in world
 * cm, zone measures), so it is also the template for the next paradigm.
 */

import type { Paradigm } from '../../paradigm';
import type { Point, TrackingParams } from '../../types';
import { frameTime } from '../../types';
import { arenaMask, arenaPxPerCm, zonesAt, type Arena } from '../../arena/arena';
import { toWorld } from '../../arena/calibration';
import { contains, distanceToEdge } from '../../arena/shapes';
import { measureZones, type TrackSummary, type WorldSample, type ZoneMeasureOptions } from '../../arena/zoneMeasures';
import { buildBackground } from '../../image/background';
import { DEFAULT_TRACKING } from '../../detect/defaults';
import { sizeScaleFor } from '../../detect/scale';
import { detectFrames } from '../../tracking/detectFrames';

export interface OpenFieldConfig {
  /** Boundary, calibration and zones, e.g. from `openFieldZones` plus a calibration. */
  readonly arena: Arena;
  readonly params?: TrackingParams;
  /** Distance from the wall that counts as "near the wall", cm. Default 5. */
  readonly wallDistanceCm?: number;
  /** Score only this stretch of the recording, seconds from its start. */
  readonly window?: { readonly startS?: number; readonly durationS?: number };
  /**
   * Frames in the centered running median applied to positions before
   * distances are summed. Frame-to-frame jitter of a pixel or two otherwise
   * adds up to meters over a session. Default 5; 1 turns it off.
   */
  readonly smoothFrames?: number;
  readonly zoneOptions?: ZoneMeasureOptions;
}

export interface OpenFieldFrame {
  readonly frame: number;
  readonly timeS: number;
  /** Body center in image px as detected, before smoothing. */
  readonly bodyPx: Point | null;
  readonly nosePx: Point | null;
  /** Smoothed body center in world cm; what every measure uses. */
  readonly body: Point | null;
  readonly zones: ReadonlyArray<string>;
  readonly nearWall: boolean;
}

export interface OpenFieldSummary extends TrackSummary {
  /** Share of scored frames with a detected animal. */
  readonly trackedFraction: number;
  readonly meanSpeedCmPerS: number;
  readonly timeNearWallS: number;
  /** Time near the wall over tracked time. */
  readonly nearWallFraction: number;
}

export interface OpenFieldResult {
  readonly frames: ReadonlyArray<OpenFieldFrame>;
  readonly summary: OpenFieldSummary;
  readonly detectorId: string;
  /** How detector pixel sizes were scaled for this camera (1 = as tuned). */
  readonly sizeScale: number;
  readonly warnings: ReadonlyArray<string>;
}

export const openField: Paradigm<OpenFieldConfig, OpenFieldResult> = {
  id: 'open-field',
  name: 'Open field',
  summary: 'Locomotion and anxiety-like behavior: distance, speed, and time in the center versus along the walls.',
  measures: ['Distance travelled', 'Mean speed', 'Time in center', 'Center entries', 'Latency to center', 'Time near walls'],
  async analyze(source, config, options = {}) {
    const params = config.params ?? DEFAULT_TRACKING;
    const { arena } = config;
    const warnings: string[] = [];

    const bg = await buildBackground(source, params.backgroundSampleFrames, 0.8, (d, t) => options.onProgress?.('background', d, t));
    warnings.push(...bg.warnings);
    const sizeScale = sizeScaleFor(arenaPxPerCm(arena));
    const detected = await detectFrames(source, bg.image, arenaMask(arena, source.width, source.height), params, {
      sizeScale,
      ...(options.detector ? { detector: options.detector } : {}),
      onProgress: (d, t) => options.onProgress?.('tracking', d, t),
    });

    const start = config.window?.startS ?? 0;
    const end = config.window?.durationS === undefined ? Number.POSITIVE_INFINITY : start + config.window.durationS;
    const raw: Array<{ frame: number; timeS: number; bodyPx: Point | null; nosePx: Point | null }> = [];
    detected.frames.forEach((f, frame) => {
      const timeS = frameTime(source.timebase, frame);
      if (timeS < start || timeS > end) return;
      raw.push({ frame, timeS, bodyPx: f.detection?.body ?? null, nosePx: f.detection?.nose ?? null });
    });

    const world = raw.map((r) => (r.bodyPx ? toWorld(arena.calibration, r.bodyPx) : null));
    const smooth = runningMedian(world, config.smoothFrames ?? 5);
    const wallCm = config.wallDistanceCm ?? 5;
    const frames: OpenFieldFrame[] = raw.map((r, i) => {
      const body = smooth[i]!;
      return {
        ...r,
        body,
        zones: body ? zonesAt(arena, body) : [],
        nearWall: body !== null && contains(arena.boundary, body) && distanceToEdge(arena.boundary, body) <= wallCm,
      };
    });

    const samples: WorldSample[] = frames.map((f) => ({ timeS: f.timeS, point: f.body }));
    const zoneSummary = measureZones(samples, arena.zones, config.zoneOptions);
    const maxGapS = config.zoneOptions?.maxGapS ?? 0.5;
    let timeNearWallS = 0;
    for (let i = 0; i + 1 < frames.length; i++) {
      const dt = frames[i + 1]!.timeS - frames[i]!.timeS;
      if (frames[i]!.nearWall && dt <= maxGapS) timeNearWallS += dt;
    }
    const trackedFrames = frames.filter((f) => f.body !== null).length;
    const trackedFraction = frames.length ? trackedFrames / frames.length : 0;
    if (trackedFraction < 0.9) {
      warnings.push(`The animal was found in ${(trackedFraction * 100).toFixed(0)}% of frames. Check the arena outline and lighting.`);
    }
    if (detected.bodyAreaSpread > 0.8) {
      warnings.push(`Animal-area spread is high (${detected.bodyAreaSpread.toFixed(2)}). Check for false detections.`);
    }

    return {
      frames,
      summary: {
        ...zoneSummary,
        trackedFraction,
        meanSpeedCmPerS: zoneSummary.trackedS > 0 ? zoneSummary.distanceCm / zoneSummary.trackedS : 0,
        timeNearWallS,
        nearWallFraction: zoneSummary.trackedS > 0 ? timeNearWallS / zoneSummary.trackedS : 0,
      },
      detectorId: detected.detectorId,
      sizeScale,
      warnings,
    };
  },
};

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
