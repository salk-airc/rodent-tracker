/**
 * Plane shapes for arenas and zones.
 *
 * Shapes carry no unit. An arena's boundary and zones are written in world
 * centimeters (see `calibration.ts`), so the same template fits any camera.
 */

import type { Point } from '../types';

export type Shape =
  | { readonly kind: 'circle'; readonly center: Point; readonly radius: number }
  /** Axis-aligned in its own coordinates. Rotate with a polygon instead. */
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** A simple polygon (edges must not cross). Either winding order. */
  | { readonly kind: 'polygon'; readonly points: ReadonlyArray<Point> }
  /** A ring, such as the periphery of a round open field. */
  | { readonly kind: 'annulus'; readonly center: Point; readonly inner: number; readonly outer: number };

export function contains(shape: Shape, p: Point): boolean {
  switch (shape.kind) {
    case 'circle':
      return (p.x - shape.center.x) ** 2 + (p.y - shape.center.y) ** 2 <= shape.radius ** 2;
    case 'rect':
      return p.x >= shape.x && p.x <= shape.x + shape.width && p.y >= shape.y && p.y <= shape.y + shape.height;
    case 'annulus': {
      const d2 = (p.x - shape.center.x) ** 2 + (p.y - shape.center.y) ** 2;
      return d2 >= shape.inner ** 2 && d2 <= shape.outer ** 2;
    }
    case 'polygon':
      return inPolygon(shape.points, p);
  }
}

/** Even-odd ray cast. Points exactly on an edge may land either side. */
function inPolygon(pts: ReadonlyArray<Point>, p: Point): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'rect':
      return shape.width * shape.height;
    case 'annulus':
      return Math.PI * (shape.outer ** 2 - shape.inner ** 2);
    case 'polygon': {
      let twice = 0;
      const pts = shape.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) twice += pts[j]!.x * pts[i]!.y - pts[i]!.x * pts[j]!.y;
      return Math.abs(twice) / 2;
    }
  }
}

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function bounds(shape: Shape): Box {
  switch (shape.kind) {
    case 'circle':
      return { minX: shape.center.x - shape.radius, minY: shape.center.y - shape.radius, maxX: shape.center.x + shape.radius, maxY: shape.center.y + shape.radius };
    case 'annulus':
      return { minX: shape.center.x - shape.outer, minY: shape.center.y - shape.outer, maxX: shape.center.x + shape.outer, maxY: shape.center.y + shape.outer };
    case 'rect':
      return { minX: shape.x, minY: shape.y, maxX: shape.x + shape.width, maxY: shape.y + shape.height };
    case 'polygon':
      return {
        minX: Math.min(...shape.points.map((p) => p.x)),
        minY: Math.min(...shape.points.map((p) => p.y)),
        maxX: Math.max(...shape.points.map((p) => p.x)),
        maxY: Math.max(...shape.points.map((p) => p.y)),
      };
  }
}

/** Shortest distance from `p` to the shape's outline, whether `p` is inside or out. */
export function distanceToEdge(shape: Shape, p: Point): number {
  switch (shape.kind) {
    case 'circle':
      return Math.abs(Math.hypot(p.x - shape.center.x, p.y - shape.center.y) - shape.radius);
    case 'annulus': {
      const r = Math.hypot(p.x - shape.center.x, p.y - shape.center.y);
      return Math.min(Math.abs(r - shape.inner), Math.abs(r - shape.outer));
    }
    case 'rect':
      return distanceToEdge(rectToPolygon(shape), p);
    case 'polygon': {
      let best = Number.POSITIVE_INFINITY;
      const pts = shape.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) best = Math.min(best, segmentDistance(p, pts[j]!, pts[i]!));
      return best;
    }
  }
}

export function rectToPolygon(r: Extract<Shape, { kind: 'rect' }>): Extract<Shape, { kind: 'polygon' }> {
  return {
    kind: 'polygon',
    points: [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
      { x: r.x, y: r.y + r.height },
    ],
  };
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
