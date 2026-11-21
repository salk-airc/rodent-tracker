import { describe, expect, it } from 'vitest';
import { openFieldZones } from '../src/arena/arena';
import { scaleFromTwoPoints } from '../src/arena/calibration';
import { blurGray, gaussianKernel } from '../src/image/blur';
import { detectFreezing, measureMotion } from '../src/tracking/motion';
import { fearConditioning } from '../src/paradigms/fear-conditioning';
import type { FrameSource, Point } from '../src/types';
import { arenaRecording } from './helpers/arenaVideo';

const W = 320;
const H = 240;
const chamber = { ...openFieldZones(30, 25), calibration: scaleFromTwoPoints({ x: 60, y: 20 }, { x: 260, y: 20 }, 30) };

/** Walk in a straight line over `frames` frames. */
const walk = (a: Point, b: Point, frames: number): Point[] =>
  Array.from({ length: frames }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / frames, y: a.y + ((b.y - a.y) * i) / frames }));
/** Perfectly still: the same point every frame. */
const still = (p: Point, frames: number): Point[] => Array.from({ length: frames }, () => p);

/**
 * 30 fps: walk 2 s, freeze 3 s, walk 1 s, pause 0.5 s (too short to count),
 * walk 1 s. One freezing bout of 3 s.
 */
const session: Point[] = [
  ...walk({ x: 5, y: 5 }, { x: 15, y: 12 }, 60),
  ...still({ x: 15, y: 12 }, 90),
  ...walk({ x: 15, y: 12 }, { x: 25, y: 18 }, 30),
  ...still({ x: 25, y: 18 }, 15),
  ...walk({ x: 25, y: 18 }, { x: 8, y: 20 }, 30),
];

/** Adds camera noise: a fixed pseudo-random offset of up to ±amplitude per pixel per frame. */
function noisy(source: FrameSource, amplitude: number): FrameSource {
  const n = source.width * source.height;
  const out = new Uint8Array(n);
  const add = (frame: number, gray: Uint8Array, into: Uint8Array) => {
    let seed = (frame + 1) * 2654435761;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      into[i] = Math.max(0, Math.min(255, gray[i]! + ((seed % (2 * amplitude + 1)) - amplitude)));
    }
    return into;
  };
  return {
    ...source,
    getGrayFrame: async (f) => add(f, await source.getGrayFrame(f), new Uint8Array(n)),
    scan: (range, visit, p) => source.scan(range, (f, g) => visit(f, add(f, g, out)), p),
  };
}

describe('blur', () => {
  it('keeps a flat image flat and spreads a point', () => {
    const k = gaussianKernel(1);
    expect(k.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    const flat = blurGray(new Uint8Array(25).fill(80), 5, 5, k);
    expect(Math.max(...flat)).toBeCloseTo(80, 4);
    const point = new Uint8Array(25);
    point[12] = 100;
    const spread = blurGray(point, 5, 5, k);
    expect(spread[12]).toBeLessThan(100);
    expect(spread[11]).toBeGreaterThan(0);
  });
});

describe('motion and freezing', () => {
  it('finds the one freezing bout and ignores the short pause', async () => {
    const source = arenaRecording(chamber, W, H, session);
    const motion = await measureMotion(source, { cutoff: 10 });
    expect(motion.changedPx[30]).toBeGreaterThan(20); // walking
    expect(motion.changedPx[100]).toBe(0); // frozen
    const result = detectFreezing(motion, source.timebase, { thresholdPx: 5 });
    expect(result.bouts).toHaveLength(1);
    expect(result.bouts[0]!.startFrame).toBeGreaterThanOrEqual(60);
    expect(result.bouts[0]!.startFrame).toBeLessThanOrEqual(61);
    expect(result.freezingS).toBeGreaterThan(2.9);
    expect(result.freezingS).toBeLessThan(3.05);
  });

  it('calibrates the cutoff above camera noise, with or without empty frames', async () => {
    // One second of the empty chamber first, then the session.
    const withEmpty = noisy(arenaRecording(chamber, W, H, [...Array(30).fill(null), ...session]), 6);
    const fromEmpty = await measureMotion(withEmpty, { calibration: { from: 0, to: 29 } });
    expect(fromEmpty.cutoffSource).toBe('animal-free frames');
    const estimated = await measureMotion(withEmpty);
    expect(estimated.cutoffSource).toBe('estimated');
    for (const motion of [fromEmpty, estimated]) {
      // Noise alone doesn't register as motion: the frozen stretch stays near zero.
      expect(motion.changedPx[30 + 100]).toBeLessThan(10);
      expect(motion.changedPx[30 + 30]).toBeGreaterThan(20);
      const freezing = detectFreezing(motion, withEmpty.timebase, { thresholdPx: 10 }, { from: 30 });
      expect(freezing.bouts).toHaveLength(1);
      expect(freezing.freezingS).toBeGreaterThan(2.8);
    }
  });

  it('scores a session and reports every metric', async () => {
    const source = arenaRecording(chamber, W, H, session);
    const result = await fearConditioning.analyze(source, { freezeThresholdPx: 5, cutoff: 10 });
    const report = fearConditioning.report(result);
    expect(report.values.map((v) => v.id)).toEqual(fearConditioning.metrics.map((m) => m.id));
    const pct = report.values.find((v) => v.id === 'freezing_pct')!.value as number;
    // 3 s of a 7.5 s session (the last frame has no measured duration).
    expect(pct).toBeGreaterThan(38);
    expect(pct).toBeLessThan(42);
    expect(report.values.find((v) => v.id === 'freezing_bouts')!.value).toBe(1);
    expect(result.warnings).toEqual([]);

    const firstTwoSeconds = fearConditioning.report(await fearConditioning.analyze(source, { freezeThresholdPx: 5, cutoff: 10, window: { durationS: 2 } }));
    expect(firstTwoSeconds.values.find((v) => v.id === 'freezing_bouts')!.value).toBe(0);
    expect(firstTwoSeconds.values.find((v) => v.id === 'mean_bout_s')).toMatchObject({ value: null, complete: false });
  });
});
