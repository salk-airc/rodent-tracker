/**
 * A round arena: a water-maze pool, an active place avoidance arena, a round
 * open field. One measurement, the diameter, is enough: the fitted circle
 * gives the center and the scale.
 *
 * Assumes the camera looks straight down, so the arena images as a circle. A
 * tilted camera images it as an ellipse; place it by its rim points instead.
 */

import { roundArenaZones, type Zone } from '../arena';
import type { Calibration } from '../calibration';
import { fitBrightDisc } from './disc';
import { noFit, type ArenaFinder } from './types';

export interface RoundArenaOptions {
  readonly diameterCm: number;
  /** Zones in world cm, origin at the arena center. Default: center disc and periphery ring. */
  readonly zones?: ReadonlyArray<Zone>;
  /** For the default zones: the center disc's radius over the arena's. Default 0.5. */
  readonly centerFraction?: number;
}

export const findRoundArena: ArenaFinder<RoundArenaOptions> = (background, options) => {
  if (!(options.diameterCm > 0)) throw new RangeError('diameterCm must be positive');
  const fit = fitBrightDisc(background);
  if (!Number.isFinite(fit.residualPx)) return noFit(fit.warnings[0] ?? 'No round arena found.');

  const radiusCm = options.diameterCm / 2;
  const calibration: Calibration = { kind: 'scale', pxPerCm: fit.radiusPx / radiusCm, originPx: fit.center };
  const template = roundArenaZones(options.diameterCm, options.centerFraction);
  // A clean rim traces nearly every ray and sits within a few px of the circle.
  const tightness = Math.max(0, 1 - fit.residualPx / Math.max(2, 0.03 * fit.radiusPx));
  const confidence = fit.edgeCoverage * tightness;
  const warnings = [...fit.warnings];
  if (fit.edgeCoverage < 0.8) warnings.push(`The rim was traced on ${(fit.edgeCoverage * 100).toFixed(0)}% of its circumference. Check for glare or objects on the edge.`);

  const rim = [0, 90, 180, 270].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return {
      image: { x: fit.center.x + fit.radiusPx * Math.cos(a), y: fit.center.y + fit.radiusPx * Math.sin(a) },
      world: { x: radiusCm * Math.cos(a), y: radiusCm * Math.sin(a) },
    };
  });
  return {
    arena: { boundary: template.boundary, calibration, zones: options.zones ?? template.zones },
    confidence,
    landmarks: rim,
    warnings,
  };
};
