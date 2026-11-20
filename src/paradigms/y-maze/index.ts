/**
 * Y-maze spontaneous alternation: spatial working memory from the order in
 * which a mouse visits the three arms. A healthy mouse tends to enter the arm
 * it visited least recently, so most runs of three entries cover all three arms.
 *
 * Alternation % = alternations / (arm entries − 2) × 100, where an alternation
 * is three consecutive entries into three different arms (ABC, BCA, …).
 * Re-entering the same arm counts as an entry and breaks the triplets it is in.
 * Chance is 50% for a mouse that never turns straight back into the arm it
 * just left: after two different arms there are two choices, one of which
 * completes the triplet. Same-arm returns are reported so they can be checked.
 */

import type { Paradigm } from '../../paradigm';
import type { TrackingParams } from '../../types';
import type { Arena } from '../../arena/arena';
import { measureZones, zoneVisits, type TrackSummary, type ZoneMeasureOptions, type ZoneVisit } from '../../arena/zoneMeasures';
import { trackInArena, worldSamples, type ArenaFrame } from '../../tracking/arenaTrack';

export interface YMazeConfig {
  /** From `yMaze()` plus a calibration. Every zone other than `center` is an arm. */
  readonly arena: Arena;
  readonly params?: TrackingParams;
  readonly window?: { readonly startS?: number; readonly durationS?: number };
  readonly smoothFrames?: number;
  /** Default `{ minEntryS: 0.2 }`. */
  readonly zoneOptions?: ZoneMeasureOptions;
}

export interface YMazeSummary extends TrackSummary {
  readonly trackedFraction: number;
  /** Arm entries in order, e.g. `ABCABACB`. Arm ids are joined as-is. */
  readonly sequence: ReadonlyArray<string>;
  readonly armEntries: number;
  readonly alternations: number;
  /** Alternations over (entries − 2), 0–100; null with fewer than 3 entries. */
  readonly alternationPct: number | null;
  /** Entries straight back into the arm just left. */
  readonly sameArmReturns: number;
}

export interface YMazeResult {
  readonly frames: ReadonlyArray<ArenaFrame>;
  readonly visits: ReadonlyArray<ZoneVisit>;
  readonly summary: YMazeSummary;
  readonly detectorId: string;
  readonly sizeScale: number;
  readonly warnings: ReadonlyArray<string>;
}

export const yMazeAlternation: Paradigm<YMazeConfig, YMazeResult> = {
  id: 'y-maze',
  name: 'Y-maze spontaneous alternation',
  summary: 'Spatial working memory: the share of consecutive arm-entry triplets that visit all three arms.',
  measures: ['Arm entries', 'Alternations', '% alternation', 'Same-arm returns', 'Time per arm', 'Distance travelled'],
  async analyze(source, config, options = {}) {
    const { arena } = config;
    const arms = arena.zones.filter((z) => z.id !== 'center');
    if (arms.length !== 3) throw new Error(`a Y-maze needs 3 arm zones besides "center"; this arena has ${arms.length}`);

    const track = await trackInArena(source, arena, {
      ...options,
      ...(config.params ? { params: config.params } : {}),
      ...(config.window ? { window: config.window } : {}),
      ...(config.smoothFrames !== undefined ? { smoothFrames: config.smoothFrames } : {}),
    });
    const zoneOptions = { minEntryS: 0.2, ...config.zoneOptions };
    const samples = worldSamples(track.frames);
    const s = measureZones(samples, arena.zones, zoneOptions);
    const visits = zoneVisits(samples, arms, zoneOptions);
    const sequence = visits.map((v) => v.zoneId);
    const alt = alternation(sequence);

    const warnings = [...track.warnings];
    if (sequence.length < 10) warnings.push(`Only ${sequence.length} arm entries; alternation is unreliable below about 10.`);
    return {
      frames: track.frames,
      visits,
      summary: { ...s, trackedFraction: track.trackedFraction, sequence, armEntries: sequence.length, ...alt },
      detectorId: track.detectorId,
      sizeScale: track.sizeScale,
      warnings,
    };
  },
};

/** Alternation counts for a sequence of arm entries. */
export function alternation(sequence: ReadonlyArray<string>): Pick<YMazeSummary, 'alternations' | 'alternationPct' | 'sameArmReturns'> {
  let alternations = 0;
  let sameArmReturns = 0;
  for (let i = 1; i < sequence.length; i++) if (sequence[i] === sequence[i - 1]) sameArmReturns++;
  for (let i = 2; i < sequence.length; i++) {
    if (new Set([sequence[i - 2], sequence[i - 1], sequence[i]]).size === 3) alternations++;
  }
  return { alternations, alternationPct: sequence.length >= 3 ? (100 * alternations) / (sequence.length - 2) : null, sameArmReturns };
}
