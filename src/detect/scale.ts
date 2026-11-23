/**
 * Detector sizes across cameras and rodent species.
 *
 * The pixel defaults in `defaults.ts` and inside the detectors (noise floor,
 * erosion, search window, taper kernels, area caps) were tuned on an adult
 * C57BL/6 mouse in the Barnes sample clips, which image the platform at
 * 4.56–4.83 px/cm. A different camera or mount changes `pxPerCm`; a different
 * rodent (rat, juvenile mouse, hamster, vole) changes physical body area,
 * body thickness, speed, and whether a long thin tail is present.
 *
 * Lengths scale by `s`, areas by `s²`. Ratios (`maxAreaRatio`,
 * `partialAreaRatio`) and gray levels are already scale-free.
 */

import type { TrackingParams } from '../types';

/** The scale the pixel defaults were tuned at: the sample clips' mean, rounded. */
export const REFERENCE_PX_PER_CM = 4.7;

/**
 * Physical morphology of the tracked rodent, independent of camera scale.
 * Defaults to `MOUSE_PROFILE` so existing mouse setups need no changes.
 */
export interface AnimalProfile {
  readonly id: string;
  /** Expected top-down body area (roughly excluding thin tail), cm². */
  readonly bodyAreaCm2: number;
  /** Approximate half-width of the torso at its thickest, cm. */
  readonly bodyHalfWidthCm: number;
  /** Upper bound on plausible speed, cm/s, used for displacement gates. */
  readonly maxSpeedCmPerS: number;
  /** Whether the rodent has a long thin tail that separates nose from tail. */
  readonly hasTail: boolean;
}

/** Adult laboratory mouse (e.g. C57BL/6, BALB/c), matching the sample clips (~34 cm²). */
export const MOUSE_PROFILE: AnimalProfile = {
  id: 'mouse',
  bodyAreaCm2: 34,
  bodyHalfWidthCm: 2.1,
  maxSpeedCmPerS: 183,
  hasTail: true,
};

/** Adult laboratory rat (e.g. Sprague-Dawley, Long-Evans, Wistar). */
export const RAT_PROFILE: AnimalProfile = {
  id: 'rat',
  bodyAreaCm2: 160,
  bodyHalfWidthCm: 4.0,
  maxSpeedCmPerS: 220,
  hasTail: true,
};

/** Small juvenile mouse / pup. */
export const JUVENILE_MOUSE_PROFILE: AnimalProfile = {
  id: 'juvenile-mouse',
  bodyAreaCm2: 14,
  bodyHalfWidthCm: 1.4,
  maxSpeedCmPerS: 120,
  hasTail: true,
};

/** Short-tailed or tailless rodent (e.g. hamster, vole, guinea pig). */
export const SHORT_TAILED_PROFILE: AnimalProfile = {
  id: 'short-tailed',
  bodyAreaCm2: 65,
  bodyHalfWidthCm: 3.2,
  maxSpeedCmPerS: 140,
  hasTail: false,
};

/** How much bigger (above 1) or smaller a centimeter is here than on the sample clips. */
export function sizeScaleFor(pxPerCm: number): number {
  if (!(pxPerCm > 0)) throw new RangeError('pxPerCm must be positive');
  return pxPerCm / REFERENCE_PX_PER_CM;
}

/** Linear size ratio of `animal` relative to the reference adult mouse (1 for `MOUSE_PROFILE`). */
export function animalSizeScale(animal?: AnimalProfile): number {
  if (!animal) return 1;
  if (!(animal.bodyAreaCm2 > 0)) throw new RangeError('animal.bodyAreaCm2 must be positive');
  return Math.sqrt(animal.bodyAreaCm2 / MOUSE_PROFILE.bodyAreaCm2);
}

/** Torso half-width ratio of `animal` relative to the reference adult mouse (1 for `MOUSE_PROFILE`). */
export function animalWidthScale(animal?: AnimalProfile): number {
  if (!animal) return 1;
  if (!(animal.bodyHalfWidthCm > 0)) throw new RangeError('animal.bodyHalfWidthCm must be positive');
  return animal.bodyHalfWidthCm / MOUSE_PROFILE.bodyHalfWidthCm;
}

export function scaleTrackingParams(params: TrackingParams, sizeScale: number, animal?: AnimalProfile): TrackingParams {
  const animalLinear = animalSizeScale(animal);
  const widthLinear = animalWidthScale(animal);
  const areaScale = (sizeScale * animalLinear) ** 2;
  const erodeScale = sizeScale * widthLinear;
  if (sizeScale === 1 && animalLinear === 1 && widthLinear === 1) return params;
  return {
    ...params,
    minBlobPx: Math.max(1, Math.round(params.minBlobPx * areaScale)),
    bodyCoreErodePx: Math.max(0, Math.round(params.bodyCoreErodePx * erodeScale)),
    holeLockRadiusPx: params.holeLockRadiusPx * sizeScale,
  };
}
