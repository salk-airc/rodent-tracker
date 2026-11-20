/** Rule-based spatial, serial, random, or unclassified search strategy. */

import type {
  HoleEvent,
  MazeGeometry,
  StrategyFeatures,
  StrategyParams,
  StrategyResult,
  TrackFrame,
} from '../types';
import { hasMeasuredPosition, holeByIndex, pxPerCm } from '../types';

export interface StrategyInput {
  readonly frames: ReadonlyArray<TrackFrame>;
  readonly events: ReadonlyArray<HoleEvent>;
  readonly geometry: MazeGeometry;
  readonly params: StrategyParams;
  readonly centerZoneFraction: number;
  readonly trialStartFrame: number;
  /** Escape frame or the observed protocol/recording endpoint. */
  readonly trialEndFrame: number;
  /** Frame of the first target investigation, or null if none was detected. */
  readonly primaryFrame: number | null;
  readonly frameDurationsSec: Float64Array;
  /** Fraction of in-trial frames with a position; a low value blocks classification. */
  readonly coverage: number;
}

/** Below this coverage the shape of the search is not known well enough to label. */
const MIN_COVERAGE = 0.9;
/** A direct-route label needs nearly the whole route, not a line across a gap. */
const MIN_ROUTE_COVERAGE = 0.9;
/** A search with fewer holes visited than this is too short to have a strategy. */
const MIN_HOLES_FOR_STRATEGY = 2;
/** Outside this fraction of the radius counts as the periphery. */
const PERIPHERY_FRACTION = 0.7;
/**
 * Intervals shorter than this are container artifacts rather than elapsed time.
 * The shortest non-zero interval in the sample clips is 0.065 ms.
 */
const MIN_USABLE_INTERVAL_SEC = 0.005;
/**
 * Distance the animal must cover before a new bearing is taken, in cm. About
 * a third of a mouse's body length: short enough to see a real turn, long
 * enough that the bearing means something.
 */
const TURN_SAMPLE_CM = 1;
/**
 * The animal must start at least this fraction of the platform radius from the
 * target for its route to say anything about spatial memory.
 */
const MIN_START_DISTANCE_FRACTION = 0.5;

