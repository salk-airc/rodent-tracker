/**
 * A paradigm is one behavioral test (Barnes maze, open field, plus maze…).
 *
 * The engine has three parts, and a paradigm is the configuration that joins
 * them for one test:
 *
 * 1. Arena (`arena/`): where the apparatus is and how pixels map to cm, found
 *    automatically (`arena/find/`) or placed by hand.
 * 2. Tracking (`tracking/`, `detect/`): where the animal is each frame, from
 *    the video or imported from another tracker.
 * 3. Scoring: the paradigm's measures, from the arena and the track.
 *
 * Every paradigm also reports its results in one common form (`report`), so
 * an app can show and export any test without knowing its internals.
 */

import type { Arena } from './arena/arena';
import type { ZoneMeasureOptions } from './arena/zoneMeasures';
import type { DetectorFactory } from './detect/types';
import type { ArenaTrack } from './tracking/arenaTrack';
import type { FrameSource } from './types';

export interface ParadigmRunOptions {
  /** Which detector finds the animal. Each paradigm has its own default. */
  readonly detector?: DetectorFactory;
  readonly onProgress?: (stage: string, done: number, total: number) => void;
}

/** How a metric's value reads. `count` and `index` are unitless numbers; `label` is text. */
export type MetricUnit = 's' | 'cm' | 'cm/s' | '%' | 'count' | 'index' | 'label';

export interface MetricDefinition {
  /** Stable id, used as a column name in exports, e.g. `open_arm_time_pct`. */
  readonly id: string;
  readonly label: string;
  readonly unit: MetricUnit;
  /** One sentence on exactly what is measured, for a methods section. */
  readonly definition: string;
}

export interface MetricValue {
  readonly id: string;
  /** The number (or text, for `label` metrics); null when it could not be measured. */
  readonly value: number | string | null;
  /**
   * False when the value is a bound or rests on partial data: a latency cut off
   * by the end of the trial, an error count over frames where hole visits
   * couldn't be seen. `note` says which.
   */
  readonly complete: boolean;
  readonly note?: string;
}

/** A paradigm's results in the common form. */
export interface ParadigmReport {
  readonly paradigmId: string;
  /** One value per metric the paradigm defines, in its order. */
  readonly values: ReadonlyArray<MetricValue>;
  /** Share of scored frames with a position; null when the paradigm doesn't track one. */
  readonly trackedFraction: number | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface Paradigm<Config, Result> {
  /** Stable id, used in project files and URLs, e.g. `barnes-maze`. */
  readonly id: string;
  readonly name: string;
  /** One sentence for a test picker. */
  readonly summary: string;
  /** The headline metrics, in the order a report shows them. */
  readonly metrics: ReadonlyArray<MetricDefinition>;
  /** Track the animal in the video and score it. */
  analyze(source: FrameSource, config: Config, options?: ParadigmRunOptions): Promise<Result>;
  /** The result in the common form. */
  report(result: Result): ParadigmReport;
}

/**
 * A paradigm scored from an arena and a track alone, so a track from anywhere
 * (the video, SLEAP, a tracking camera) can be scored. `analyze` is
 * `trackInArena` followed by `score`.
 */
export interface ArenaParadigm<Config extends { readonly arena: Arena }, Result> extends Paradigm<Config, Result> {
  score(track: ArenaTrack, config: Config): Result;
}

/** A report's values with their definitions, for a results table or an export. */
export function reportRows(paradigm: Pick<Paradigm<unknown, unknown>, 'metrics'>, report: ParadigmReport): Array<MetricDefinition & MetricValue> {
  return paradigm.metrics.map((m) => {
    const v = report.values.find((x) => x.id === m.id);
    return { ...m, ...(v ?? { id: m.id, value: null, complete: false, note: 'Not reported.' }) };
  });
}

/** A number that may be missing, as a metric value. */
export function metric(id: string, value: number | string | null, complete = value !== null, note?: string): MetricValue {
  return note === undefined ? { id, value, complete } : { id, value, complete, note };
}

export interface TimeBin {
  /** Seconds from the start of the track. */
  readonly startS: number;
  readonly endS: number;
  readonly report: ParadigmReport;
}

/**
 * The paradigm's report per time bin (per minute, say), as AnyMaze-style
 * tables give it. Each bin is the same track, already smoothed, cut to the bin
 * and scored by the paradigm itself, so every arena paradigm gets bins.
 *
 * Conventions: a bin includes the frame on each of its edges, so no interval
 * is lost between bins. An entry belongs to the bin it happens in: an animal
 * already in a zone when a bin starts is not counted as entering it again.
 * Latencies are from the start of the bin. Warnings are the bin's own.
 */
export function binReports<Config extends { readonly arena: Arena; readonly zoneOptions?: ZoneMeasureOptions }, Result>(
  paradigm: ArenaParadigm<Config, Result>,
  track: ArenaTrack,
  config: Config,
  binS: number,
): TimeBin[] {
  if (!(binS > 0)) throw new RangeError('binS must be positive');
  const frames = track.frames;
  if (frames.length === 0) return [];
  const t0 = frames[0]!.timeS;
  const total = frames[frames.length - 1]!.timeS - t0;
  const bins: TimeBin[] = [];
  for (let startS = 0; startS < total || (startS === 0 && total === 0); startS += binS) {
    const endS = Math.min(startS + binS, total);
    const slice = frames.filter((f) => f.timeS - t0 >= startS - 1e-9 && f.timeS - t0 <= endS + 1e-9);
    const trackedFraction = slice.length ? slice.filter((f) => f.body !== null).length / slice.length : 0;
    const zoneOptions = startS === 0 ? config.zoneOptions : { ...config.zoneOptions, countStartInside: false };
    const result = paradigm.score(
      { ...track, frames: slice, trackedFraction, warnings: [] },
      { ...config, ...(zoneOptions ? { zoneOptions } : {}) },
    );
    bins.push({ startS, endS, report: paradigm.report(result) });
    if (total === 0) break;
  }
  return bins;
}
