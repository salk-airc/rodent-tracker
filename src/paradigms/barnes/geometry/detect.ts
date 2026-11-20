/**
 * Putting the maze together: platform, then ring, then holes.
 */

import { fitPlatform, type PlatformFit } from './platform';
import { fitRing, ringHoleCenters, type RingFit } from './ring';
import { platformBrightness, refineHoles } from './holes';
import type { Gray } from '../../../image/imageOps';
import type { Hole, MazeGeometry, PlatformDiameterSource, Point, Provenance } from '../types';

/**
 * A 36-inch circular platform, the common mouse configuration. Wrong for some
 * rigs, which is why it is a labeled field the user confirms once per rig
 * rather than a constant. Everything reported in centimeters scales linearly
 * with it.
 */
export const DEFAULT_PLATFORM_DIAMETER_CM = 91.5;

export interface DetectOptions {
  /** Pin the hole count, or leave undefined to detect it. */
  readonly holeCount?: number;
  readonly platformDiameterCm?: number;
  readonly platformDiameterSource?: PlatformDiameterSource;
  /** Reuse a previously confirmed rig: see {@link applyTemplate}. */
  readonly provenance?: Provenance;
}

export interface DetectResult {
  readonly geometry: MazeGeometry;
  readonly platform: PlatformFit;
  readonly ring: RingFit;
  readonly platformLevel: number;
}

/**
 * Recover the maze from an animal-free reference image.
 *
 * Runs on the background image rather than on a video frame, so the animal is
 * never sitting on a hole while we try to find it.
 */
export function detectGeometry(background: Gray, opts: DetectOptions = {}): DetectResult {
  const platform = fitPlatform(background);
  const ring = fitRing(background, platform.center, platform.radiusPx, opts.holeCount);
  const platformLevel = platformBrightness(background, platform.center, platform.radiusPx);
  const predicted = ringHoleCenters(platform.center, ring);
  const refined = refineHoles(background, platform.center, predicted, platformLevel, opts.provenance ?? 'auto');

  const warnings = [...platform.warnings, ...ring.warnings, ...refined.warnings];

  // The reported ring is re-derived from the refined holes, not from the
  // initial harmonic fit. The harmonic fit finds the radius where the periodic
  // pattern is strongest, which is not quite the mean hole center when the
  // camera is off-axis and the holes near the rim appear as partial ellipses.
  // Downstream code uses the refined holes, so the summary numbers and the
  // rig template should describe those same holes.
  const consolidated = consolidateRing(platform.center, refined.holes, ring);

  const geometry: MazeGeometry = {
    center: { x: roundDetectedValue(platform.center.x), y: roundDetectedValue(platform.center.y) },
    platformRadiusPx: roundDetectedValue(platform.radiusPx),
    ringRadiusPx: roundDetectedValue(consolidated.ringRadiusPx),
    phaseRad: roundDetectedValue(consolidated.phaseRad),
    holeCount: ring.holeCount,
    holes: refined.holes.map((hole) => ({
      ...hole,
      center: { x: roundDetectedValue(hole.center.x), y: roundDetectedValue(hole.center.y) },
      radiusPx: roundDetectedValue(hole.radiusPx),
    })),
    targetHoleIndex: null,
    targetProvenance: 'auto',
    platformDiameterCm: opts.platformDiameterCm ?? DEFAULT_PLATFORM_DIAMETER_CM,
    platformDiameterSource:
      opts.platformDiameterSource ?? (opts.platformDiameterCm === undefined ? 'default' : 'manual'),
    provenance: opts.provenance ?? 'auto',
    fit: {
      platformResidualPx: roundDetectedValue(platform.residualPx),
      ringSymmetry: roundDetectedValue(ring.symmetry),
      ringRadiusFraction: roundDetectedValue(consolidated.ringRadiusPx / platform.radiusPx),
      warnings,
    },
  };

  return { geometry, platform, ring, platformLevel };
}

// Automatic fits can differ by ~1e-12 between CPU architectures. Store nine
// decimals before tracking so that roundoff does not change geometry identity.
// Manual edits and provenance comparisons retain their exact values.
function roundDetectedValue(value: number): number {
  return Number(value.toFixed(9));
}

/**
 * Median ring radius and mean phase of the refined holes.
 *
 * Phase is averaged as a vector so that holes either side of the wrap point do
 * not average to the opposite side of the ring.
 */
function consolidateRing(
  center: Point,
  holes: ReadonlyArray<Hole>,
  ring: RingFit,
): { ringRadiusPx: number; phaseRad: number } {
  if (holes.length === 0) return { ringRadiusPx: ring.ringRadiusPx, phaseRad: ring.phaseRad };

  const radii = holes
    .map((h) => Math.hypot(h.center.x - center.x, h.center.y - center.y))
    .sort((a, b) => a - b);
  const ringRadiusPx =
    radii.length % 2 ? radii[radii.length >> 1]! : (radii[radii.length / 2 - 1]! + radii[radii.length / 2]!) / 2;

  const spacing = (2 * Math.PI) / holes.length;
  let sx = 0;
  let sy = 0;
  for (const h of holes) {
    const theta = Math.atan2(h.center.y - center.y, h.center.x - center.x);
    // Residual angle of this hole from its ideal slot, scaled up so that a
    // full hole spacing maps to a full turn before averaging.
    const residual = (theta - h.index * spacing) * holes.length;
    sx += Math.cos(residual);
    sy += Math.sin(residual);
  }
  let phaseRad = Math.atan2(sy, sx) / holes.length;
  phaseRad = ((phaseRad % spacing) + spacing) % spacing;
  return { ringRadiusPx, phaseRad };
}

