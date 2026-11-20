/** Compute timestamp-based trial measures and explicit censored values. */

import type {
  AnalysisParams,
  HoleEvent,
  Latency,
  MazeGeometry,
  TrackFrame,
  TrackingQuality,
  Timebase,
  TrialMeasures,
} from '../types';
import { hasMeasuredPosition, holeByIndex, pxPerCm } from '../types';
import { clippedFrameDurations, frameAtTime, frameTime } from '../time';
import { classifyStrategy } from './strategy';

export interface MeasureInput {
  readonly videoId: string;
  readonly frames: ReadonlyArray<TrackFrame>;
  readonly events: ReadonlyArray<HoleEvent>;
  readonly geometry: MazeGeometry;
  readonly params: AnalysisParams;
  readonly timebase: Timebase;
  readonly trialStartFrame: number;
  readonly quality: TrackingQuality;
}

export function computeMeasures(input: MeasureInput): TrialMeasures {
  const { videoId, frames, events, geometry, params, timebase, trialStartFrame, quality } = input;
  const scale = pxPerCm(geometry);
  const startSec = frameTime(timebase, trialStartFrame);
  const lastFrame = frames.length
    ? Math.min(frames[frames.length - 1]!.frame, timebase.ptsTicks.length - 1)
    : trialStartFrame;
  const recordedEndSec = Math.max(startSec, frameTime(timebase, lastFrame));
  const cutoffEndSec = Math.min(recordedEndSec, startSec + params.trialCutoffSec);
  const cutoffEndFrame = frameAtTime(timebase, cutoffEndSec);
  const warnings: string[] = [];

  const eligibleEvents = events.filter(
    (event) => event.startFrame <= cutoffEndFrame && frameTime(timebase, event.startFrame) <= cutoffEndSec,
  );

  // --- latencies -----------------------------------------------------------
  const targetInvestigations = eligibleEvents
    .filter((e) => e.type === 'investigation' && e.isTarget)
    .sort((a, b) => a.startFrame - b.startFrame);
  const targetEntries = eligibleEvents
    .filter((e) => e.type === 'entry' && e.isTarget)
    .sort((a, b) => a.startFrame - b.startFrame);

  const primaryLatency = latencyFrom(targetInvestigations[0] ?? null, startSec, cutoffEndSec, timebase);
  const totalLatency = latencyFrom(targetEntries[0] ?? null, startSec, cutoffEndSec, timebase);

  if (!primaryLatency.observed) {
    warnings.push(
      `No target-hole investigation was detected. Primary latency is censored at ${primaryLatency.sec.toFixed(2)} s.`,
    );
  }
  if (!totalLatency.observed) {
    warnings.push(
      `No target entry was detected. Total latency is censored at ${totalLatency.sec.toFixed(2)} s and excluded from means.`,
    );
  }

  // --- errors --------------------------------------------------------------
  const primaryCutoff = targetInvestigations[0]?.startFrame ?? Number.POSITIVE_INFINITY;
  const trialEndSec = targetEntries[0]
    ? Math.min(frameTime(timebase, targetEntries[0].startFrame), cutoffEndSec)
    : cutoffEndSec;
  const trialEndFrame = frameAtTime(timebase, trialEndSec);
  const durations = clippedFrameDurations(timebase, startSec, trialEndSec);
  const inTrial = frames.filter(
    (f) => f.frame >= trialStartFrame && f.frame <= trialEndFrame && f.status !== 'preTrial' && f.status !== 'postTrial',
  );
  const errorEvents = eligibleEvents.filter((e) => e.type === 'investigation' && e.isError);
  const primaryErrors = errorEvents.filter((e) => e.startFrame < primaryCutoff).length;
  const totalErrors = errorEvents.filter((e) => e.startFrame <= trialEndFrame).length;
  const primaryErrorFrames = targetInvestigations[0]
    ? inTrial.filter((frame) => frame.frame < primaryCutoff)
    : inTrial;
  const primaryErrorCoverage =
    targetInvestigations[0] && primaryErrorFrames.length === 0
      ? 1
      : holeEvidenceCoverage(primaryErrorFrames);
  const totalErrorCoverage = holeEvidenceCoverage(inTrial);
  if (primaryErrorCoverage < 1 || totalErrorCoverage < 1) {
    warnings.push(
      primaryErrorCoverage === 0 && totalErrorCoverage === 0
        ? 'Error counts are unavailable: no frames had hole-visit evidence.'
        : `Error counts are lower bounds. Coverage was ${(primaryErrorCoverage * 100).toFixed(0)}% before the target visit and ${(totalErrorCoverage * 100).toFixed(0)}% overall.`,
    );
  }

  // --- path, speed ---------------------------------------------------------
  const speeds = windowedSpeeds(inTrial, scale, timebase, params.speedWindowSec);
  let pathCm = 0;
  let movingSec = 0;
  let movingCm = 0;
  let maxSpeed = 0;
  let speedSamples = 0;
  let contributing = 0;
  let prev: TrackFrame | null = null;
  for (let i = 0; i < inTrial.length; i++) {
    const f = inTrial[i]!;
    if (!hasMeasuredPosition(f)) {
      prev = null;
      continue;
    }
    const speed = speeds[i]!;
    if (Number.isFinite(speed)) {
      speedSamples++;
      if (speed > maxSpeed) maxSpeed = speed;
    }
    if (prev?.body) {
      const stepCm = Math.hypot(f.body.x - prev.body.x, f.body.y - prev.body.y) / scale;
      pathCm += stepCm;
      contributing++;
      if (Number.isFinite(speed) && speed >= params.movingSpeedThresholdCmPerSec) {
        movingSec += durations[prev.frame] ?? 0;
        movingCm += stepCm;
      }
    }
    prev = f;
  }

  const trialDurationSec = Math.max(0, trialEndSec - startSec);
  const measuredPath = contributing > 0 ? pathCm : Number.NaN;
  const meanSpeed = contributing > 0 && trialDurationSec > 0 ? pathCm / trialDurationSec : Number.NaN;
  const meanMovingSpeed = movingSec > 0 ? movingCm / movingSec : Number.NaN;
  const pathLengthCoverage = inTrial.length > 1 ? contributing / (inTrial.length - 1) : 0;

  if (pathLengthCoverage < 1) {
    warnings.push(
      pathLengthCoverage > 0
        ? `Path coverage is ${(pathLengthCoverage * 100).toFixed(0)}%. Missing, interpolated and in-hole positions are excluded; distance and average speed are lower bounds.`
        : 'Path length and speed are unavailable: no consecutive measured positions.',
    );
  }

  // --- target quadrant ----------------------------------------------------
  const quadrant = timeInTargetQuadrant(inTrial, geometry, durations);
  if (geometry.targetHoleIndex !== null && quadrant.coverage < 1) {
    warnings.push(
      quadrant.coverage > 0
        ? `Target-quadrant coverage is ${(quadrant.coverage * 100).toFixed(0)}%. Missing and inferred positions are excluded.`
        : 'Target-quadrant time is unavailable: no measured positions.',
    );
  }

  // --- strategy -----------------------------------------------------------
  const strategyEndFrame = targetInvestigations[0]?.startFrame ?? trialEndFrame;
  const strategyEndSec = targetInvestigations[0]
    ? Math.min(frameTime(timebase, targetInvestigations[0].startFrame), trialEndSec)
    : trialEndSec;
  const inSearch = frames.filter(
    (f) =>
      f.frame >= trialStartFrame &&
      f.frame <= strategyEndFrame &&
      f.status !== 'preTrial' &&
      f.status !== 'postTrial',
  );
  const coverage = inSearch.length
    ? inSearch.filter(hasMeasuredPosition).length / inSearch.length
    : 0;
  const strategy = classifyStrategy({
    frames,
    events: eligibleEvents,
    geometry,
    params: params.strategy,
    centerZoneFraction: params.centerZoneFraction,
    trialStartFrame,
    trialEndFrame,
    primaryFrame: targetInvestigations[0]?.startFrame ?? null,
    frameDurationsSec: clippedFrameDurations(timebase, startSec, strategyEndSec),
    coverage,
  });

  return {
    videoId,
    primaryLatency,
    totalLatency,
    primaryErrors,
    primaryErrorCoverage,
    totalErrors,
    totalErrorCoverage,
    pathLengthCm: measuredPath,
    meanSpeedCmPerSec: meanSpeed,
    meanMovingSpeedCmPerSec: meanMovingSpeed,
    maxSpeedCmPerSec: speedSamples > 0 ? maxSpeed : Number.NaN,
    timeInTargetQuadrantSec: quadrant.sec,
    targetQuadrantFraction: quadrant.fraction,
    targetQuadrantCoverage: quadrant.coverage,
    trialDurationSec,
    strategy,
    quality,
    pathLengthCoverage,
    warnings,
  };
}

