/**
 * Fear conditioning: associative learning read from freezing, the absence of
 * all movement but breathing, in the conditioning chamber.
 *
 * Scored from motion alone (`tracking/motion.ts`), so no arena calibration or
 * tracking is needed and a side-on camera works. The freezing threshold
 * depends on the camera and resolution: set it once per rig against a few
 * hand-scored sessions.
 */

import { metric, type Paradigm } from '../../paradigm';
import { frameAtTime } from '../../time';
import { detectFreezing, measureMotion, type FreezingResult, type MotionOptions, type MotionTrace } from '../../tracking/motion';

export interface FearConditioningConfig extends Omit<MotionOptions, 'onProgress'> {
  /** Below this many changed pixels a frame counts as still. */
  readonly freezeThresholdPx: number;
  /** Stillness shorter than this is not freezing, s. Default 1. */
  readonly minFreezeS?: number;
  /** Score only this stretch, seconds from the start of the recording. */
  readonly window?: { readonly startS?: number; readonly durationS?: number };
}

export interface FearConditioningResult {
  readonly motion: MotionTrace;
  readonly freezing: FreezingResult;
  /** Mean changed pixels per frame over the scored stretch. */
  readonly meanMotionPx: number;
  readonly warnings: ReadonlyArray<string>;
}

export const fearConditioning: Paradigm<FearConditioningConfig, FearConditioningResult> = {
  id: 'fear-conditioning',
  name: 'Fear conditioning',
  summary: 'Associative learning: time spent freezing, from frame-to-frame motion.',
  metrics: [
    { id: 'freezing_pct', label: 'Freezing', unit: '%', definition: 'Time in freezing bouts over time scored.' },
    { id: 'freezing_s', label: 'Time freezing', unit: 's', definition: 'Total duration of freezing bouts: motion below the threshold for at least the minimum duration.' },
    { id: 'freezing_bouts', label: 'Freezing bouts', unit: 'count', definition: 'Separate stretches of freezing.' },
    { id: 'mean_bout_s', label: 'Mean bout length', unit: 's', definition: 'Time freezing over the number of bouts.' },
    { id: 'mean_motion_px', label: 'Mean motion', unit: 'index', definition: 'Pixels changed per frame, averaged over the scored stretch.' },
  ],
  async analyze(source, config, options = {}) {
    const motion = await measureMotion(source, {
      ...config,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const start = config.window?.startS ?? 0;
    const from = frameAtTime(source.timebase, start);
    const to = config.window?.durationS === undefined ? source.frameCount - 1 : frameAtTime(source.timebase, start + config.window.durationS);
    const freezing = detectFreezing(motion, source.timebase, {
      thresholdPx: config.freezeThresholdPx,
      ...(config.minFreezeS !== undefined ? { minDurationS: config.minFreezeS } : {}),
    }, { from, to });

    let sum = 0;
    let count = 0;
    for (let f = Math.max(1, from); f <= to; f++) {
      sum += motion.changedPx[f]!;
      count++;
    }
    const warnings: string[] = [];
    if (motion.cutoffSource === 'estimated') {
      warnings.push('The motion cutoff was estimated with the animal in view. Give a few seconds of the empty chamber (calibration) to measure it directly.');
    }
    if (freezing.scoredS > 0 && freezing.freezingS / freezing.scoredS > 0.95) {
      warnings.push('Freezing in over 95% of the session. Check the freezing threshold and that the animal is in view.');
    }
    return { motion, freezing, meanMotionPx: count ? sum / count : 0, warnings };
  },
  report(result) {
    const f = result.freezing;
    return {
      paradigmId: 'fear-conditioning',
      values: [
        f.scoredS > 0 ? metric('freezing_pct', (100 * f.freezingS) / f.scoredS) : metric('freezing_pct', null, false, 'Nothing scored.'),
        metric('freezing_s', f.freezingS),
        metric('freezing_bouts', f.bouts.length),
        f.bouts.length ? metric('mean_bout_s', f.freezingS / f.bouts.length) : metric('mean_bout_s', null, false, 'No freezing bouts.'),
        metric('mean_motion_px', result.meanMotionPx),
      ],
      trackedFraction: null,
      warnings: result.warnings,
    };
  },
};