export function classifyStrategy(input: StrategyInput): StrategyResult {
  const features = computeFeatures(input);
  const p = input.params;
  const { geometry, primaryFrame, trialEndFrame, coverage } = input;

  const holeSequence = investigationSequence(input.events, primaryFrame ?? trialEndFrame);

  if (coverage < MIN_COVERAGE) {
    return {
      strategy: 'unclassified',
      features,
      rule: 'insufficient-coverage',
      provenance: 'auto',
      notes:
        `Position coverage is ${(coverage * 100).toFixed(0)}%, below the 90% required for classification.`,
    };
  }

  if (geometry.targetHoleIndex === null) {
    return {
      strategy: 'unclassified',
      features,
      rule: 'no-target',
      provenance: 'auto',
      notes: 'No target hole is set. Strategy cannot be classified.',
    };
  }

  if (!Number.isFinite(features.startDistanceCm)) {
    return {
      strategy: 'unclassified',
      features,
      rule: 'start-position-unavailable',
      provenance: 'auto',
      notes: 'Start position is unavailable. Strategy cannot be classified.',
    };
  }

  if (holeSequence.length < MIN_HOLES_FOR_STRATEGY && primaryFrame === null) {
    return {
      strategy: 'unclassified',
      features,
      rule: 'too-few-holes',
      provenance: 'auto',
      notes:
        `${holeSequence.length} hole(s) investigated and no target investigation detected. Evidence is insufficient.`,
    };
  }

  // Path efficiency is uninformative when the trial starts beside the target.
  // This does not invalidate a serial pattern, which is target-independent.
  const minStartCm = (MIN_START_DISTANCE_FRACTION * geometry.platformRadiusPx) / pxPerCm(geometry);
  const efficiencyInformative = features.startDistanceCm >= minStartCm;

  // Rule 1 — spatial. Direct travel to the target, with few detours.
  if (
    efficiencyInformative &&
    primaryFrame !== null &&
    features.pathCoverage >= MIN_ROUTE_COVERAGE &&
    features.pathEfficiency >= p.spatialMinEfficiency &&
    features.holesBeforeTarget <= p.spatialMaxHolesBeforeTarget
  ) {
    return {
      strategy: 'spatial',
      features,
      rule: 'spatial: direct path with few wrong holes',
      provenance: 'auto',
      notes:
        `Route was straight to the target: path efficiency ${features.pathEfficiency.toFixed(2)} (threshold ${p.spatialMinEfficiency}); ` +
        `${features.holesBeforeTarget} wrong hole(s) before target (maximum ${p.spatialMaxHolesBeforeTarget}).`,
    };
  }

  // Rule 2 — serial. A systematic sweep around the ring, hugging the rim.
  if (
    features.longestSerialRun >= p.serialMinRun &&
    features.peripheryFraction >= p.serialMinPeripheryFraction
  ) {
    return {
      strategy: 'serial',
      features,
      rule: 'serial: consecutive holes around the ring, near the rim',
      provenance: 'auto',
      notes:
        `Longest consecutive-hole run ${features.longestSerialRun} (minimum ${p.serialMinRun}); ` +
        `${(features.peripheryFraction * 100).toFixed(0)}% near rim (minimum ${(p.serialMinPeripheryFraction * 100).toFixed(0)}%).`,
    };
  }

  // Do not assign "random" when the route is uninformative.
  if (!efficiencyInformative) {
    return {
      strategy: 'unclassified',
      features,
      rule: 'route-not-informative',
      provenance: 'auto',
      notes:
        `Start was ${featureValue(features.startDistanceCm, 1)} cm from the target hole (minimum ${minStartCm.toFixed(0)} cm). ` +
        `Longest consecutive-hole run was ${features.longestSerialRun} (minimum ${p.serialMinRun}). Review trial start.`,
    };
  }

  // Rule 3 — random needs positive evidence. "Neither spatial nor serial" is
  // not itself an observed behavior and must not become a label by default.
  if (features.centerCrossings >= p.randomMinCenterCrossings) {
    return {
      strategy: 'random',
      features,
      rule: 'random: repeated center crossings',
      provenance: 'auto',
      notes:
        `${features.centerCrossings} center crossings (minimum ${p.randomMinCenterCrossings}); path efficiency ` +
        `${featureValue(features.pathEfficiency, 2)}; longest consecutive-hole run ${features.longestSerialRun}; ` +
        `${featurePercent(features.peripheryFraction)} near rim.`,
    };
  }

  return {
    strategy: 'unclassified',
    features,
    rule: 'insufficient-pattern-evidence',
    provenance: 'auto',
    notes:
      `No rule met its threshold. Longest consecutive-hole run: ${features.longestSerialRun}/${p.serialMinRun}. ` +
      `Center crossings: ${features.centerCrossings}/${p.randomMinCenterCrossings}.`,
  };
}

// ---------------------------------------------------------------------------

