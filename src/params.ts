/** Default analysis parameters with measurement-based rationale. */

import type { AnalysisParams, EventParams, StrategyParams, TrackingParams } from './types';

export const DEFAULT_TRACKING: TrackingParams = {
  /**
   * The animal is a dark object on a lit platform. Measured contrast between
   * the animal and the platform is 80-100 gray levels on these clips, so 25 is
   * comfortably clear of compression noise (a few levels) while still catching
   * the animal where the platform is dimmest.
   */
  darkThreshold: 25,
  /** A 40 px noise floor for the supplied 640×480 recordings. */
  minBlobPx: 40,
  /**
   * The central object detected at the start of `test51` is 3,332 px against a
   * 751 px reference area, a factor of 4.4. A threshold of 2.5 separates it
   * from the largest accepted animal blob in the sample calibration (1,071 px,
   * 1.4 times the median).
   */
  maxAreaRatio: 2.5,
  /**
   * A head-down posture shows less of the tracked blob. The final tracked area
   * ratios in `test51` and `test53` are about 0.48 and 0.23. A threshold of 0.7
   * catches the start of those dips while leaving ordinary area variation.
   */
  partialAreaRatio: 0.7,
  /**
   * The tail is 1-2 px of half-width and the body about 10, measured on all
   * three clips. Anything in the middle strips one and keeps the other, so
   * this is not a delicate setting.
   */
  bodyCoreErodePx: 4,
  /** Enough frames for a stable per-pixel percentile without a long wait. */
  backgroundSampleFrames: 41,
  /**
   * A sample hole is about 12 px in radius. A disappearance is associated with
   * a hole only when the preceding track is within roughly two hole radii.
   */
  holeLockRadiusPx: 26,
};

export const DEFAULT_EVENTS: EventParams = {
  /**
   * Nose within 3 cm of the hole center, which is a hole radius (2.5 cm) plus
   * a little. There is no consensus value in the literature; this is a
   * defensible starting point and the control is in the interface next to the
   * count it produces.
   */
  investigationRadiusCm: 3,
  /**
   * A quarter second rejects brief passes without discarding a short visit.
   */
  minInvestigationSec: 0.25,
  /**
   * Leaving and returning within this long is one visit, not two.
   *
   * Set from the gaps actually present in the data. On `test51` the animal
   * dwells at hole 11 and at hole 18 with brief excursions of 0.47 and 0.53 s
   * before returning, while its genuinely separate visits to the same hole are
   * 1.9 s apart and more. 0.75 s merges the former and keeps the latter apart,
   * turning thirteen threshold crossings into nine merged visits.
   */
  mergeGapSec: 0.75,
  /**
   * Leave at 1.6 times the entry radius. An animal at a hole rests its nose
   * 2-3 cm from the center, straddling the 3 cm threshold, so without this one
   * investigation is reported as several.
   */
  exitRadiusMultiple: 1.6,
  /**
   * Visible area must fall below this fraction of body area to call an entry.
   *
   * This value separates two visible-area signatures in the sample clips.
   * `test53` holds below 0.35 near the end; `test51` bottoms out near 0.49.
   * These observations calibrate an adjustable detector threshold. They do not
   * establish either clip's biological ground truth.
   */
  entryAreaRatio: 0.35,
  /** Hold for half a second so a brief area dip is not labeled an entry. */
  minEntrySec: 0.5,
  /**
   * Count each hole once by default so repeated visits do not dominate the
   * error count. Counting every visit remains available in the interface.
   */
  errorCounting: 'unique',
  /** Neighbors of the target are counted as errors by default; some labs do not. */
  adjacentHolesAreErrors: true,
};

export const DEFAULT_STRATEGY: StrategyParams = {
  /**
   * A direct run to the target is about 0.7 of a straight line or better once
   * the animal's own body length and a normal approach curve are allowed for.
   */
  spatialMinEfficiency: 0.7,
  /** Checking three or more wrong holes on the way is not a direct trip. */
  spatialMaxHolesBeforeTarget: 2,
  /** Four consecutive holes in one direction is a systematic sweep, not luck. */
  serialMinRun: 4,
  /** A serial search hugs the rim; crossing the middle is a different strategy. */
  serialMinPeripheryFraction: 0.6,
  /** Two or more trips through the middle marks an unsystematic search. */
  randomMinCenterCrossings: 2,
};

export const DEFAULT_PARAMS: AnalysisParams = {
  tracking: DEFAULT_TRACKING,
  events: DEFAULT_EVENTS,
  strategy: DEFAULT_STRATEGY,
  /**
   * The default protocol cutoff is 180 s and remains editable. When no target
   * event is detected before it, latency is recorded as a censored lower bound.
   */
  trialCutoffSec: 180,
  /** Inside 0.3 of the radius counts as the middle of the platform. */
  centerZoneFraction: 0.3,
  /** Under 2 cm/s the animal is not going anywhere. */
  movingSpeedThresholdCmPerSec: 2,
  /**
   * Gaps up to a third of a second may be bridged. Longer gaps remain missing.
   */
  maxInterpolateGapFrames: 10,
  /** A five-frame median filter removes single-frame jitter without rounding corners. */
  smoothingWindowFrames: 5,
  /**
   * A fifth of a second. Long enough to be immune to the single-tick timestamp
   * intervals in these files, short enough to still show a dart across the
   * platform as fast.
   */
  speedWindowSec: 0.2,
};