/** Coverage for detecting hole visits; interpolated positions are not evidence. */
function holeEvidenceCoverage(frames: ReadonlyArray<TrackFrame>): number {
  if (frames.length === 0) return 0;
  const observed = frames.filter(
    (frame) =>
      !frame.interpolated &&
      ((frame.status === 'inHole' && frame.holeIndex !== null) || frame.nose !== null),
  ).length;
  return observed / frames.length;
}

/**
 * A latency, or the cutoff with a flag saying no event was detected.
 *
 * The endpoint is the protocol cutoff or the observed recording span,
 * whichever is shorter: reporting "at least 180 s" for a recording that only
 * ran 30 s would be a claim the data does not support.
 */
function latencyFrom(
  event: HoleEvent | null,
  startSec: number,
  cutoffEndSec: number,
  timebase: Timebase,
): Latency {
  if (event !== null) {
    return {
      sec: frameTime(timebase, event.startFrame) - startSec,
      observed: true,
      frame: event.startFrame,
      provenance: event.provenance,
    };
  }
  return {
    sec: Math.max(0, cutoffEndSec - startSec),
    observed: false,
    frame: null,
    provenance: 'censored_cutoff',
  };
}

/**
 * Speed at each frame, measured across a fixed span of time rather than between
 * adjacent frames.
 *
 * Adjacent frames are not safe to divide by in these files. The re-encode left
 * intervals of a single tick — 0.067 ms — and a genuine 0.6 cm step across one
 * of those reads as 8,775 cm/s, which is what an early version duly reported as
 * the animal's top speed. Straddling a window of real time removes the problem
 * at the source, and "how fast was it moving over the last fifth of a second"
 * is the more meaningful question about an animal in any case.
 *
 * Returns NaN where the window could not be filled — near the ends of the
 * trial, or across a tracking gap.
 */
