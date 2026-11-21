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

import { metric, type ArenaParadigm } from '../../paradigm';
import type { Arena } from '../../arena/arena';
import { measureZones, zoneVisits, type TrackSummary, type ZoneMeasureOptions, type ZoneVisit } from '../../arena/zoneMeasures';
import {
  arenaTrackOptions,
  trackInArena,
  worldSamples,
  type ArenaFrame,
  type ArenaTrack,
  type ArenaTrackConfig,
} from '../../tracking/arenaTrack';

/** Below this many arm entries, alternation % is too noisy to trust. */
const MIN_RELIABLE_ENTRIES = 10;

export interface YMazeConfig extends ArenaTrackConfig {
  /** From `yMaze()` plus a calibration. Every zone other than `center` is an arm. */
  readonly arena: Arena;
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

/** The three arm zones; throws unless there are exactly three besides `center`. */
function armZones(arena: Arena): Arena['zones'] {
  const arms = arena.zones.filter((z) => z.id !== 'center');
  if (arms.length !== 3) throw new Error(`a Y-maze needs 3 arm zones besides "center"; this arena has ${arms.length}`);
  return arms;
}

function score(track: ArenaTrack, config: YMazeConfig): YMazeResult {
  const { arena } = config;
  const arms = armZones(arena);

  const zoneOptions = { minEntryS: 0.2, ...config.zoneOptions };
  const samples = worldSamples(track.frames);
  const s = measureZones(samples, arena.zones, zoneOptions);
  const visits = zoneVisits(samples, arms, zoneOptions);
  const sequence = visits.map((v) => v.zoneId);
  const alt = alternation(sequence);

  const warnings = [...track.warnings];
  if (sequence.length < MIN_RELIABLE_ENTRIES) warnings.push(`Only ${sequence.length} arm entries; alternation is unreliable below about ${MIN_RELIABLE_ENTRIES}.`);
  return {
    frames: track.frames,
    visits,
    summary: { ...s, trackedFraction: track.trackedFraction, sequence, armEntries: sequence.length, ...alt },
    detectorId: track.detectorId,
    sizeScale: track.sizeScale,
    warnings,
  };
}

export const yMazeAlternation: ArenaParadigm<YMazeConfig, YMazeResult> = {
  id: 'y-maze',
  name: 'Y-maze spontaneous alternation',
  summary: 'Spatial working memory: the share of consecutive arm-entry triplets that visit all three arms.',
  metrics: [
    { id: 'alternation_pct', label: 'Spontaneous alternation', unit: '%', definition: 'Runs of three consecutive entries into three different arms, over arm entries minus 2.' },
    { id: 'arm_entries', label: 'Arm entries', unit: 'count', definition: 'Entries into any arm, each needing the minimum presence (0.2 s by default).' },
    { id: 'alternations', label: 'Alternations', unit: 'count', definition: 'Runs of three consecutive entries into three different arms.' },
    { id: 'same_arm_returns', label: 'Same-arm returns', unit: 'count', definition: 'Entries straight back into the arm just left.' },
    { id: 'distance_cm', label: 'Distance travelled', unit: 'cm', definition: 'Path length of the smoothed body center over tracked time.' },
    { id: 'arm_sequence', label: 'Arm sequence', unit: 'label', definition: 'Arm entries in order.' },
  ],
  async analyze(source, config, options = {}) {
    armZones(config.arena);
    return score(await trackInArena(source, config.arena, arenaTrackOptions(config, options)), config);
  },
  score,
  report(result) {
    const s = result.summary;
    const few = s.armEntries < MIN_RELIABLE_ENTRIES;
    return {
      paradigmId: 'y-maze',
      values: [
        s.alternationPct === null
          ? metric('alternation_pct', null, false, 'Fewer than 3 arm entries.')
          : metric('alternation_pct', s.alternationPct, !few, few ? `Only ${s.armEntries} arm entries.` : undefined),
        metric('arm_entries', s.armEntries),
        metric('alternations', s.alternations),
        metric('same_arm_returns', s.sameArmReturns),
        metric('distance_cm', s.distanceCm),
        metric('arm_sequence', s.sequence.join(' ')),
      ],
      trackedFraction: s.trackedFraction,
      warnings: result.warnings,
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