export function computeFeatures(input: StrategyInput): StrategyFeatures {
  const {
    frames,
    geometry,
    trialStartFrame,
    trialEndFrame,
    primaryFrame,
    frameDurationsSec,
    centerZoneFraction,
  } = input;
  const scale = pxPerCm(geometry);

  const searchEndFrame = primaryFrame ?? trialEndFrame;
  const inSearch = frames.filter(
    (f) =>
      f.frame >= trialStartFrame &&
      f.frame <= searchEndFrame &&
      f.status !== 'preTrial' &&
      f.status !== 'postTrial',
  );

  // Path efficiency: how close the route was to a straight line.
  let pathPx = 0;
  let pathSteps = 0;
  let prev: TrackFrame | null = null;
  for (const f of inSearch) {
    if (!hasMeasuredPosition(f)) {
      prev = null;
      continue;
    }
    if (prev?.body) {
      pathPx += Math.hypot(f.body.x - prev.body.x, f.body.y - prev.body.y);
      pathSteps++;
    }
    prev = f;
  }
  const first = inSearch.find(hasMeasuredPosition)?.body ?? null;
  const target = geometry.targetHoleIndex !== null ? holeByIndex(geometry, geometry.targetHoleIndex)?.center ?? null : null;
  const straightPx = first && target ? Math.hypot(target.x - first.x, target.y - first.y) : 0;
  const pathEfficiency = pathPx > 0 && straightPx > 0 ? Math.min(1, straightPx / pathPx) : Number.NaN;
  const pathCoverage = inSearch.length > 1 ? pathSteps / (inSearch.length - 1) : 0;

  const holesBeforeTarget = new Set(
    input.events
      .filter((e) => e.type === 'investigation' && !e.isTarget && (primaryFrame === null || e.startFrame < primaryFrame))
      .map((e) => e.holeIndex),
  ).size;

  const searchSequence = investigationSequence(input.events, searchEndFrame);
  const longestSerialRun = longestConsecutiveRun(searchSequence, geometry.holeCount);

  // Center crossings and periphery time.
  let centerCrossings = 0;
  let inside: boolean | null = null;
  let peripherySec = 0;
  let totalSec = 0;
  const cx = geometry.center.x;
  const cy = geometry.center.y;
  const R = geometry.platformRadiusPx;
  for (const f of inSearch) {
    const dur = frameDurationsSec[f.frame] ?? 0;
    if (!hasMeasuredPosition(f)) {
      inside = null;
      continue;
    }
    const radial = Math.hypot(f.body.x - cx, f.body.y - cy) / R;
    if (radial < centerZoneFraction) {
      if (inside === false) {
        centerCrossings++;
      }
      inside = true;
    } else {
      inside = false;
    }
    if (radial > PERIPHERY_FRACTION) peripherySec += dur;
    totalSec += dur;
  }
  // Turn rate, resampled by distance traveled rather than by frame.
  //
  // Frame-to-frame headings are noise-dominated for sub-centimeter motion.
  // Resampling by distance measures turning after one centimeter of travel.
  let turnSum = 0;
  let turnTime = 0;
  let lastHeading: number | null = null;
  let anchor: { x: number; y: number } | null = null;
  let anchorTime = 0;
  let clock = 0;
  for (const f of inSearch) {
    const dur = frameDurationsSec[f.frame] ?? 0;
    if (dur >= MIN_USABLE_INTERVAL_SEC) clock += dur;
    if (!hasMeasuredPosition(f)) {
      anchor = null;
      lastHeading = null;
      continue;
    }
    if (!anchor) {
      anchor = f.body;
      anchorTime = clock;
      continue;
    }
    const dx = f.body.x - anchor.x;
    const dy = f.body.y - anchor.y;
    if (Math.hypot(dx, dy) / scale < TURN_SAMPLE_CM) continue;
    const heading = Math.atan2(dy, dx);
    if (lastHeading !== null) {
      let d = heading - lastHeading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turnSum += Math.abs((d * 180) / Math.PI);
      turnTime += clock - anchorTime;
    }
    lastHeading = heading;
    anchor = f.body;
    anchorTime = clock;
  }

  return {
    pathEfficiency,
    pathCoverage,
    holesBeforeTarget,
    longestSerialRun,
    centerCrossings: Math.max(0, centerCrossings),
    peripheryFraction: totalSec > 0 ? peripherySec / totalSec : Number.NaN,
    meanTurnRateDegPerSec: turnTime > 0 ? turnSum / turnTime : Number.NaN,
    startDistanceCm: first && target ? straightPx / scale : Number.NaN,
  };
}

function featureValue(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'unavailable';
}

function featurePercent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : 'an unavailable share';
}

/** Holes investigated, in order, optionally stopping at the first target visit. */
function investigationSequence(events: ReadonlyArray<HoleEvent>, untilFrame: number | null): number[] {
  return events
    .filter((e) => e.type === 'investigation' && (untilFrame === null || e.startFrame <= untilFrame))
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((e) => e.holeIndex);
}

/**
 * Longest stretch of neighboring holes checked in one direction.
 *
 * Ring indices wrap, so hole 19 followed by hole 0 continues a run. Repeats of
 * the hole just checked are ignored rather than breaking the run, since an
 * animal often sniffs the same hole twice on its way past.
 */
export function longestConsecutiveRun(sequence: ReadonlyArray<number>, holeCount: number): number {
  if (sequence.length === 0) return 0;
  let best = 1;
  let run = 1;
  let direction = 0;
  for (let i = 1; i < sequence.length; i++) {
    const prev = sequence[i - 1]!;
    const cur = sequence[i]!;
    if (cur === prev) continue;
    const forward = (cur - prev + holeCount) % holeCount;
    const step = forward === 1 ? 1 : forward === holeCount - 1 ? -1 : 0;
    if (step !== 0 && (direction === 0 || direction === step)) {
      run++;
      direction = step;
    } else {
      run = 1;
      direction = 0;
    }
    if (run > best) best = run;
  }
  return best;
}
