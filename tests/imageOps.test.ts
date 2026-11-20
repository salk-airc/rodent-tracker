import { describe, expect, it } from 'vitest';
import {
  chamferDistance,
  connectedComponents,
  largestComponent,
  otsuThreshold,
  sampleBilinear,
  type Gray,
} from '../src/image/imageOps';

function gray(width: number, height: number, fill: (x: number, y: number) => number): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { data, width, height };
}

describe('otsuThreshold', () => {
  /**
   * The threshold is used as `value > t`, so what matters is that every dark
   * pixel lands on one side and every bright pixel on the other. Asserting a
   * particular number would just pin down the tie-breaking convention.
   */
  const separates = (img: Gray, dark: number, bright: number) => {
    const t = otsuThreshold(img);
    return dark <= t && bright > t;
  };

  it('separates a clean two-level image', () => {
    expect(separates(gray(64, 64, (x) => (x < 32 ? 40 : 200)), 40, 200)).toBe(true);
  });

  it('still separates when the classes are very unequal in size', () => {
    // A small dark animal on a large bright platform: 2% of pixels are dark.
    expect(separates(gray(100, 100, (x, y) => (x < 10 && y < 20 ? 30 : 210)), 30, 210)).toBe(true);
  });

  it('separates a noisy image of the kind the camera actually produces', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 16;
    const truth: boolean[] = [];
    const img = gray(120, 120, (x, y) => {
      const inside = Math.hypot(x - 60, y - 60) < 45;
      truth.push(inside);
      return Math.max(0, Math.min(255, Math.round((inside ? 190 : 45) + rand())));
    });
    const t = otsuThreshold(img);
    let wrong = 0;
    for (let i = 0; i < img.data.length; i++) if (img.data[i]! > t !== truth[i]!) wrong++;
    expect(wrong).toBe(0);
  });
});

describe('connectedComponents', () => {
  it('finds separate blobs and measures their areas', () => {
    const w = 40;
    const h = 40;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * w + x] = 1; // 25 px
    for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) mask[y * w + x] = 1; // 100 px
    const r = connectedComponents(mask, w, h);
    expect(r.components).toHaveLength(2);
    expect(largestComponent(r)!.areaPx).toBe(100);
    const big = largestComponent(r)!;
    expect(big.sumX / big.areaPx).toBeCloseTo(24.5, 6);
    expect(big.minX).toBe(20);
    expect(big.maxY).toBe(29);
  });

  it('joins diagonal neighbors, so a thin diagonal tail stays one animal', () => {
    const w = 10;
    const h = 10;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < 6; i++) mask[(2 + i) * w + (2 + i)] = 1;
    const r = connectedComponents(mask, w, h);
    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.areaPx).toBe(6);
  });

  it('honors the search window, which is how per-frame tracking stays cheap', () => {
    const w = 40;
    const h = 40;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * w + x] = 1;
    for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) mask[y * w + x] = 1;
    const r = connectedComponents(mask, w, h, { window: { x0: 15, y0: 15, x1: 35, y1: 35 } });
    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.areaPx).toBe(100);
  });

  it('drops blobs below the minimum area', () => {
    const w = 20;
    const h = 20;
    const mask = new Uint8Array(w * h);
    mask[5 * w + 5] = 1;
    for (let y = 10; y < 15; y++) for (let x = 10; x < 15; x++) mask[y * w + x] = 1;
    const r = connectedComponents(mask, w, h, { minAreaPx: 5 });
    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.areaPx).toBe(25);
  });
});

describe('chamferDistance', () => {
  it('peaks at the center of a square at half its width', () => {
    const w = 41;
    const h = 41;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y <= 30; y++) for (let x = 10; x <= 30; x++) mask[y * w + x] = 1;
    const d = chamferDistance(mask, w, h);
    // Half-width of a 21 px square is 10.5; the nearest background pixel is
    // 11 steps from the center pixel.
    expect(d.data[20 * w + 20]!).toBeCloseTo(11, 0);
    expect(d.data[10 * w + 20]!).toBe(1);
    expect(d.data[0]!).toBe(0);
  });

  it('gives a thin limb a much lower value than a thick body, which is what strips the tail', () => {
    const w = 60;
    const h = 30;
    const mask = new Uint8Array(w * h);
    // body: 16 px across
    for (let y = 7; y < 23; y++) for (let x = 4; x < 20; x++) mask[y * w + x] = 1;
    // tail: 2 px across
    for (let y = 14; y < 16; y++) for (let x = 20; x < 55; x++) mask[y * w + x] = 1;
    const d = chamferDistance(mask, w, h);
    const bodyPeak = d.data[15 * w + 11]!;
    const tailValue = d.data[15 * w + 45]!;
    expect(bodyPeak).toBeGreaterThan(7);
    expect(tailValue).toBeLessThan(2);
  });
});

describe('sampleBilinear', () => {
  it('interpolates between neighbors', () => {
    const img = gray(2, 2, (x) => (x === 0 ? 0 : 100));
    expect(sampleBilinear(img, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleBilinear(img, 0.5, 0)).toBeCloseTo(50, 6);
    expect(sampleBilinear(img, 0.25, 0.5)).toBeCloseTo(25, 6);
  });

  it('clamps outside the image rather than reading out of bounds', () => {
    const img = gray(4, 4, () => 77);
    expect(sampleBilinear(img, -10, -10)).toBeCloseTo(77, 6);
    expect(sampleBilinear(img, 99, 99)).toBeCloseTo(77, 6);
  });
});
