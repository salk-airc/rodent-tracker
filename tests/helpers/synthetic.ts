/**
 * Builders for synthetic trials.
 *
 * The interpretation layer is pure, so it can be tested exhaustively without
 * any video: we can write down a trial where the animal does exactly one thing
 * and check that exactly one event comes out.
 */

import type { AnalysisParams, Hole, MazeGeometry, Point, TrackFrame, Timebase } from '../../src/types';
import { DEFAULT_PARAMS } from '../../src/params';

export const CENTER: Point = { x: 320, y: 240 };
export const PLATFORM_R = 208;
export const RING_R = 185;
export const HOLE_COUNT = 20;

export function makeGeometry(targetHoleIndex: number | null = null, diameterCm = 91.5): MazeGeometry {
  const holes: Hole[] = [];
  for (let i = 0; i < HOLE_COUNT; i++) {
    const th = (i * 2 * Math.PI) / HOLE_COUNT;
    holes.push({
      index: i,
      center: { x: CENTER.x + RING_R * Math.cos(th), y: CENTER.y + RING_R * Math.sin(th) },
      radiusPx: 12,
      provenance: 'auto',
    });
  }
  return {
    center: CENTER,
    platformRadiusPx: PLATFORM_R,
    ringRadiusPx: RING_R,
    phaseRad: 0,
    holeCount: HOLE_COUNT,
    holes,
    targetHoleIndex,
    targetProvenance: 'auto',
    platformDiameterCm: diameterCm,
    platformDiameterSource: 'manual',
    provenance: 'auto',
    fit: { platformResidualPx: 0.3, ringSymmetry: 0.8, ringRadiusFraction: RING_R / PLATFORM_R, warnings: [] },
  };
}

/** A constant-rate timebase, for tests that are not about timing defects. */
export function makeTimebase(frameCount: number, fps = 30, timescale = 15360): Timebase {
  const delta = Math.round(timescale / fps);
  const ptsTicks: number[] = [];
  for (let i = 0; i < frameCount; i++) ptsTicks.push(i * delta);
  return { timescale, ptsTicks };
}

export const PX_PER_CM = (2 * PLATFORM_R) / 91.5;

/** Position `cm` centimeters outward from a hole, along the radius. */
export function nearHole(index: number, cm: number): Point {
  const geometry = makeGeometry();
  const h = geometry.holes[index]!.center;
  const th = Math.atan2(h.y - CENTER.y, h.x - CENTER.x);
  return { x: h.x + Math.cos(th) * cm * PX_PER_CM, y: h.y + Math.sin(th) * cm * PX_PER_CM };
}

export interface FrameSpec {
  readonly nose: Point;
  readonly body?: Point;
  readonly areaPx?: number;
  readonly status?: TrackFrame['status'];
  readonly holeIndex?: number | null;
  readonly provenance?: TrackFrame['provenance'];
}

/** Area of a whole mouse in the synthetic scenes, in pixels. */
export const BODY_AREA_PX = 700;

export function makeFrames(specs: ReadonlyArray<FrameSpec>, bodyAreaPx = BODY_AREA_PX): TrackFrame[] {
  return specs.map((s, i) => ({
    frame: i,
    status: s.status ?? 'tracked',
    body: s.body ?? s.nose,
    nose: s.nose,
    areaPx: s.areaPx ?? bodyAreaPx,
    areaMeasured: true,
    holeIndex: s.holeIndex ?? null,
    confidence: 1,
    interpolated: false,
    statusProvenance: s.provenance ?? 'auto',
    bodyProvenance: s.provenance ?? 'auto',
    noseProvenance: s.provenance ?? 'auto',
    provenance: s.provenance ?? 'auto',
  }));
}

/** Repeat a frame spec `n` times. */
export function hold(n: number, spec: FrameSpec): FrameSpec[] {
  return Array.from({ length: n }, () => spec);
}

export const params = (over: Partial<AnalysisParams> = {}): AnalysisParams => ({ ...DEFAULT_PARAMS, ...over });
