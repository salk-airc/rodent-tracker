/** Detect an evenly spaced hole ring from its circular intensity profile. */

import { sampleBilinear, type Gray } from '../../../image/imageOps';
import type { Point } from '../types';
import { median } from '../../../stats';

/** Hole counts worth testing. Real mazes are usually 12, 18, 20 or 40. */
export const CANDIDATE_HOLE_COUNTS = [12, 16, 18, 20, 24, 40] as const;

const ANGULAR_SAMPLES = 720;
const MIN_RADIUS_FRACTION = 0.6;
const MAX_RADIUS_FRACTION = 0.99;
const RADIUS_STEP_FRACTION = 0.0025;
/** Harmonics summed to normalize the symmetry score. */
const NORMALIZING_HARMONICS = 64;
/**
 * Thresholds below which the ring is reported as not found.
 *
 * Both thresholds are measurement-based. Searching many radii and hole counts
 * raises the best symmetry score even for a featureless synthetic disk.
 *
 *   featureless disk, varying noise:  symmetry 0.31-0.43, prominence 2.7-4.1
 *   synthetic disk with 20 holes:     symmetry 0.73-0.94, prominence 7.0-8.0
 *   the three sample clips:           symmetry 0.76-0.78, prominence 42-54
 *
 * Both conditions have to pass, because each catches a case the other misses:
 * a strong lighting gradient across the platform sinks the symmetry score
 * while leaving prominence high, and noise inflates prominence while symmetry
 * stays low.
 */
const MIN_SYMMETRY = 0.55;
const MIN_PROMINENCE = 5;

