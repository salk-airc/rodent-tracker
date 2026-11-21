/**
 * Motion and freezing from frame-to-frame change, the way ezTrack's freeze
 * analysis does it (Pennington et al. 2019, Sci Rep 9:19979); the algorithm
 * is re-implemented here, no code is copied.
 *
 * - Motion, per frame: blur the frame lightly, then count the pixels whose
 *   gray level changed by more than a cutoff since the previous frame.
 * - The cutoff sits above the camera's own noise: twice the 99.99th percentile
 *   of frame-to-frame change with no animal in view. Give animal-free frames
 *   (`calibration`) to measure it that way; otherwise it is estimated from the
 *   whole recording with a robust spread that the animal, moving through a
 *   small share of pixels, barely moves.
 * - Freezing: motion below a threshold for at least a minimum duration (1 s
 *   is the usual definition). Durations come from the frame timestamps.
 *
 * Needs no tracking, so it works side-on in a conditioning chamber, where an
 * overhead tracker would not.
 */

import { frameDurations } from '../time';
import { frameTime, type FrameSource } from '../types';
import { median } from '../stats';
import { blurGray, gaussianKernel } from '../image/blur';

export interface MotionOptions {
  /** 1 where motion counts, 0 elsewhere: the chamber, minus a cable or the ceiling. Default: the whole frame. */
  readonly mask?: Uint8Array;
  /** Gaussian blur before differencing, px. Default 1. */
  readonly blurSigma?: number;
  /** Gray-level change that counts as motion. Default: calibrated (see the file comment). */
  readonly cutoff?: number;
  /** Animal-free frames to calibrate the cutoff on, e.g. before the animal is placed. */
  readonly calibration?: { readonly from: number; readonly to: number };
  readonly onProgress?: (stage: 'calibration' | 'motion', done: number, total: number) => void;
}

export interface MotionTrace {
  /** Changed pixels at each frame against the one before; 0 for the first. */
  readonly changedPx: Float64Array;
  /** The gray-level cutoff used. */
  readonly cutoff: number;
  /** How the cutoff was set. */
  readonly cutoffSource: 'given' | 'animal-free frames' | 'estimated';
  /** Pixels in the mask, to put `changedPx` in proportion. */
  readonly maskPx: number;
}

/** Smallest cutoff, gray levels: below this, compression noise alone counts as motion. */
const MIN_CUTOFF = 2;
const CALIBRATION_PIXELS = 1000;
const CALIBRATION_PAIRS = 200;

export async function measureMotion(source: FrameSource, options: MotionOptions = {}): Promise<MotionTrace> {
  const { width, height, frameCount } = source;
  const n = width * height;
  const mask = options.mask;
  const kernel = gaussianKernel(options.blurSigma ?? 1);

  let cutoff = options.cutoff;
  let cutoffSource: MotionTrace['cutoffSource'] = 'given';
  if (cutoff === undefined) {
    const calibrated = await calibrateCutoff(source, kernel, mask, options);
    cutoff = calibrated.cutoff;
    cutoffSource = calibrated.source;
  }

  const changedPx = new Float64Array(frameCount);
  let previous = new Float32Array(n);
  let current = new Float32Array(n);
  const scratch = new Float32Array(n);
  let first = true;
  await source.scan(
    { from: 0, to: frameCount - 1 },
    (frame, gray) => {
      blurGray(gray, width, height, kernel, current, scratch);
      if (!first) {
        let count = 0;
        for (let i = 0; i < n; i++) {
          if ((mask === undefined || mask[i]) && Math.abs(current[i]! - previous[i]!) > cutoff!) count++;
        }
        changedPx[frame] = count;
      }
      first = false;
      [previous, current] = [current, previous];
    },
    (d, t) => options.onProgress?.('motion', d, t),
  );
  const maskPx = mask ? mask.reduce((s, v) => s + (v ? 1 : 0), 0) : n;
  return { changedPx, cutoff, cutoffSource, maskPx };
}

