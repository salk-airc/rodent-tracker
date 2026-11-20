/**
 * Default detection settings, with the measurements behind them. They were
 * tuned on the Barnes sample clips (about 4.7 px/cm); paradigms on other rigs
 * rescale the pixel sizes with `scaleTrackingParams`.
 */

import type { TrackingParams } from '../types';

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
