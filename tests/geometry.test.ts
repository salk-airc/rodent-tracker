import { describe, expect, it } from 'vitest';
import { detectGeometry, applyTemplate, templateFromGeometry } from '../src/paradigms/barnes/geometry/detect';
import { fitPlatform } from '../src/paradigms/barnes/geometry/platform';
import { fitRing } from '../src/paradigms/barnes/geometry/ring';
import type { Gray } from '../src/image/imageOps';
import { holeNumber } from '../src/paradigms/barnes/types';

interface MazeSpec {
  width?: number;
  height?: number;
  cx: number;
  cy: number;
  platformR: number;
  ringFraction: number;
  holeCount: number;
  phaseDeg: number;
  holeR: number;
  platformLevel?: number;
  backgroundLevel?: number;
  holeLevel?: number;
  noise?: number;
  /** Simulate uneven lighting: fractional brightness drop across the platform. */
  vignette?: number;
}

/**
 * Render a synthetic Barnes maze with known parameters.
 *
 * The point of testing against a synthetic image is that the true answer is
 * known exactly, which the sample clips cannot give us — there is no ground
 * truth in that folder, deliberately. These tests check the recovery math; the
 * golden tests check that it survives real video.
 */
function synthMaze(spec: MazeSpec): Gray {
  const width = spec.width ?? 640;
  const height = spec.height ?? 480;
  const platformLevel = spec.platformLevel ?? 190;
  const backgroundLevel = spec.backgroundLevel ?? 45;
  const holeLevel = spec.holeLevel ?? 60;
  const vignette = spec.vignette ?? 0;
  let seed = 12345;
  const noise = () =>
    spec.noise ? ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * spec.noise : 0;

  const holes: { x: number; y: number }[] = [];
  for (let i = 0; i < spec.holeCount; i++) {
    const th = (spec.phaseDeg * Math.PI) / 180 + (i * 2 * Math.PI) / spec.holeCount;
    holes.push({
      x: spec.cx + spec.platformR * spec.ringFraction * Math.cos(th),
      y: spec.cy + spec.platformR * spec.ringFraction * Math.sin(th),
    });
  }

  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.hypot(x - spec.cx, y - spec.cy);
      let v: number;
      if (r <= spec.platformR) {
        const shade = 1 - vignette * (0.5 + 0.5 * ((x - spec.cx) / spec.platformR));
        v = platformLevel * shade;
        for (const h of holes) {
          if (Math.hypot(x - h.x, y - h.y) <= spec.holeR) {
            v = holeLevel;
            break;
          }
        }
      } else {
        v = backgroundLevel;
      }
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(v + noise())));
    }
  }
  return { data, width, height };
}

describe('fitPlatform', () => {
  it('recovers center and radius to sub-pixel accuracy', () => {
    const img = synthMaze({ cx: 325, cy: 241, platformR: 208, ringFraction: 0.89, holeCount: 20, phaseDeg: 11.7, holeR: 12 });
    const fit = fitPlatform(img);
    expect(fit.center.x).toBeCloseTo(325, 0);
    expect(fit.center.y).toBeCloseTo(241, 0);
    expect(fit.radiusPx).toBeCloseTo(208, 0);
    expect(fit.residualPx).toBeLessThan(1);
    expect(fit.edgeCoverage).toBeGreaterThan(0.99);
  });

  /**
   * The regression this test exists for: an early version fitted a circle to
   * every boundary pixel of the bright region, which includes the rims of the
   * twenty holes at 0.89 of the radius. That pulled the radius in by about 6%
   * and inflated the residual to 11 px, quietly mis-scaling every distance
   * reported in centimeters.
   */
  it('is not dragged inward by the hole rims inside the platform', () => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.85, holeCount: 20, phaseDeg: 0, holeR: 16 });
    const fit = fitPlatform(img);
    expect(fit.radiusPx).toBeGreaterThan(198);
    expect(fit.radiusPx).toBeLessThan(202);
    expect(fit.residualPx).toBeLessThan(1.5);
  });

  it('survives noise and uneven lighting', () => {
    const img = synthMaze({
      cx: 300, cy: 250, platformR: 190, ringFraction: 0.9, holeCount: 20, phaseDeg: 33, holeR: 11,
      noise: 6, vignette: 0.25,
    });
    const fit = fitPlatform(img);
    expect(fit.center.x).toBeCloseTo(300, 0);
    expect(fit.center.y).toBeCloseTo(250, 0);
    expect(Math.abs(fit.radiusPx - 190)).toBeLessThan(2);
  });

  it('reports a warning rather than a wrong answer when the platform runs off frame', () => {
    const img = synthMaze({ cx: 120, cy: 240, platformR: 220, ringFraction: 0.89, holeCount: 20, phaseDeg: 0, holeR: 12 });
    const fit = fitPlatform(img);
    expect(fit.warnings.join(' ')).toMatch(/off the edge of the frame/);
  });

  it('says so when the image is blank rather than fitting a circle to the frame', () => {
    const data = new Uint8Array(64 * 64).fill(20);
    const fit = fitPlatform({ data, width: 64, height: 64 });
    expect(fit.warnings.join(' ')).toMatch(/no platform could be found/i);
    expect(fit.edgeCoverage).toBe(0);
  });

  it('says so when the bright region fills the frame', () => {
    const w = 80;
    const h = 80;
    const data = new Uint8Array(w * h).fill(210);
    // A dark strip down one side: enough contrast for Otsu to have a real
    // threshold, but the bright region still covers over 90% of the frame.
    for (let y = 0; y < h; y++) for (let x = 0; x < 4; x++) data[y * w + x] = 20;
    const fit = fitPlatform({ data, width: w, height: h });
    expect(fit.warnings.join(' ')).toMatch(/fills the whole frame/i);
  });
});

