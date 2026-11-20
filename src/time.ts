/**
 * Convert frames to seconds using container timestamps.
 *
 * `frameIndex / fps` is wrong on all three sample clips. `test51` runs at
 * 15000/1001 fps rather than 15, which alone turns a 30.00 s latency into
 * 30.06 s. Worse, the clips are not constant frame rate at all: the re-encode
 * left frames sharing a timestamp with their neighbor and intervals at twice
 * the nominal one. Any duration therefore has to be a difference of actual
 * presentation timestamps.
 */

import { frameTime, type Timebase, type TimingReport } from './types';

export { frameTime };

/**
 * Seconds each frame is on screen.
 *
 * A frame that shares its timestamp with the next frame has zero duration. The
 * final frame also has zero duration because this timebase does not contain a
 * container end timestamp. Inferring another interval would add time that was
 * not measured.
 */
export function frameDurations(timebase: Timebase): Float64Array {
  const n = timebase.ptsTicks.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  for (let i = 0; i < n - 1; i++) {
    out[i] = (timebase.ptsTicks[i + 1]! - timebase.ptsTicks[i]!) / timebase.timescale;
  }
  return out;
}

/** End timestamp of a frame, without inferring an unreported final duration. */
export function frameEndTime(timebase: Timebase, frame: number): number {
  const start = frameTime(timebase, frame);
  const next = timebase.ptsTicks[frame + 1];
  return next === undefined ? start : next / timebase.timescale;
}

/** Duration from the start of one frame through the end of another. */
export function frameSpan(
  timebase: Timebase,
  startFrame: number,
  endFrame: number,
  endLimitSec = Number.POSITIVE_INFINITY,
): number {
  const start = frameTime(timebase, startFrame);
  const end = Math.min(frameEndTime(timebase, endFrame), endLimitSec);
  return Math.max(0, end - start);
}

/** Per-frame display durations clipped to an observed analysis interval. */
export function clippedFrameDurations(
  timebase: Timebase,
  startSec: number,
  endSec: number,
): Float64Array {
  const out = new Float64Array(timebase.ptsTicks.length);
  if (endSec <= startSec) return out;
  for (let frame = 0; frame < out.length; frame++) {
    const overlapStart = Math.max(frameTime(timebase, frame), startSec);
    const overlapEnd = Math.min(frameEndTime(timebase, frame), endSec);
    out[frame] = Math.max(0, overlapEnd - overlapStart);
  }
  return out;
}

/** Seconds between two frames, from the timestamps. */
export function elapsed(timebase: Timebase, fromFrame: number, toFrame: number): number {
  return frameTime(timebase, toFrame) - frameTime(timebase, fromFrame);
}

/**
 * Last frame whose presentation timestamp is at or before `seconds`.
 *
 * Playback uses this instead of an assumed frame rate. The last matching frame
 * is chosen so frames with zero display duration are skipped.
 */
export function frameAtTime(timebase: Timebase, seconds: number): number {
  const pts = timebase.ptsTicks;
  if (pts.length === 0) return 0;

  const targetTicks = seconds * timebase.timescale;
  let low = 0;
  let high = pts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (pts[middle]! <= targetTicks) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(pts.length - 1, low - 1));
}

/**
 * Timing uncertainty reported with latencies when container timing is invalid.
 */
export function timingUncertaintySec(timing: TimingReport): number {
  const defective = timing.duplicateTimestampFrames.length + timing.irregularIntervalFrames.length;
  if (defective === 0) return 0;
  return timing.nominalDeltaTicks / timing.timescale;
}

/**
 * Characterize container timing for both frame-source implementations.
 *
 * The sample clips were re-encoded, and the re-encode left artifacts: in
 * `test50`, 162 frames carry the same timestamp as their predecessor and 452
 * intervals are not the nominal one. Those frames cannot be placed in time to
 * better than a frame, and a report that does not say so invites someone to
 * read a latency to two decimal places it does not have.
 */
export function describeTiming(timescale: number, ptsTicks: ReadonlyArray<number>): TimingReport {
  const counts = new Map<number, number>();
  const duplicates: number[] = [];
  for (let i = 1; i < ptsTicks.length; i++) {
    const d = ptsTicks[i]! - ptsTicks[i - 1]!;
    counts.set(d, (counts.get(d) ?? 0) + 1);
    if (d === 0) duplicates.push(i);
  }
  let nominal = 0;
  let bestCount = -1;
  for (const [d, c] of counts) {
    // Ties broken toward the smaller interval, so the nominal rate is never
    // reported as slower than the file actually runs.
    if (c > bestCount || (c === bestCount && d < nominal)) {
      bestCount = c;
      nominal = d;
    }
  }
  const irregular: number[] = [];
  for (let i = 1; i < ptsTicks.length; i++) {
    if (ptsTicks[i]! - ptsTicks[i - 1]! !== nominal) irregular.push(i);
  }
  const durationSec = ptsTicks.length ? (ptsTicks[ptsTicks.length - 1]! - ptsTicks[0]!) / timescale : 0;
  return {
    timescale,
    frameCount: ptsTicks.length,
    nominalDeltaTicks: nominal,
    nominalFps: nominal > 0 ? timescale / nominal : Number.NaN,
    effectiveFps: durationSec > 0 ? (ptsTicks.length - 1) / durationSec : Number.NaN,
    durationSec,
    duplicateTimestampFrames: duplicates,
    irregularIntervalFrames: irregular,
  };
}
