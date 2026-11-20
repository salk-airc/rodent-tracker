/**
 * Mazes made of straight arms of equal width around a central hub: the
 * elevated plus maze (4 arms), the Y-maze (3) and the radial arm maze (8).
 *
 * World cm with the origin at the hub's center. Angles are in degrees in
 * image orientation: 0° points right, 90° points down, so increasing angles
 * go clockwise on screen. Arms are evenly spaced, starting at `firstArmDeg`.
 *
 * The hub is the regular polygon where the arms meet (a square for 4 arms, a
 * triangle for 3). Arm length is measured from the hub's edge to the arm's
 * end, as maze makers quote it.
 */

import type { Point } from '../types';
import type { Shape } from './shapes';
import type { Zone } from './arena';

export interface ArmSpec {
  readonly id: string;
  readonly name: string;
}

export interface ArmMazeOptions {
  readonly armLengthCm: number;
  readonly armWidthCm: number;
  /** Direction of the first arm. Default -90 (straight up in the image). */
  readonly firstArmDeg?: number;
  /**
   * How far past the hub's edge the body center must be to count as in an
   * arm, cm. Default 0. The strip in between counts as hub, so a mouse
   * peeking out of the center is not scored as an arm entry.
   */
  readonly entryMarginCm?: number;
}

/** A named point on the maze in world cm, for calibrating from clicks on the image. */
export interface Landmark {
  readonly id: string;
  readonly world: Point;
}

export interface ArmMazeLayout {
  readonly boundary: Shape;
  /** The hub (plus the entry margin), id `center`, then one zone per arm with the arm's id. */
  readonly zones: Zone[];
  /** Each arm's end: `<id>:tip` (middle), `<id>:left` and `<id>:right` (corners, seen from the hub). */
  readonly landmarks: Landmark[];
}

export function armMazeLayout(arms: ReadonlyArray<ArmSpec>, options: ArmMazeOptions): ArmMazeLayout {
  const n = arms.length;
  if (n < 3) throw new RangeError('an arm maze needs at least 3 arms');
  const { armLengthCm, armWidthCm } = options;
  if (!(armLengthCm > 0) || !(armWidthCm > 0)) throw new RangeError('arm length and width must be positive');
  const margin = options.entryMarginCm ?? 0;
  if (!(margin >= 0 && margin < armLengthCm)) throw new RangeError('entryMarginCm must be at least 0 and shorter than an arm');

  const half = armWidthCm / 2;
  // Distance from the center to the hub's edge across each arm's mouth.
  const hub = half / Math.tan(Math.PI / n);
  const end = hub + armLengthCm;
  const first = ((options.firstArmDeg ?? -90) * Math.PI) / 180;
  const round = (v: number) => Math.round(v * 1e9) / 1e9 + 0; // + 0 turns -0 into 0
  /** A point `along` cm out arm `i`'s axis and `across` cm to its side (+ is clockwise on screen). */
  const at = (i: number, along: number, across: number): Point => {
    const t = first + (2 * Math.PI * i) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return { x: round(along * c - across * s), y: round(along * s + across * c) };
  };

  const boundary: Point[] = [];
  const center: Point[] = [];
  const zones: Zone[] = [];
  const landmarks: Landmark[] = [];
  arms.forEach((arm, i) => {
    boundary.push(at(i, hub, -half), at(i, end, -half), at(i, end, half));
    center.push(at(i, hub, -half));
    if (margin > 0) center.push(at(i, hub + margin, -half), at(i, hub + margin, half));
    zones.push({
      id: arm.id,
      name: arm.name,
      shape: { kind: 'polygon', points: [at(i, hub + margin, -half), at(i, end, -half), at(i, end, half), at(i, hub + margin, half)] },
    });
    landmarks.push(
      { id: `${arm.id}:tip`, world: at(i, end, 0) },
      { id: `${arm.id}:left`, world: at(i, end, -half) },
      { id: `${arm.id}:right`, world: at(i, end, half) },
    );
  });
  return {
    boundary: { kind: 'polygon', points: boundary },
    zones: [{ id: 'center', name: 'Center', shape: { kind: 'polygon', points: center } }, ...zones],
    landmarks,
  };
}

/**
 * Elevated plus maze: two open arms facing each other and two closed (walled)
 * arms across them. Zone ids are `open-<side>` and `closed-<side>`, which the
 * elevated-plus paradigm groups by prefix. Mouse mazes are commonly 30 × 5 cm arms.
 */
export function elevatedPlusMaze(
  options: Partial<Omit<ArmMazeOptions, 'firstArmDeg'>> & { readonly openArms?: 'vertical' | 'horizontal' } = {},
): ArmMazeLayout {
  const openVertical = (options.openArms ?? 'vertical') === 'vertical';
  const kind = (vertical: boolean) => (vertical === openVertical ? 'open' : 'closed');
  const label = (k: string) => (k === 'open' ? 'Open' : 'Closed');
  const sides = [
    { side: 'north', vertical: true },
    { side: 'east', vertical: false },
    { side: 'south', vertical: true },
    { side: 'west', vertical: false },
  ];
  return armMazeLayout(
    sides.map(({ side, vertical }) => ({ id: `${kind(vertical)}-${side}`, name: `${label(kind(vertical))} arm (${side})` })),
    { armLengthCm: options.armLengthCm ?? 30, armWidthCm: options.armWidthCm ?? 5, firstArmDeg: -90, entryMarginCm: options.entryMarginCm ?? 0 },
  );
}

/**
 * Y-maze: three arms 120° apart, `A` pointing up, then `B` and `C` clockwise.
 * Mouse mazes are commonly 35 × 5 cm arms.
 */
export function yMaze(options: Partial<Omit<ArmMazeOptions, 'firstArmDeg'>> = {}): ArmMazeLayout {
  return armMazeLayout(
    ['A', 'B', 'C'].map((id) => ({ id, name: `Arm ${id}` })),
    { armLengthCm: options.armLengthCm ?? 35, armWidthCm: options.armWidthCm ?? 5, firstArmDeg: -90, entryMarginCm: options.entryMarginCm ?? 0 },
  );
}
