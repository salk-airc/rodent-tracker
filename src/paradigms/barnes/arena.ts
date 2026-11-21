/**
 * The Barnes maze's arena: the platform, its ring of holes and the ring's
 * rotation, found in the background image (Simon's detection in
 * `geometry/`), and the same maze as a generic engine arena.
 */

import type { Arena, Zone } from '../../arena/arena';
import type { ArenaFit } from '../../arena/find/types';
import type { Gray } from '../../image/imageOps';
import { detectGeometry, type DetectOptions } from './geometry/detect';
import { DEFAULT_PARAMS } from './params';
import { holeNumber, pxPerCm, type MazeGeometry } from './types';

export interface BarnesArenaOptions extends DetectOptions {
  /** Radius around each hole that counts as investigating it, cm. Default from `DEFAULT_PARAMS`. */
  readonly holeRadiusCm?: number;
}

/** The Barnes maze's arena finder: the platform, its holes and the ring's rotation. */
export function findBarnesArena(background: Gray, options: BarnesArenaOptions = {}): ArenaFit & { readonly geometry: MazeGeometry } {
  const { holeRadiusCm = DEFAULT_PARAMS.events.investigationRadiusCm, ...detect } = options;
  const { geometry, platform } = detectGeometry(background, detect);
  const scale = pxPerCm(geometry);
  const found = Number.isFinite(platform.residualPx);
  const rim = Math.max(0, 1 - platform.residualPx / Math.max(2, 0.03 * platform.radiusPx)) * platform.edgeCoverage;
  return {
    geometry,
    arena: found ? barnesArena(geometry, holeRadiusCm) : null,
    // Both the rim and the ring of holes have to be clean.
    confidence: found ? Math.min(rim, geometry.fit.ringSymmetry) : 0,
    landmarks: geometry.holes.map((h) => ({
      image: h.center,
      world: { x: (h.center.x - geometry.center.x) / scale, y: (h.center.y - geometry.center.y) / scale },
    })),
    warnings: geometry.fit.warnings,
  };
}

/**
 * The maze as a generic arena: the platform as the boundary, world origin at
 * its center, and a zone per hole of the investigation radius. Lets generic
 * tools (zone measures, overlays) work on a Barnes recording.
 */
export function barnesArena(geometry: MazeGeometry, holeRadiusCm: number): Arena {
  const scale = pxPerCm(geometry);
  const zones: Zone[] = geometry.holes.map((hole) => {
    const n = holeNumber(geometry, hole.index);
    return {
      id: `hole-${n}`,
      name: hole.index === geometry.targetHoleIndex ? `Hole ${n} (target)` : `Hole ${n}`,
      shape: {
        kind: 'circle',
        center: { x: (hole.center.x - geometry.center.x) / scale, y: (hole.center.y - geometry.center.y) / scale },
        radius: holeRadiusCm,
      },
    };
  });
  return {
    boundary: { kind: 'circle', center: { x: 0, y: 0 }, radius: geometry.platformDiameterCm / 2 },
    calibration: { kind: 'scale', pxPerCm: scale, originPx: geometry.center },
    zones,
  };
}