/**
 * Validate settings before they can produce a result.
 *
 * UI controls already constrain these values, but project files and the MCP
 * server are external inputs. Rejecting an invalid setting is safer than
 * letting JavaScript turn it into NaN, zero events, or a plausible default.
 */
export function analysisParameterErrors(value: unknown): string[] {
  if (!isRecord(value)) return ['analysis parameters must be an object'];
  const errors: string[] = [];
  const tracking = child(value, 'tracking', errors);
  const events = child(value, 'events', errors);
  const strategy = child(value, 'strategy', errors);

  numberField(tracking, 'tracking', 'darkThreshold', errors, { min: 0, max: 255 });
  numberField(tracking, 'tracking', 'minBlobPx', errors, { min: 1, integer: true });
  numberField(tracking, 'tracking', 'maxAreaRatio', errors, { minExclusive: 1 });
  numberField(tracking, 'tracking', 'partialAreaRatio', errors, { minExclusive: 0, max: 1 });
  numberField(tracking, 'tracking', 'bodyCoreErodePx', errors, { min: 0, integer: true });
  numberField(tracking, 'tracking', 'backgroundSampleFrames', errors, { min: 3, integer: true });
  numberField(tracking, 'tracking', 'holeLockRadiusPx', errors, { minExclusive: 0 });

  numberField(events, 'events', 'investigationRadiusCm', errors, { minExclusive: 0 });
  numberField(events, 'events', 'minInvestigationSec', errors, { min: 0 });
  numberField(events, 'events', 'mergeGapSec', errors, { min: 0 });
  numberField(events, 'events', 'exitRadiusMultiple', errors, { min: 1 });
  numberField(events, 'events', 'entryAreaRatio', errors, { minExclusive: 0, max: 1 });
  numberField(events, 'events', 'minEntrySec', errors, { min: 0 });
  if (events && events.errorCounting !== 'unique' && events.errorCounting !== 'all') {
    errors.push('events.errorCounting must be "unique" or "all"');
  }
  if (events && typeof events.adjacentHolesAreErrors !== 'boolean') {
    errors.push('events.adjacentHolesAreErrors must be true or false');
  }

  numberField(strategy, 'strategy', 'spatialMinEfficiency', errors, { min: 0, max: 1 });
  numberField(strategy, 'strategy', 'spatialMaxHolesBeforeTarget', errors, { min: 0, integer: true });
  numberField(strategy, 'strategy', 'serialMinRun', errors, { min: 2, integer: true });
  numberField(strategy, 'strategy', 'serialMinPeripheryFraction', errors, { min: 0, max: 1 });
  numberField(strategy, 'strategy', 'randomMinCenterCrossings', errors, { min: 1, integer: true });

  numberField(value, '', 'trialCutoffSec', errors, { minExclusive: 0 });
  numberField(value, '', 'centerZoneFraction', errors, { minExclusive: 0, max: 1 });
  numberField(value, '', 'movingSpeedThresholdCmPerSec', errors, { min: 0 });
  numberField(value, '', 'maxInterpolateGapFrames', errors, { min: 0, integer: true });
  numberField(value, '', 'smoothingWindowFrames', errors, { min: 1, integer: true });
  if (
    typeof value.smoothingWindowFrames === 'number' &&
    Number.isInteger(value.smoothingWindowFrames) &&
    value.smoothingWindowFrames % 2 === 0
  ) {
    errors.push('smoothingWindowFrames must be odd so the recorded width matches the median window used');
  }
  numberField(value, '', 'speedWindowSec', errors, { minExclusive: 0 });
  return errors;
}

interface NumberRules {
  readonly min?: number;
  readonly minExclusive?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

function numberField(
  record: Record<string, unknown> | null,
  section: string,
  key: string,
  errors: string[],
  rules: NumberRules,
): void {
  if (!record) return;
  const value = record[key];
  const name = section ? `${section}.${key}` : key;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${name} must be a finite number`);
    return;
  }
  if (rules.integer && !Number.isInteger(value)) errors.push(`${name} must be an integer`);
  if (rules.min !== undefined && value < rules.min) errors.push(`${name} must be at least ${rules.min}`);
  if (rules.minExclusive !== undefined && value <= rules.minExclusive) {
    errors.push(`${name} must be greater than ${rules.minExclusive}`);
  }
  if (rules.max !== undefined && value > rules.max) errors.push(`${name} must be at most ${rules.max}`);
}

function child(record: Record<string, unknown>, key: string, errors: string[]): Record<string, unknown> | null {
  const value = record[key];
  if (!isRecord(value)) {
    errors.push(`${key} must be an object`);
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
