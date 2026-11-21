/**
 * A box arena: an open field, a light-dark box, a three-chamber social box.
 * The floor is the largest bright region; its four corners, matched to the
 * box's real width and height, give a perspective calibration, so a camera
 * that isn't straight overhead still measures in true centimeters.
 *
 * The corners are the floor's extreme points along the two diagonals, which
 * finds them reliably while the box is within about 30° of square to the
 * image. World origin is the corner nearest the image's top-left, x along the
 * top edge (`widthCm`), y down the left edge (`heightCm`).
 */

import { openFieldZones, type Zone } from '../arena';
import { homographyFromPoints, calibrationResidualCm, type Correspondence } from '../calibration';
import { connectedComponents, largestComponent, otsuThreshold } from '../../image/imageOps';
import type { Point } from '../../types';
import { noFit, type ArenaFinder } from './types';

export interface BoxArenaOptions {
  readonly widthCm: number;
  readonly heightCm: number;
  /** Zones in world cm, origin at the top-left corner. Default: the central quarter as `center`. */
  readonly zones?: ReadonlyArray<Zone>;
}

export const findBoxArena: ArenaFinder<BoxArenaOptions> = (background, options) => {
  const { widthCm, heightCm } = options;
  if (!(widthCm > 0 && heightCm > 0)) throw new RangeError('widthCm and heightCm must be positive');
  const { width, height, data } = background;

  const threshold = otsuThreshold(background);
  const bright = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) bright[i] = data[i]! > threshold ? 1 : 0;
  const cc = connectedComponents(bright, width, height, { minAreaPx: 200 });
  const floor = largestComponent(cc);
  if (!floor) return noFit('No bright floor found. Check the recording and lighting.');
  if (floor.areaPx > 0.9 * width * height) return noFit('The bright region fills the frame, so the box edges cannot be found.');

  // Extreme floor pixels along each diagonal.
  let tl = { x: 0, y: 0, s: Infinity };
  let br = { x: 0, y: 0, s: -Infinity };
  let tr = { x: 0, y: 0, s: -Infinity };
  let bl = { x: 0, y: 0, s: Infinity };
  for (let y = floor.minY; y <= floor.maxY; y++) {
    for (let x = floor.minX; x <= floor.maxX; x++) {
      if (cc.labels[y * width + x] !== floor.label) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < tl.s) tl = { x, y, s: sum };
      if (sum > br.s) br = { x, y, s: sum };
      if (diff > tr.s) tr = { x, y, s: diff };
      if (diff < bl.s) bl = { x, y, s: diff };
    }
  }
  // Pixel (x, y) is the point (x, y) and covers half a pixel either side: push
  // each corner pixel half a pixel outward, to the floor's edge.
  const corner = (p: { x: number; y: number }, dx: number, dy: number): Point => ({ x: p.x + dx / 2, y: p.y + dy / 2 });
  const landmarks: Correspondence[] = [
    { image: corner(tl, -1, -1), world: { x: 0, y: 0 } },
    { image: corner(tr, 1, -1), world: { x: widthCm, y: 0 } },
    { image: corner(br, 1, 1), world: { x: widthCm, y: heightCm } },
    { image: corner(bl, -1, 1), world: { x: 0, y: heightCm } },
  ];

  let calibration;
  try {
    calibration = homographyFromPoints(landmarks);
  } catch {
    return noFit('The floor\'s corners could not be told apart. Place the box by hand.');
  }

  const warnings: string[] = [];
  const quad = quadArea(landmarks.map((l) => l.image));
  const fill = quad > 0 ? floor.areaPx / quad : 0;
  if (fill < 0.9) warnings.push(`The floor fills ${(fill * 100).toFixed(0)}% of the box found. Shadows or objects may have cut into it; check the corners.`);
  if (floor.minX === 0 || floor.minY === 0 || floor.maxX === width - 1 || floor.maxY === height - 1) {
    warnings.push('The floor touches the edge of the frame, so part of the box may be out of view.');
  }
  const [a, b, , d] = landmarks.map((l) => l.image) as [Point, Point, Point, Point];
  const tilt = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (Math.abs(tilt) > 30) warnings.push(`The box is turned ${Math.abs(tilt).toFixed(0)}° in the image; corner finding is unreliable past about 30°.`);
  const imageAspect = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1e-9, Math.hypot(d.x - a.x, d.y - a.y));
  const worldAspect = widthCm / heightCm;
  const aspectError = Math.abs(Math.log(imageAspect / worldAspect));
  if (aspectError > Math.log(1.25)) {
    warnings.push(`The box looks ${imageAspect.toFixed(2)}:1 in the image but is ${worldAspect.toFixed(2)}:1. Check the width and height, and which side is which.`);
  }

  const confidence = Math.max(0, 1 - Math.abs(1 - fill) * 4) * (aspectError > Math.log(1.25) ? 0.5 : 1) * (Math.abs(tilt) > 30 ? 0.5 : 1);
  const template = openFieldZones(widthCm, heightCm);
  return {
    arena: { boundary: template.boundary, calibration, zones: options.zones ?? template.zones },
    confidence,
    landmarks,
    warnings: calibrationResidualCm(calibration, landmarks) > 0.5 ? [...warnings, 'The corner fit is inconsistent.'] : warnings,
  };
};

/** Shoelace area of a polygon. */
function quadArea(pts: ReadonlyArray<Point>): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}
