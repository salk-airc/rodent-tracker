/**
 * Detector sizes across cameras.
 *
 * The pixel defaults in `params.ts` and inside the detectors (noise floor,
 * erosion, search window, area caps) were tuned on the Barnes sample clips,
 * which image the platform at 4.56–4.83 px/cm. A rig with a different camera
 * or mount images a mouse bigger or smaller, so those sizes are rescaled by
 * how many pixels a centimeter covers there compared with the samples.
 *
 * Lengths scale by `s`, areas by `s²`. Ratios (`maxAreaRatio`,
 * `partialAreaRatio`) and gray levels are already scale-free.
 */

import type { TrackingParams } from '../types';

/** The scale the pixel defaults were tuned at: the sample clips' mean, rounded. */
export const REFERENCE_PX_PER_CM = 4.7;

/** How much bigger (above 1) or smaller a centimeter is here than on the sample clips. */
export function sizeScaleFor(pxPerCm: number): number {
  if (!(pxPerCm > 0)) throw new RangeError('pxPerCm must be positive');
  return pxPerCm / REFERENCE_PX_PER_CM;
}

export function scaleTrackingParams(params: TrackingParams, sizeScale: number): TrackingParams {
  if (sizeScale === 1) return params;
  return {
    ...params,
    minBlobPx: Math.max(1, Math.round(params.minBlobPx * sizeScale ** 2)),
    bodyCoreErodePx: Math.max(0, Math.round(params.bodyCoreErodePx * sizeScale)),
    holeLockRadiusPx: params.holeLockRadiusPx * sizeScale,
  };
}