function windowedSpeeds(
  inTrial: ReadonlyArray<TrackFrame>,
  scale: number,
  timebase: Timebase,
  windowSec: number,
): Float64Array {
  const out = new Float64Array(inTrial.length).fill(Number.NaN);
  const half = windowSec / 2;
  for (let i = 0; i < inTrial.length; i++) {
    if (!hasMeasuredPosition(inTrial[i]!)) continue;
    const t = frameTime(timebase, inTrial[i]!.frame);
    let lo = i;
    let hi = i;
    while (lo > 0 && frameTime(timebase, inTrial[lo]!.frame) > t - half) lo--;
    while (hi < inTrial.length - 1 && frameTime(timebase, inTrial[hi]!.frame) < t + half) hi++;
    const a = inTrial[lo]!;
    const b = inTrial[hi]!;
    if (!hasMeasuredPosition(a) || !hasMeasuredPosition(b)) continue;
    let continuous = true;
    for (let k = lo; k <= hi; k++) {
      if (!hasMeasuredPosition(inTrial[k]!)) {
        continuous = false;
        break;
      }
    }
    if (!continuous) continue;
    const dt = frameTime(timebase, b.frame) - frameTime(timebase, a.frame);
    if (dt <= 0) continue;
    out[i] = Math.hypot(b.body.x - a.body.x, b.body.y - a.body.y) / scale / dt;
  }
  return out;
}

/**
 * Time in the target quadrant: the 90-degree sector centered on the target hole.
 *
 * Defined by angle from the platform center rather than by a screen-aligned
 * quarter of the image, so it does not depend on how the camera happens to be
 * rotated.
 */
function timeInTargetQuadrant(
  inTrial: ReadonlyArray<TrackFrame>,
  geometry: MazeGeometry,
  durations: Float64Array,
): { sec: number; fraction: number; coverage: number } {
  if (geometry.targetHoleIndex === null) {
    return { sec: Number.NaN, fraction: Number.NaN, coverage: 0 };
  }
  const target = holeByIndex(geometry, geometry.targetHoleIndex);
  if (!target) return { sec: Number.NaN, fraction: Number.NaN, coverage: 0 };
  const targetAngle = Math.atan2(target.center.y - geometry.center.y, target.center.x - geometry.center.x);

  let inSec = 0;
  let measuredSec = 0;
  let trialSec = 0;
  for (const f of inTrial) {
    const dur = durations[f.frame] ?? 0;
    trialSec += dur;
    if (!hasMeasuredPosition(f)) continue;
    measuredSec += dur;
    const a = Math.atan2(f.body.y - geometry.center.y, f.body.x - geometry.center.x);
    let d = a - targetAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) <= Math.PI / 4) inSec += dur;
  }
  return {
    sec: measuredSec > 0 ? inSec : Number.NaN,
    fraction: measuredSec > 0 ? inSec / measuredSec : Number.NaN,
    coverage: trialSec > 0 ? measuredSec / trialSec : 0,
  };
}
