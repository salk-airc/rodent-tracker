import { describe, expect, it } from 'vitest';
import { openField, runningMedian } from '../src/paradigms/open-field';
import { barnesArena, barnesMaze } from '../src/paradigms/barnes';
import { openFieldZones } from '../src/arena/arena';
import { scaleFromTwoPoints, toImage } from '../src/arena/calibration';
import { silhouetteTaperDetector } from '../src/detect/silhouetteTaper';
import type { FrameSource, Point } from '../src/types';
import { makeGeometry, makeTimebase } from './helpers/synthetic';

const W = 320;
const H = 240;
const FLOOR = 200;

/** A 40 × 40 cm box at 5 px/cm, top-left corner at (60, 20) in the image. */
const field = openFieldZones(40, 40);
const arena = { ...field, calibration: scaleFromTwoPoints({ x: 60, y: 20 }, { x: 260, y: 20 }, 40) };

/** A synthetic recording: a mouse walking a path given in world cm, one point per frame. */
function recording(path: ReadonlyArray<Point | null>): FrameSource {
  const timebase = makeTimebase(path.length);
  const draw = (frame: number): Uint8Array => {
    const gray = new Uint8Array(W * H).fill(FLOOR);
    // Dark walls outside the box, like a real enclosure.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < 58 || x > 262 || y < 18 || y > 222) gray[y * W + x] = 30;
    const at = path[frame];
    if (!at) return gray;
    const c = toImage(arena.calibration, at);
    for (let y = Math.floor(c.y - 10); y <= c.y + 10; y++) {
      for (let x = Math.floor(c.x - 30); x <= c.x + 16; x++) {
        const dx = x - c.x;
        const inBody = (dx / 14) ** 2 + ((y - c.y) / 7) ** 2 <= 1;
        const inTail = Math.abs(y - c.y) <= 0.5 && dx < -12 && dx >= -28;
        if (inBody || inTail) gray[y * W + x] = 40;
      }
    }
    return gray;
  };
  return {
    width: W,
    height: H,
    frameCount: path.length,
    timebase,
    getGrayFrame: async (frame) => draw(frame),
    async scan(range, visit, onProgress) {
      for (let f = range.from; f <= range.to; f++) {
        await visit(f, draw(f));
        onProgress?.(f - range.from + 1, range.to - range.from + 1);
      }
    },
    close() {},
  };
}

/** 2 s along the wall, 2 s walking into the center, 2 s there, 2 s back out: 30 fps. */
function walk(): Point[] {
  const path: Point[] = [];
  const lerp = (a: Point, b: Point, n: number) => {
    for (let i = 0; i < n; i++) path.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
  };
  lerp({ x: 4, y: 4 }, { x: 36, y: 4 }, 60);
  lerp({ x: 36, y: 4 }, { x: 20, y: 20 }, 60);
  lerp({ x: 20, y: 20 }, { x: 24, y: 22 }, 60);
  lerp({ x: 24, y: 22 }, { x: 36, y: 36 }, 60);
  return path;
}

describe('open field', () => {
  it('measures distance, center time and wall time on a synthetic walk', async () => {
    const path = walk();
    const result = await openField.analyze(recording(path), { arena });
    const { summary } = result;
    expect(result.sizeScale).toBeCloseTo(5 / 4.7);
    expect(summary.trackedFraction).toBe(1);
    // True path length: 32 + 22.6 + 4.5 + 18.4 ≈ 77.5 cm.
    expect(summary.distanceCm).toBeGreaterThan(70);
    expect(summary.distanceCm).toBeLessThan(85);
    const center = summary.zones.find((z) => z.zoneId === 'center')!;
    expect(center.entries).toBe(1);
    // The center square is 10–30 cm; the walk crosses into it at about 2.75 s
    // and leaves at about 7.0 s.
    expect(center.latencyS).toBeGreaterThan(2.7);
    expect(center.latencyS).toBeLessThan(3.2);
    expect(center.timeS).toBeGreaterThan(4);
    expect(center.timeS).toBeLessThan(4.6);
    // The first 2 s run 4 cm from the wall.
    expect(summary.timeNearWallS).toBeGreaterThan(2);
    expect(summary.nearWallFraction).toBeGreaterThan(0.25);
    expect(result.warnings).toEqual([]);
  });

  it('scores only the requested window', async () => {
    const result = await openField.analyze(recording(walk()), { arena, window: { startS: 4, durationS: 2 } });
    expect(result.frames[0]!.timeS).toBeGreaterThanOrEqual(4);
    expect(result.summary.zones[0]).toMatchObject({ zoneId: 'center', latencyS: 0, entries: 1 });
    expect(result.summary.timeNearWallS).toBe(0);
  });

  it('runs with another detector and reports a lost animal', async () => {
    const path: Array<Point | null> = walk();
    for (let i = 100; i < 150; i++) path[i] = null;
    const result = await openField.analyze(recording(path), { arena }, { detector: silhouetteTaperDetector });
    expect(result.detectorId).toBe('silhouette-taper-v1');
    expect(result.summary.trackedFraction).toBeLessThan(0.9);
    expect(result.warnings.some((w) => w.includes('was found in'))).toBe(true);
  });

  it('smooths jitter without moving a steady animal', () => {
    // Single-frame spikes, as from a mis-detected frame.
    const spiky = [0, 0, 1, 0, 0, 1, 0, 0].map((d) => ({ x: 10 + d * 3, y: 5 }));
    const smooth = runningMedian(spiky, 5);
    expect(smooth.every((p) => p!.x === 10)).toBe(true);
    expect(runningMedian([null, { x: 1, y: 1 }], 5)[0]).toBeNull();
  });
});

describe('paradigm registry', () => {
  it('describes both paradigms the same way', () => {
    for (const p of [barnesMaze, openField]) {
      expect(p.id).toMatch(/^[a-z-]+$/);
      expect(p.metrics.length).toBeGreaterThan(0);
      expect(new Set(p.metrics.map((m) => m.id)).size).toBe(p.metrics.length);
      expect(typeof p.analyze).toBe('function');
    }
  });

  it('expresses a Barnes maze as a generic arena with a zone per hole', () => {
    const geometry = makeGeometry(3);
    const a = barnesArena(geometry, 3);
    expect(a.zones).toHaveLength(geometry.holes.length);
    expect(a.zones.filter((z) => z.name.includes('target'))).toHaveLength(1);
    expect(a.boundary).toMatchObject({ kind: 'circle', radius: 91.5 / 2 });
    // The target zone sits on its hole when mapped back to the image.
    const targetHole = geometry.holes.find((h) => h.index === 3)!;
    const zone = a.zones.find((z) => z.name.includes('target'))!;
    if (zone.shape.kind !== 'circle') throw new Error('expected a circle');
    const back = toImage(a.calibration, zone.shape.center);
    expect(back.x).toBeCloseTo(targetHole.center.x, 6);
    expect(back.y).toBeCloseTo(targetHole.center.y, 6);
  });
});