export interface RingFit {
  readonly holeCount: number;
  readonly ringRadiusPx: number;
  readonly ringRadiusFraction: number;
  /** Angle of hole 0, radians. */
  readonly phaseRad: number;
  /**
   * Share of the angular signal's total power that sits in the hole harmonic,
   * 0..1. About 0.76 on the sample clips.
   *
   * Read this together with {@link RingFit.prominence}, not on its own: the
   * value reported is the best of several hundred candidate fits, so it is a
   * maximum over a search and is biased upward even when there is no ring
   * there at all.
   */
  readonly symmetry: number;
  /**
   * The winning score divided by the typical score across all radii tried at
   * the same hole count.
   *
   * Distinguishes a localized ring peak from a maximum produced by searching
   * many candidates. Prominence is near 1 for a featureless disk and above 2
   * when a ring is present.
   */
  readonly prominence: number;
  /** Peak-to-peak intensity swing at the ring, in gray levels. */
  readonly contrast: number;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Intensity sampled around a circle, mean removed.
 */
function angularProfile(img: Gray, center: Point, radius: number): Float64Array {
  const out = new Float64Array(ANGULAR_SAMPLES);
  let sum = 0;
  for (let k = 0; k < ANGULAR_SAMPLES; k++) {
    const th = (k * 2 * Math.PI) / ANGULAR_SAMPLES;
    const v = sampleBilinear(img, center.x + radius * Math.cos(th), center.y + radius * Math.sin(th));
    out[k] = v;
    sum += v;
  }
  const mean = sum / ANGULAR_SAMPLES;
  for (let k = 0; k < ANGULAR_SAMPLES; k++) out[k] = out[k]! - mean;
  return out;
}

/**
 * One DFT coefficient of an evenly sampled periodic signal.
 * Only a few bins are ever needed, so this is cheaper and clearer than an FFT.
 */
function dftBin(profile: Float64Array, harmonic: number): { re: number; im: number } {
  const n = profile.length;
  let re = 0;
  let im = 0;
  const step = (-2 * Math.PI * harmonic) / n;
  for (let k = 0; k < n; k++) {
    const a = step * k;
    re += profile[k]! * Math.cos(a);
    im += profile[k]! * Math.sin(a);
  }
  return { re, im };
}

function totalHarmonicPower(profile: Float64Array, maxHarmonic: number): number {
  let p = 0;
  for (let h = 1; h <= maxHarmonic; h++) {
    const { re, im } = dftBin(profile, h);
    p += re * re + im * im;
  }
  return p;
}

/**
 * Locate the hole ring. `holeCount` pins the count; leave it undefined to let
 * the detector choose among {@link CANDIDATE_HOLE_COUNTS}.
 */
export function fitRing(
  img: Gray,
  center: Point,
  platformRadiusPx: number,
  holeCount?: number,
): RingFit {
  const counts = holeCount ? [holeCount] : Array.from(CANDIDATE_HOLE_COUNTS);
  let best: RingFit | null = null;
  /** Every score tried at the winning hole count, for the prominence ratio. */
  let bestCountScores: number[] = [];
  let scoresForCount: number[] = [];

  for (const n of counts) {
    scoresForCount = [];
    for (let f = MIN_RADIUS_FRACTION; f <= MAX_RADIUS_FRACTION; f += RADIUS_STEP_FRACTION) {
      const radius = platformRadiusPx * f;
      const profile = angularProfile(img, center, radius);
      const { re, im } = dftBin(profile, n);
      const power = re * re + im * im;
      const total = totalHarmonicPower(profile, NORMALIZING_HARMONICS);
      if (total <= 0) continue;
      const symmetry = Math.sqrt(power / total);
      scoresForCount.push(symmetry);

      if (!best || symmetry > best.symmetry) {
        bestCountScores = scoresForCount;
        // The profile is a cosine with minima at the holes, since holes are
        // dark: profile ~ -A*cos(n*(theta - theta0)). For that signal the DFT
        // coefficient has argument (pi - n*theta0), so theta0 follows directly.
        const arg = Math.atan2(im, re);
        let phase = (Math.PI - arg) / n;
        const spacing = (2 * Math.PI) / n;
        phase = ((phase % spacing) + spacing) % spacing;

        const amplitude = (2 * Math.sqrt(power)) / ANGULAR_SAMPLES;
        best = {
          holeCount: n,
          ringRadiusPx: radius,
          ringRadiusFraction: f,
          phaseRad: phase,
          symmetry,
          prominence: Number.NaN, // filled in below, once the search is done
          contrast: 2 * amplitude,
          warnings: [],
        };
      }
    }
    // `bestCountScores` may have been captured mid-sweep; finish the record so
    // the prominence denominator covers every radius tried at that hole count.
    if (best?.holeCount === n) bestCountScores = scoresForCount;
  }

  if (!best) {
    return {
      holeCount: holeCount ?? 20,
      ringRadiusPx: platformRadiusPx * 0.92,
      ringRadiusFraction: 0.92,
      phaseRad: 0,
      symmetry: 0,
      prominence: 0,
      contrast: 0,
      warnings: ['Hole ring not detected. Adjust it with the ring controls.'],
    };
  }

  const found: RingFit = best;
  const typical = median(bestCountScores);
  const prominence = typical > 0 ? found.symmetry / typical : 0;

  const warnings: string[] = [];
  if (prominence < MIN_PROMINENCE || found.symmetry < MIN_SYMMETRY) {
    warnings.push(
      `No clear hole ring: strength ${found.symmetry.toFixed(2)}, prominence ${prominence.toFixed(0)}x. ` +
        'Check the overlay and adjust the ring if needed.',
    );
  }
  if (found.ringRadiusFraction > 0.985) {
    warnings.push(
      'Hole ring is at the platform edge. Check the platform radius.',
    );
  }
  return { ...found, prominence, warnings };
}


/** Ideal hole centers implied by a ring fit, before local refinement. */
export function ringHoleCenters(center: Point, fit: Pick<RingFit, 'holeCount' | 'ringRadiusPx' | 'phaseRad'>): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < fit.holeCount; i++) {
    const th = fit.phaseRad + (i * 2 * Math.PI) / fit.holeCount;
    out.push({ x: center.x + fit.ringRadiusPx * Math.cos(th), y: center.y + fit.ringRadiusPx * Math.sin(th) });
  }
  return out;
}
