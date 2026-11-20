/**
 * Open field: a bare box. Locomotion and anxiety-like behavior read from
 * where the animal goes: how far, how fast, and how much it avoids the
 * center for the walls (thigmotaxis).
 *
 * Built entirely from engine parts (`trackInArena`, an arena in world cm,
 * zone measures), so it is also the template for the next paradigm.
 */

import type { Paradigm } from '../../paradigm';
import type { TrackingParams } from '../../types';
import type { Arena } from '../../arena/arena';
import { contains, distanceToEdge } from '../../arena/shapes';
import { measureZones, type TrackSummary, type ZoneMeasureOptions } from '../../arena/zoneMeasures';
import { timeWhere, trackInArena, worldSamples, type ArenaFrame } from '../../tracking/arenaTrack';

export { runningMedian } from '../../tracking/arenaTrack';

export interface OpenFieldConfig {
  /** Boundary, calibration and zones, e.g. from `openFieldZones` plus a calibration. */
  readonly arena: Arena;
  readonly params?: TrackingParams;
  /** Distance from the wall that counts as "near the wall", cm. Default 5. */
  readonly wallDistanceCm?: number;
  /** Score only this stretch of the recording, seconds from its start. */
  readonly window?: { readonly startS?: number; readonly durationS?: number };
  /** Running-median window on positions, frames. Default 5; 1 turns it off. */
  readonly smoothFrames?: number;
  readonly zoneOptions?: ZoneMeasureOptions;
}

export interface OpenFieldFrame extends ArenaFrame {
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
    const { arena } = config;
    const track = await trackInArena(source, arena, {
      ...options,
      ...(config.params ? { params: config.params } : {}),
      ...(config.window ? { window: config.window } : {}),
      ...(config.smoothFrames !== undefined ? { smoothFrames: config.smoothFrames } : {}),
    });
    const wallCm = config.wallDistanceCm ?? 5;
    const frames: OpenFieldFrame[] = track.frames.map((f) => ({
      ...f,
      nearWall: f.body !== null && contains(arena.boundary, f.body) && distanceToEdge(arena.boundary, f.body) <= wallCm,
    }));

    const zoneSummary = measureZones(worldSamples(frames), arena.zones, config.zoneOptions);
    const timeNearWallS = timeWhere(frames, (f) => f.nearWall, config.zoneOptions?.maxGapS);
    return {
      frames,
      summary: {
        ...zoneSummary,
        trackedFraction: track.trackedFraction,
        meanSpeedCmPerS: zoneSummary.trackedS > 0 ? zoneSummary.distanceCm / zoneSummary.trackedS : 0,
        timeNearWallS,
        nearWallFraction: zoneSummary.trackedS > 0 ? timeNearWallS / zoneSummary.trackedS : 0,
      },
      detectorId: track.detectorId,
      sizeScale: track.sizeScale,
      warnings: track.warnings,
    };
  },
};
