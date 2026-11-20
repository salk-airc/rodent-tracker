/**
 * An arena: where the animal can be, how image pixels map to centimeters, and
 * the named zones a paradigm scores.
 *
 * The boundary and zones are in world cm, so a template (a 40 × 40 cm open
 * field with a 20 × 20 cm center) is written once and fitted to each camera
 * by its calibration alone.
 */

import type { Point } from '../types';
import { contains, type Shape } from './shapes';
import { pxPerCmAt, toImage, toWorld, type Calibration } from './calibration';

export interface Zone {
  /** Stable id used in exports, e.g. `center`, `open-arm-north`. */
  readonly id: string;
  readonly name: string;
  readonly shape: Shape;
}

export interface Arena {
  /** Where the animal can be. Detection ignores pixels outside it. */
  readonly boundary: Shape;
  readonly calibration: Calibration;
  readonly zones: ReadonlyArray<Zone>;
}

/** 1 for each image pixel whose center lies inside the arena boundary, else 0. */
export function arenaMask(arena: Pick<Arena, 'boundary' | 'calibration'>, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (contains(arena.boundary, toWorld(arena.calibration, { x: x + 0.5, y: y + 0.5 }))) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** The arena's center in image px: the world-space bounding-box center, mapped back. */
export function arenaCenterPx(arena: Pick<Arena, 'boundary' | 'calibration'>): Point {
  const b = arena.boundary;
  const world =
    b.kind === 'circle' || b.kind === 'annulus'
      ? b.center
      : b.kind === 'rect'
        ? { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        : {
            x: b.points.reduce((s, p) => s + p.x, 0) / b.points.length,
            y: b.points.reduce((s, p) => s + p.y, 0) / b.points.length,
          };
  return toImage(arena.calibration, world);
}

/** Pixels per cm at the arena center: what detectors scale their sizes by. */
export function arenaPxPerCm(arena: Pick<Arena, 'boundary' | 'calibration'>): number {
  return pxPerCmAt(arena.calibration, arenaCenterPx(arena));
}

export function zonesAt(arena: Pick<Arena, 'zones'>, worldPoint: Point): string[] {
  return arena.zones.filter((z) => contains(z.shape, worldPoint)).map((z) => z.id);
}

// --- templates ------------------------------------------------------------

/**
 * Square or rectangular open field, world origin at the top-left corner.
 * The center zone is the middle `centerFraction` of each side (0.5 gives the
 * common "central 25% of the area").
 */
export function openFieldZones(widthCm: number, heightCm: number, centerFraction = 0.5): { boundary: Shape; zones: Zone[] } {
  const cw = widthCm * centerFraction;
  const ch = heightCm * centerFraction;
  const center: Shape = { kind: 'rect', x: (widthCm - cw) / 2, y: (heightCm - ch) / 2, width: cw, height: ch };
  return {
    boundary: { kind: 'rect', x: 0, y: 0, width: widthCm, height: heightCm },
    zones: [{ id: 'center', name: 'Center', shape: center }],
  };
}

/** Round arena centered on the world origin, with a center disc and the periphery ring around it. */
export function roundArenaZones(diameterCm: number, centerFraction = 0.5): { boundary: Shape; zones: Zone[] } {
  const r = diameterCm / 2;
  const center = { x: 0, y: 0 };
  return {
    boundary: { kind: 'circle', center, radius: r },
    zones: [
      { id: 'center', name: 'Center', shape: { kind: 'circle', center, radius: r * centerFraction } },
      { id: 'periphery', name: 'Periphery', shape: { kind: 'annulus', center, inner: r * centerFraction, outer: r } },
    ],
  };
}