async function calibrateCutoff(
  source: FrameSource,
  kernel: Float32Array,
  mask: Uint8Array | undefined,
  options: MotionOptions,
): Promise<{ cutoff: number; source: 'animal-free frames' | 'estimated' }> {
  const { width, height, frameCount } = source;
  // A fixed set of pixels inside the mask, the same every run.
  const candidates: number[] = [];
  for (let i = 0; i < width * height; i++) if (mask === undefined || mask[i]) candidates.push(i);
  let seed = 7;
  const pixels = Array.from({ length: Math.min(CALIBRATION_PIXELS, candidates.length) }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return candidates[seed % candidates.length]!;
  });

  const range = options.calibration ?? { from: 0, to: frameCount - 1 };
  const from = Math.max(0, range.from);
  const to = Math.min(frameCount - 1, range.to);
  // Consecutive pairs spread over the range.
  const starts = new Set<number>();
  const pairs = Math.min(CALIBRATION_PAIRS, Math.max(1, to - from));
  for (let k = 0; k < pairs; k++) starts.add(from + Math.floor(((to - from - 1) * k) / Math.max(1, pairs - 1)));
  const only = new Set<number>();
  for (const s of starts) only.add(s).add(s + 1);

  const blurred = new Float32Array(width * height);
  const scratch = new Float32Array(width * height);
  const last = new Map<number, Float32Array>();
  const diffs: number[] = [];
  await source.scan(
    { from, to: Math.min(to, Math.max(...only)), only },
    (frame, gray) => {
      if (!only.has(frame)) return;
      blurGray(gray, width, height, kernel, blurred, scratch);
      const values = Float32Array.from(pixels, (p) => blurred[p]!);
      const before = last.get(frame - 1);
      if (before) for (let i = 0; i < values.length; i++) diffs.push(Math.abs(values[i]! - before[i]!));
      if (starts.has(frame)) last.set(frame, values);
      last.delete(frame - 1);
    },
    (d, t) => options.onProgress?.('calibration', d, t),
  );
  if (diffs.length === 0) return { cutoff: MIN_CUTOFF, source: options.calibration ? 'animal-free frames' : 'estimated' };

  if (options.calibration) {
    diffs.sort((a, b) => a - b);
    const p9999 = diffs[Math.min(diffs.length - 1, Math.floor(0.9999 * (diffs.length - 1)))]!;
    return { cutoff: Math.max(MIN_CUTOFF, 2 * p9999), source: 'animal-free frames' };
  }
  // With the animal in view: noise spread from the median absolute change
  // (σ ≈ median / 0.6745 for Gaussian noise), and the same 2 × 99.99th
  // percentile it implies (99.99th ≈ 3.89 σ).
  const sigma = median(diffs) / 0.6745;
  return { cutoff: Math.max(MIN_CUTOFF, 2 * 3.89 * sigma), source: 'estimated' };
}

export interface FreezingOptions {
  /** Below this many changed pixels a frame counts as still. Depends on the camera and resolution; tune it against hand scoring. */
  readonly thresholdPx: number;
  /** Stillness shorter than this is not freezing, s. Default 1. */
  readonly minDurationS?: number;
}

export interface FreezingBout {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly startS: number;
  readonly durationS: number;
}

export interface FreezingResult {
  /** Per frame: part of a freezing bout. */
  readonly frozen: ReadonlyArray<boolean>;
  readonly bouts: ReadonlyArray<FreezingBout>;
  readonly freezingS: number;
  /** Time scored, from the first to the last frame. */
  readonly scoredS: number;
}

/** Freezing bouts from a motion trace, over frames `from`..`to` (default all). */
export function detectFreezing(
  trace: MotionTrace,
  timebase: FrameSource['timebase'],
  options: FreezingOptions,
  range: { readonly from?: number; readonly to?: number } = {},
): FreezingResult {
  const minS = options.minDurationS ?? 1;
  const n = trace.changedPx.length;
  const from = Math.max(1, range.from ?? 1); // frame 0 has no previous frame
  const to = Math.min(n - 1, range.to ?? n - 1);
  const durations = frameDurations(timebase);
  const frozen = new Array<boolean>(n).fill(false);
  const bouts: FreezingBout[] = [];

  let runStart = -1;
  const close = (end: number) => {
    if (runStart < 0) return;
    let d = 0;
    for (let f = runStart; f <= end; f++) d += durations[f] ?? 0;
    if (d >= minS) {
      for (let f = runStart; f <= end; f++) frozen[f] = true;
      bouts.push({ startFrame: runStart, endFrame: end, startS: frameTime(timebase, runStart), durationS: d });
    }
    runStart = -1;
  };
  for (let f = from; f <= to; f++) {
    if (trace.changedPx[f]! < options.thresholdPx) {
      if (runStart < 0) runStart = f;
    } else close(f - 1);
  }
  close(to);

  let scoredS = 0;
  for (let f = from; f <= to; f++) scoredS += durations[f] ?? 0;
  return { frozen, bouts, freezingS: bouts.reduce((s, b) => s + b.durationS, 0), scoredS };
}
