/**
 * The Barnes maze paradigm: a round platform with holes around the rim, one
 * of which hides an escape box. Simon's analysis, unchanged, behind the
 * engine's `Paradigm` interface.
 *
 * The full API (project files, review, exports, raters) is in this folder;
 * this file is the entry point an app starts from.
 */

import type { Paradigm } from '../../paradigm';
import type { Arena, Zone } from '../../arena/arena';
import { analyzeVideo, reanalyze, type AnalysisOutcome, type AnalyzeOptions } from './pipeline';
import { holeNumber, pxPerCm, type MazeGeometry } from './types';

export type BarnesConfig = Omit<AnalyzeOptions, 'detector' | 'onProgress'> & {
  /** Names the recording in its outputs. Defaults to `recording`. */
  readonly videoId?: string;
};

export const barnesMaze: Paradigm<BarnesConfig, AnalysisOutcome> = {
  id: 'barnes-maze',
  name: 'Barnes maze',
  summary: 'Spatial learning: how quickly and directly the animal finds the escape hole.',
  measures: [
    'Latency to first investigate the target',
    'Latency to enter the target',
    'Errors before the target',
    'Path length',
    'Search strategy',
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
};

/**
 * The maze as a generic arena: the platform as the boundary, world origin at
 * its center, and a zone per hole of the investigation radius. Lets generic
 * tools (zone measures, overlays) work on a Barnes recording.
 */
export function barnesArena(geometry: MazeGeometry, holeRadiusCm: number): Arena {
  const scale = pxPerCm(geometry);
  const zones: Zone[] = geometry.holes.map((hole) => {
    const n = holeNumber(geometry, hole.index);
    return {
      id: `hole-${n}`,
      name: hole.index === geometry.targetHoleIndex ? `Hole ${n} (target)` : `Hole ${n}`,
      shape: {
        kind: 'circle',
        center: { x: (hole.center.x - geometry.center.x) / scale, y: (hole.center.y - geometry.center.y) / scale },
        radius: holeRadiusCm,
      },
    };
  });
  return {
    boundary: { kind: 'circle', center: { x: 0, y: 0 }, radius: geometry.platformDiameterCm / 2 },
    calibration: { kind: 'scale', pxPerCm: scale, originPx: geometry.center },
    zones,
  };
}

export type { AnalysisOutcome } from './pipeline';