describe('fitRing', () => {
  it.each([12, 18, 20, 24])('recovers hole count %i without being told', (holeCount) => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.9, holeCount, phaseDeg: 7, holeR: 200 * 0.9 * Math.PI / holeCount * 0.35 });
    const platform = fitPlatform(img);
    const ring = fitRing(img, platform.center, platform.radiusPx);
    expect(ring.holeCount).toBe(holeCount);
    expect(ring.symmetry).toBeGreaterThan(0.55);
  });

  it.each([0, 7.5, 11.7, 17.9])('recovers ring rotation %f degrees', (phaseDeg) => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.89, holeCount: 20, phaseDeg, holeR: 12 });
    const platform = fitPlatform(img);
    const ring = fitRing(img, platform.center, platform.radiusPx, 20);
    // Rotation is only defined modulo one hole spacing (18 degrees here).
    const spacing = 18;
    const got = (ring.phaseRad * 180) / Math.PI;
    let diff = (((got - phaseDeg) % spacing) + spacing) % spacing;
    if (diff > spacing / 2) diff -= spacing;
    expect(Math.abs(diff)).toBeLessThan(0.6);
  });

  it('recovers the ring radius', () => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.82, holeCount: 20, phaseDeg: 3, holeR: 12 });
    const platform = fitPlatform(img);
    const ring = fitRing(img, platform.center, platform.radiusPx, 20);
    expect(ring.ringRadiusFraction).toBeCloseTo(0.82, 1);
  });

  /**
   * A disk with no holes must not come back with a confident ring. The score
   * being searched is a maximum over a few hundred candidate radii, so raw
   * symmetry alone reads deceptively high on noise; the prominence ratio is
   * what actually separates the two cases.
   */
  it('reports no ring, rather than a confident wrong one, on a plain disk', () => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.9, holeCount: 20, phaseDeg: 0, holeR: 0, noise: 4 });
    const platform = fitPlatform(img);
    const ring = fitRing(img, platform.center, platform.radiusPx, 20);
    expect(ring.prominence).toBeLessThan(5);
    expect(ring.warnings.join(' ')).toMatch(/No clear hole ring/);
  });

  it('is confident on a disk that does have holes', () => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.89, holeCount: 20, phaseDeg: 4, holeR: 12, noise: 4 });
    const platform = fitPlatform(img);
    const ring = fitRing(img, platform.center, platform.radiusPx, 20);
    expect(ring.symmetry).toBeGreaterThan(0.55);
    expect(ring.prominence).toBeGreaterThan(5);
    expect(ring.warnings).toHaveLength(0);
  });
});

describe('detectGeometry', () => {
  it('produces holes on the holes, and a scale that follows the stated diameter', () => {
    const img = synthMaze({ cx: 325, cy: 241, platformR: 208, ringFraction: 0.89, holeCount: 20, phaseDeg: 11.7, holeR: 12, noise: 3 });
    const { geometry } = detectGeometry(img, { platformDiameterCm: 91.5 });
    expect(geometry.holeCount).toBe(20);
    expect(geometry.holes).toHaveLength(20);

    for (const hole of geometry.holes) {
      const r = Math.hypot(hole.center.x - 325, hole.center.y - 241);
      expect(Math.abs(r - 208 * 0.89)).toBeLessThan(3);
      expect(Math.abs(hole.radiusPx - 12)).toBeLessThan(3);
    }
    expect(geometry.targetHoleIndex).toBeNull();
    expect((2 * geometry.platformRadiusPx) / geometry.platformDiameterCm).toBeCloseTo(208 * 2 / 91.5, 1);
  });

  it('numbers holes consecutively around the ring', () => {
    const img = synthMaze({ cx: 320, cy: 240, platformR: 200, ringFraction: 0.9, holeCount: 20, phaseDeg: 5, holeR: 12 });
    const { geometry } = detectGeometry(img);
    const spacing = (2 * Math.PI) / 20;
    for (let i = 1; i < 20; i++) {
      const a = Math.atan2(geometry.holes[i - 1]!.center.y - 240, geometry.holes[i - 1]!.center.x - 320);
      const b = Math.atan2(geometry.holes[i]!.center.y - 240, geometry.holes[i]!.center.x - 320);
      let d = b - a;
      while (d < 0) d += 2 * Math.PI;
      expect(Math.abs(d - spacing)).toBeLessThan(0.05);
    }
  });
});

