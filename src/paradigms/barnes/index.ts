/**
 * The Barnes maze paradigm: a round platform with holes around the rim, one
 * of which hides an escape box. Simon's analysis, unchanged, behind the
 * engine's `Paradigm` interface.
 *
 * The full API (project files, review, exports, raters) is in this folder;
 * this file is the entry point an app starts from.
 */

import { metric, type MetricValue, type Paradigm } from '../../paradigm';
import { analyzeVideo, reanalyze, type AnalysisOutcome, type AnalyzeOptions } from './pipeline';
import type { Latency } from './types';

export { barnesArena, findBarnesArena, type BarnesArenaOptions } from './arena';

export type BarnesConfig = Omit<AnalyzeOptions, 'detector' | 'onProgress'> & {
  /** Names the recording in its outputs. Defaults to `recording`. */
  readonly videoId?: string;
};

export const barnesMaze: Paradigm<BarnesConfig, AnalysisOutcome> = {
  id: 'barnes-maze',
  name: 'Barnes maze',
  summary: 'Spatial learning: how quickly and directly the animal finds the escape hole.',
  metrics: [
    { id: 'primary_latency_s', label: 'Latency to the target', unit: 's', definition: 'Time from trial start until the nose first reached the target hole.' },
    { id: 'total_latency_s', label: 'Latency to enter', unit: 's', definition: 'Time from trial start until the animal first entered the target hole.' },
    { id: 'primary_errors', label: 'Errors before the target', unit: 'count', definition: 'Investigations of other holes before the first target visit.' },
    { id: 'total_errors', label: 'Total errors', unit: 'count', definition: 'Investigations of non-target holes over the whole trial.' },
    { id: 'path_length_cm', label: 'Path length', unit: 'cm', definition: 'Distance travelled by the body center during the trial, over measured positions.' },
    { id: 'mean_speed_cm_s', label: 'Mean speed', unit: 'cm/s', definition: 'Path length over the time it was measured across.' },
    { id: 'target_quadrant_pct', label: 'Time in target quadrant', unit: '%', definition: 'Share of measured in-trial time spent in the quadrant centred on the target hole.' },
    { id: 'search_strategy', label: 'Search strategy', unit: 'label', definition: 'Spatial, serial or random, from path efficiency and the holes visited before the target.' },
  ],
  async analyze(source, config, options = {}) {
    const { videoId = 'recording', ...analyze } = config;
    const observations = await analyzeVideo(videoId, source, {
      ...analyze,
      ...(options.detector ? { detector: options.detector } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    return reanalyze(observations, { params: config.params, timebase: source.timebase });
  },
  report(outcome) {
    const m = outcome.measures;
    const whole = (fraction: number) => fraction >= 0.999;
    const seen = (fraction: number, what: string) => `${what} could be measured in ${(fraction * 100).toFixed(0)}% of the trial.`;
    return {
      paradigmId: 'barnes-maze',
      values: [
        latency('primary_latency_s', m.primaryLatency),
        latency('total_latency_s', m.totalLatency),
        metric('primary_errors', m.primaryErrors, whole(m.primaryErrorCoverage), whole(m.primaryErrorCoverage) ? undefined : seen(m.primaryErrorCoverage, 'Hole visits')),
        metric('total_errors', m.totalErrors, whole(m.totalErrorCoverage), whole(m.totalErrorCoverage) ? undefined : seen(m.totalErrorCoverage, 'Hole visits')),
        metric('path_length_cm', m.pathLengthCm, whole(m.pathLengthCoverage), whole(m.pathLengthCoverage) ? undefined : seen(m.pathLengthCoverage, 'Position')),
        metric('mean_speed_cm_s', m.meanSpeedCmPerSec, whole(m.pathLengthCoverage)),
        metric('target_quadrant_pct', 100 * m.targetQuadrantFraction, whole(m.targetQuadrantCoverage), whole(m.targetQuadrantCoverage) ? undefined : seen(m.targetQuadrantCoverage, 'Position')),
        metric('search_strategy', m.strategy.strategy),
      ],
      trackedFraction: m.quality.measuredPositionFraction,
      warnings: outcome.warnings,
    };
  },
};

function latency(id: string, l: Latency): MetricValue {
  return l.observed ? metric(id, l.sec) : metric(id, l.sec, false, 'Not reached before the trial ended; a lower bound.');
}


export type { AnalysisOutcome } from './pipeline';
