/**
 * Elevated plus maze: anxiety-like behavior from how much a mouse explores
 * the open arms against the closed ones.
 *
 * An arm entry is the smoothed body center crossing into the arm (past the
 * layout's `entryMarginCm`). Tools that require all four paws in the arm count
 * fewer entries; a margin of a few cm comes close to that.
 *
 * Not measured yet: head dips over the open-arm edges and stretch-attend
 * postures. Both need the head outside the arena mask, which detection ignores.
 */

import type { Paradigm } from '../../paradigm';
import type { TrackingParams } from '../../types';
import type { Arena } from '../../arena/arena';
import { measureZones, type TrackSummary, type ZoneMeasureOptions, type ZoneMeasures } from '../../arena/zoneMeasures';
import { trackInArena, worldSamples, type ArenaFrame } from '../../tracking/arenaTrack';

export interface ElevatedPlusConfig {
  /** From `elevatedPlusMaze()` plus a calibration. Arms are grouped by the `open-` and `closed-` id prefixes. */
  readonly arena: Arena;
  readonly params?: TrackingParams;
  readonly window?: { readonly startS?: number; readonly durationS?: number };
  readonly smoothFrames?: number;
  /** Default `{ minEntryS: 0.2 }`, so a body center wobbling on an arm's line is not ten entries. */
  readonly zoneOptions?: ZoneMeasureOptions;
}

export interface ArmGroup {
  readonly timeS: number;
  readonly entries: number;
  /** Earliest entry into any arm of the group; null when none was entered. */
  readonly latencyS: number | null;
  readonly distanceCm: number;
}

export interface ElevatedPlusSummary extends TrackSummary {
  readonly trackedFraction: number;
  readonly open: ArmGroup;
  readonly closed: ArmGroup;
  readonly centerS: number;
  /** Open-arm time over time in either kind of arm, 0–100; null before any arm time. */
  readonly openTimePct: number | null;
  /** Open-arm entries over all arm entries, 0–100; null before any entry. */
  readonly openEntriesPct: number | null;
  /** Tracked time in no zone: the body center off the maze's outline. */
  readonly offMazeS: number;
}

export interface ElevatedPlusResult {
  readonly frames: ReadonlyArray<ArenaFrame>;
  readonly summary: ElevatedPlusSummary;
  readonly detectorId: string;
  readonly sizeScale: number;
  readonly warnings: ReadonlyArray<string>;
}

export const elevatedPlus: Paradigm<ElevatedPlusConfig, ElevatedPlusResult> = {
  id: 'elevated-plus-maze',
  name: 'Elevated plus maze',
  summary: 'Anxiety-like behavior: time in and entries to the open arms against the closed arms.',
  measures: ['Open-arm time', 'Closed-arm time', 'Center time', 'Open-arm entries', 'Closed-arm entries', '% open-arm time', '% open-arm entries', 'Distance travelled'],
  async analyze(source, config, options = {}) {
    const { arena } = config;
    const open = arena.zones.filter((z) => z.id.startsWith('open-')).map((z) => z.id);
    const closed = arena.zones.filter((z) => z.id.startsWith('closed-')).map((z) => z.id);
    if (open.length === 0 || closed.length === 0) throw new Error('the arena needs zones with ids starting "open-" and "closed-" (see elevatedPlusMaze())');

    const track = await trackInArena(source, arena, {
      ...options,
      ...(config.params ? { params: config.params } : {}),
      ...(config.window ? { window: config.window } : {}),
      ...(config.smoothFrames !== undefined ? { smoothFrames: config.smoothFrames } : {}),
    });
    const zoneOptions = { minEntryS: 0.2, ...config.zoneOptions };
    const s = measureZones(worldSamples(track.frames), arena.zones, zoneOptions);
    const openGroup = group(s.zones, open);
    const closedGroup = group(s.zones, closed);
    const centerS = s.zones.find((z) => z.zoneId === 'center')?.timeS ?? 0;
    const armS = openGroup.timeS + closedGroup.timeS;
    const armEntries = openGroup.entries + closedGroup.entries;
    const offMazeS = Math.max(0, s.trackedS - armS - centerS - otherZoneTime(s.zones, [...open, ...closed, 'center']));

    const warnings = [...track.warnings];
    if (s.trackedS > 0 && offMazeS / s.trackedS > 0.05) {
      warnings.push(`The body center was off the maze outline for ${offMazeS.toFixed(1)} s. Check the calibration.`);
    }
    return {
      frames: track.frames,
      summary: {
        ...s,
        trackedFraction: track.trackedFraction,
        open: openGroup,
        closed: closedGroup,
        centerS,
        openTimePct: armS > 0 ? (100 * openGroup.timeS) / armS : null,
        openEntriesPct: armEntries > 0 ? (100 * openGroup.entries) / armEntries : null,
        offMazeS,
      },
      detectorId: track.detectorId,
      sizeScale: track.sizeScale,
      warnings,
    };
  },
};

function group(zones: ReadonlyArray<ZoneMeasures>, ids: ReadonlyArray<string>): ArmGroup {
  const members = zones.filter((z) => ids.includes(z.zoneId));
  const latencies = members.map((z) => z.latencyS).filter((v): v is number => v !== null);
  return {
    timeS: members.reduce((t, z) => t + z.timeS, 0),
    entries: members.reduce((t, z) => t + z.entries, 0),
    latencyS: latencies.length ? Math.min(...latencies) : null,
    distanceCm: members.reduce((t, z) => t + z.distanceCm, 0),
  };
}

function otherZoneTime(zones: ReadonlyArray<ZoneMeasures>, known: ReadonlyArray<string>): number {
  return zones.filter((z) => !known.includes(z.zoneId)).reduce((t, z) => t + z.timeS, 0);
}