// ---------------------------------------------------------------------------
// Rig templates
// ---------------------------------------------------------------------------

/**
 * Apparatus settings that can be reused across recordings.
 *
 * Camera-relative geometry is detected for each video. The template retains
 * only the hole count, physical platform size, and target-hole index, then
 * checks whether the detected rig moved relative to its reference geometry.
 */
export interface RigTemplate {
  readonly id: string;
  readonly name: string;
  readonly holeCount: number;
  readonly platformDiameterCm: number;
  readonly targetHoleIndex: number | null;
  readonly holeOneIndex?: number;
  readonly holeNumbering?: MazeGeometry['holeNumbering'];
  /** Reference geometry, used to detect that the rig has moved. */
  readonly reference: {
    readonly center: Point;
    readonly platformRadiusPx: number;
    readonly ringRadiusFraction: number;
    readonly phaseRad: number;
  };
  readonly createdAt: string;
}

export function templateFromGeometry(id: string, name: string, g: MazeGeometry): RigTemplate {
  return {
    id,
    name,
    holeCount: g.holeCount,
    platformDiameterCm: g.platformDiameterCm,
    targetHoleIndex: g.targetHoleIndex,
    holeOneIndex: g.holeOneIndex,
    holeNumbering: g.holeNumbering,
    reference: {
      center: g.center,
      platformRadiusPx: g.platformRadiusPx,
      ringRadiusFraction: g.ringRadiusPx / g.platformRadiusPx,
      phaseRad: g.phaseRad,
    },
    createdAt: new Date().toISOString(),
  };
}

export interface TemplateMatch {
  readonly geometry: MazeGeometry;
  /** True when the freshly detected geometry agrees with the template. */
  readonly agrees: boolean;
  readonly centerShiftPx: number;
  readonly radiusChangePx: number;
  readonly phaseShiftDeg: number;
  readonly notes: ReadonlyArray<string>;
}

/**
 * Re-detect this video's geometry with the template's hole count and scale,
 * then report how far the rig has moved.
 *
 * The target hole is carried across by ring index. That is only meaningful if
 * the ring's rotation has not changed, so a phase shift of more than half a
 * hole spacing drops the target rather than silently pointing at the wrong
 * hole — an error that would invert every latency in the file.
 */
export function applyTemplate(background: Gray, template: RigTemplate): TemplateMatch {
  const { geometry } = detectGeometry(background, {
    holeCount: template.holeCount,
    platformDiameterCm: template.platformDiameterCm,
    platformDiameterSource: 'template',
    provenance: 'template',
  });

  const centerShiftPx = Math.hypot(
    geometry.center.x - template.reference.center.x,
    geometry.center.y - template.reference.center.y,
  );
  const radiusChangePx = geometry.platformRadiusPx - template.reference.platformRadiusPx;

  const spacing = (2 * Math.PI) / geometry.holeCount;
  let phaseShift = geometry.phaseRad - template.reference.phaseRad;
  phaseShift = ((phaseShift + spacing / 2) % spacing + spacing) % spacing - spacing / 2;
  const phaseShiftDeg = (phaseShift * 180) / Math.PI;

  const notes: string[] = [];
  const rigMoved = centerShiftPx > 8 || Math.abs(radiusChangePx) > 8;
  if (rigMoved) {
    notes.push(
      `Platform has moved from “${template.name}”: center ${centerShiftPx.toFixed(1)} px, radius ` +
        `${Math.abs(radiusChangePx).toFixed(1)} px. Outline re-detected.`,
    );
  }

  const spacingDeg = 360 / geometry.holeCount;
  const phaseTrustworthy = Math.abs(phaseShiftDeg) < spacingDeg / 4;
  let targetHoleIndex = template.targetHoleIndex;
  let targetProvenance: Provenance = 'template';
  // Hole indices are only comparable when the ring has not rotated.
  const numbering = phaseTrustworthy
    ? { holeOneIndex: template.holeOneIndex, holeNumbering: template.holeNumbering }
    : {};
  if (!phaseTrustworthy) {
    targetHoleIndex = null;
    targetProvenance = 'auto';
    notes.push(
      `Ring rotated ${phaseShiftDeg.toFixed(1)}° from “${template.name}”. ` +
        (template.holeOneIndex === undefined
          ? 'Target hole was cleared; set it for this video.'
          : 'Target hole and hole numbering were cleared; set them for this video.'),
    );
  }

  return {
    geometry: { ...geometry, targetHoleIndex, targetProvenance, ...numbering },
    agrees: !rigMoved && phaseTrustworthy,
    centerShiftPx,
    radiusChangePx,
    phaseShiftDeg,
    notes,
  };
}