describe('applyTemplate', () => {
  const base: MazeSpec = { cx: 325, cy: 241, platformR: 208, ringFraction: 0.89, holeCount: 20, phaseDeg: 11.7, holeR: 12, noise: 3 };

  it('carries the target hole across when the rig has not moved', () => {
    const first = detectGeometry(synthMaze(base)).geometry;
    const template = templateFromGeometry('rig-a', 'Rig A', { ...first, targetHoleIndex: 7 });
    const match = applyTemplate(synthMaze({ ...base, cx: 325.4, cy: 241.3 }), template);
    expect(match.agrees).toBe(true);
    expect(match.geometry.targetHoleIndex).toBe(7);
    expect(match.geometry.targetProvenance).toBe('template');
    expect(match.geometry.platformDiameterCm).toBe(template.platformDiameterCm);
  });

  it('carries the lab hole numbering with the target, and drops both when the ring rotates', () => {
    const first = detectGeometry(synthMaze(base)).geometry;
    const template = templateFromGeometry('rig-a', 'Rig A', {
      ...first, targetHoleIndex: 7, holeOneIndex: 4, holeNumbering: 'counterclockwise',
    });
    const kept = applyTemplate(synthMaze({ ...base, cx: 325.4, cy: 241.3 }), template).geometry;
    expect([kept.holeOneIndex, kept.holeNumbering]).toEqual([4, 'counterclockwise']);
    const rotated = applyTemplate(synthMaze({ ...base, phaseDeg: base.phaseDeg + 9 }), template);
    expect([rotated.geometry.holeOneIndex, rotated.geometry.holeNumbering]).toEqual([undefined, undefined]);
    expect(rotated.notes.join(' ')).toMatch(/hole numbering were cleared/);
  });

  it('flags a moved rig but still carries the target if the ring did not rotate', () => {
    const first = detectGeometry(synthMaze(base)).geometry;
    const template = templateFromGeometry('rig-a', 'Rig A', { ...first, targetHoleIndex: 3 });
    const match = applyTemplate(synthMaze({ ...base, cx: 300, cy: 260 }), template);
    expect(match.agrees).toBe(false);
    expect(match.centerShiftPx).toBeGreaterThan(8);
    expect(match.notes.join(' ')).toMatch(/has moved/);
  });

  /**
   * The failure this guards against is the worst one available: if the ring is
   * rotated between sessions and we keep the old target index, every latency in
   * the file is measured to the wrong hole and nothing about the output looks
   * wrong.
   */
  it('drops the target hole when the ring has rotated by half a hole', () => {
    const first = detectGeometry(synthMaze(base)).geometry;
    const template = templateFromGeometry('rig-a', 'Rig A', { ...first, targetHoleIndex: 5 });
    const match = applyTemplate(synthMaze({ ...base, phaseDeg: 11.7 + 9 }), template);
    expect(match.geometry.targetHoleIndex).toBeNull();
    expect(match.notes.join(' ')).toMatch(/rotated/);
  });
});

describe('holeNumber', () => {
  const ring = (holeOneIndex?: number, holeNumbering?: 'clockwise' | 'counterclockwise') =>
    ({ holeCount: 20, holeOneIndex, holeNumbering });

  it('numbers from index 0 clockwise by default', () => {
    expect([0, 1, 19].map((i) => holeNumber(ring(), i))).toEqual([1, 2, 20]);
  });

  it('starts at the lab hole 1 and wraps around the ring', () => {
    expect([5, 6, 4, 0].map((i) => holeNumber(ring(5), i))).toEqual([1, 2, 20, 16]);
  });

  it('counts the other way when numbers increase counterclockwise', () => {
    expect([5, 4, 6, 0].map((i) => holeNumber(ring(5, 'counterclockwise'), i))).toEqual([1, 2, 20, 6]);
  });
});
