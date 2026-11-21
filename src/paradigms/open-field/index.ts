/**
 * Open field: a bare box. Locomotion and anxiety-like behavior read from
 * where the animal goes: how far, how fast, and how much it avoids the
 * center for the walls (thigmotaxis).
 *
 * Built entirely from engine parts (an arena in world cm, `trackInArena`,
 * zone measures), so it is also the template for the next paradigm.
 */

import { metric, type ArenaParadigm } from '../../paradigm';
import type { Arena } from '../../arena/arena';
import { contains, distanceToEdge } from '../../arena/shapes';
import { measureZones, type TrackSummary, type ZoneMeasureOptions } from '../../arena/zoneMeasures';
import {
  arenaTrackOptions,
  timeWhere,
  trackInArena,
  worldSamples,
  type ArenaFrame,
  type ArenaTrack,
  type ArenaTrackConfig,
} from '../../tracking/arenaTrack';

export { runningMedian } from '../../tracking/arenaTrack';

export interface OpenFieldConfig extends ArenaTrackConfig {
  /** Boundary, calibration and zones, e.g. from `openFieldZones` plus a calibration, or `findBoxArena`. */
  readonly arena: Arena;
  /** Distance from the wall that counts as "near the wall", cm. Default 5. */
  readonly wallDistanceCm?: number;
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

function score(track: ArenaTrack, config: OpenFieldConfig): OpenFieldResult {
  const { arena } = config;
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
}

export const openField: ArenaParadigm<OpenFieldConfig, OpenFieldResult> = {
  id: 'open-field',
  name: 'Open field',
  summary: 'Locomotion and anxiety-like behavior: distance, speed, and time in the center versus along the walls.',
  metrics: [
    { id: 'distance_cm', label: 'Distance travelled', unit: 'cm', definition: 'Path length of the smoothed body center over tracked time.' },
    { id: 'mean_speed_cm_s', label: 'Mean speed', unit: 'cm/s', definition: 'Distance travelled over tracked time.' },
    { id: 'center_time_s', label: 'Time in center', unit: 's', definition: 'Time the body center was in the center zone.' },
    { id: 'center_entries', label: 'Center entries', unit: 'count', definition: 'Entries into the center zone; starting there counts as one.' },
    { id: 'center_latency_s', label: 'Latency to center', unit: 's', definition: 'Time from the start of scoring to the first center entry.' },
    { id: 'near_wall_time_s', label: 'Time near walls', unit: 's', definition: 'Time the body center was within the wall distance of the arena edge.' },
    { id: 'near_wall_pct', label: 'Time near walls', unit: '%', definition: 'Time near the walls over tracked time.' },
  ],
  async analyze(source, config, options = {}) {
    return score(await trackInArena(source, config.arena, arenaTrackOptions(config, options)), config);
  },
  score,
  report(result) {
    const s = result.summary;
    const center = s.zones.find((z) => z.zoneId === 'center');
    return {
      paradigmId: 'open-field',
      values: [
        metric('distance_cm', s.distanceCm),
        metric('mean_speed_cm_s', s.meanSpeedCmPerS),
        metric('center_time_s', center?.timeS ?? null),
        metric('center_entries', center?.entries ?? null),
        center && center.latencyS === null
          ? metric('center_latency_s', null, false, 'Never entered the center.')
          : metric('center_latency_s', center?.latencyS ?? null),
        metric('near_wall_time_s', s.timeNearWallS),
        metric('near_wall_pct', 100 * s.nearWallFraction),
      ],
      trackedFraction: s.trackedFraction,
      warnings: result.warnings,
    };
  },
};
