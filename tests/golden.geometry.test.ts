/**
 * Detection, run against the actual sample recordings.
 *
 * The synthetic tests in `geometry.test.ts` check that the math recovers known
 * parameters. This file checks that it survives real video: uneven lighting,
 * specular highlights, compression artifacts, a cable at the edge of frame, and
 * holes that appear as partial ellipses because the camera is not perfectly
 * overhead.
 *
 * There is no ground truth in the sample folder, on purpose, so these are
 * assertions about properties that must hold of a correct fit rather than
 * pinned decimals. The most useful of them is cross-clip agreement: `test50`
 * and `test53` are the same rig on the same day and must come out the same,
 * while `test51` is a different setup and must not.
 *
 * Skipped when ffmpeg or the sample clips are unavailable, so the fast CI job
 * does not need either.
 */

import { SAMPLE_CLIPS, SAMPLE_DIR } from '../src/paradigms/barnes/samples';
import { haveSampleClips } from '../src/paradigms/barnes/sampleFiles';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { FfmpegFrameSource } from '../src/video/ffmpeg';
import { buildBackground } from '../src/image/background';
import { detectGeometry, type DetectResult } from '../src/paradigms/barnes/geometry/detect';
import { platformBrightness } from '../src/paradigms/barnes/geometry/holes';
import { sampleBilinear } from '../src/image/imageOps';
import type { Gray } from '../src/image/imageOps';
import type { TimingReport } from '../src/paradigms/barnes/types';

// Run `pnpm samples` to download the clips; without them these tests skip.
const dir = SAMPLE_DIR;

const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const haveClips = haveSampleClips(dir);
const run = haveFfmpeg && haveClips;

interface Analyzed {
  readonly detect: DetectResult;
  readonly background: Gray;
  readonly timing: TimingReport;
}

const results = new Map<string, Analyzed>();

describe.skipIf(!run)('geometry on the sample clips', () => {
  beforeAll(async () => {
    for (const clip of SAMPLE_CLIPS) {
      const src = new FfmpegFrameSource(`${dir}/${clip}.mp4`);
      const bg = await buildBackground(src);
      results.set(clip, { detect: detectGeometry(bg.image), background: bg.image, timing: src.timing });
      src.close();
    }
  }, 120_000);

  describe.each(SAMPLE_CLIPS)('%s', (clip) => {
    it('fits the platform edge to within a pixel', () => {
      const { platform } = results.get(clip)!.detect;
      expect(platform.residualPx).toBeLessThan(1);
      expect(platform.edgeCoverage).toBeGreaterThan(0.99);
    });

    it('finds 20 holes with high confidence', () => {
      const { ring, geometry } = results.get(clip)!.detect;
      expect(ring.holeCount).toBe(20);
      expect(geometry.holes).toHaveLength(20);
      expect(ring.symmetry).toBeGreaterThan(0.7);
      expect(ring.prominence).toBeGreaterThan(20);
    });

    it('reports no warnings', () => {
      expect(results.get(clip)!.detect.geometry.fit.warnings).toEqual([]);
    });

    /**
     * The ring sits at the same fraction of the platform radius in both rigs
     * (0.890, 0.893, 0.890), which is a property of how Barnes mazes are built
     * rather than of this footage. It is the cheapest available check that the
     * fit is measuring the apparatus and not an artifact.
     */
    it('places the hole ring at ~0.89 of the platform radius', () => {
      const g = results.get(clip)!.detect.geometry;
      const fraction = g.ringRadiusPx / g.platformRadiusPx;
      expect(fraction).toBeGreaterThan(0.87);
      expect(fraction).toBeLessThan(0.91);
    });

    it('puts every hole on something dark', () => {
      const { detect, background } = results.get(clip)!;
      const g = detect.geometry;
      const level = platformBrightness(background, g.center, g.platformRadiusPx);
      for (const hole of g.holes) {
        const v = sampleBilinear(background, hole.center.x, hole.center.y);
        expect(level - v, `hole ${hole.index} is not darker than the platform`).toBeGreaterThan(15);
      }
    });

    /**
     * Hole diameter comes out at 5.2-5.4 cm on the default 91.5 cm platform.
     * Barnes mazes for mice are built with 5 cm holes, so this is an
     * independent check that the pixel-to-centimeter scale is roughly right —
     * the scale is derived from the platform, and the holes were never used to
     * calibrate it.
     */
    it('implies a plausible hole size in centimeters', () => {
      const g = results.get(clip)!.detect.geometry;
      const scale = (2 * g.platformRadiusPx) / g.platformDiameterCm;
      const radii = g.holes.map((h) => h.radiusPx).sort((a, b) => a - b);
      const diameterCm = (2 * radii[radii.length >> 1]!) / scale;
      expect(diameterCm).toBeGreaterThan(4);
      expect(diameterCm).toBeLessThan(6.5);
    });

    it('numbers holes consecutively clockwise around the ring', () => {
      const g = results.get(clip)!.detect.geometry;
      const spacing = (2 * Math.PI) / g.holeCount;
      for (let i = 1; i < g.holeCount; i++) {
        const a = angleOf(g, i - 1);
        const b = angleOf(g, i);
        let d = b - a;
        while (d < 0) d += 2 * Math.PI;
        expect(Math.abs(d - spacing), `gap between holes ${i - 1} and ${i}`).toBeLessThan(0.06);
      }
    });
  });

  it('agrees between test50 and test53, which are the same rig', () => {
    const a = results.get('test50')!.detect.geometry;
    const b = results.get('test53')!.detect.geometry;
    expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeLessThan(1);
    expect(Math.abs(a.platformRadiusPx - b.platformRadiusPx)).toBeLessThan(1);
    const spacingDeg = 360 / a.holeCount;
    const phaseDiff = Math.abs(((a.phaseRad - b.phaseRad) * 180) / Math.PI);
    expect(Math.min(phaseDiff, spacingDeg - phaseDiff)).toBeLessThan(1);
  });

  it('sees that test51 is a different setup', () => {
    const a = results.get('test50')!.detect.geometry;
    const c = results.get('test51')!.detect.geometry;
    // A template from one must not be assumed to describe the other.
    expect(Math.hypot(a.center.x - c.center.x, a.center.y - c.center.y)).toBeGreaterThan(20);
    expect(Math.abs(a.platformRadiusPx - c.platformRadiusPx)).toBeGreaterThan(8);
  });

  it('stores automatic geometry at consistent precision across CPU architectures', () => {
    // test53 differed by up to 2e-12 px between ARM64 and x64, changing its
    // provenance fingerprints despite identical tracking observations.
    const geometry = results.get('test53')!.detect.geometry;
    expect(geometry.center).toEqual({ x: 324.544829151, y: 240.455546503 });
    expect(geometry.platformRadiusPx).toBe(208.389782293);
    expect(geometry.holes[6]!.center).toEqual({ x: 236.871626199, y: 403.359488727 });
  });
});

describe.skipIf(!run)('container timing on the sample clips', () => {
  const expected = {
    test50: { frames: 5539, timescale: 15360, nominalFps: 30, duplicates: 162 },
    test51: { frames: 741, timescale: 15000, nominalFps: 15000 / 1001, duplicates: 17 },
    test53: { frames: 905, timescale: 15360, nominalFps: 30, duplicates: 25 },
  } as const;

  it.each(SAMPLE_CLIPS)('%s reports frame count and timebase from the container', (clip) => {
    const t = results.get(clip)!.timing;
    expect(t.frameCount).toBe(expected[clip].frames);
    expect(t.timescale).toBe(expected[clip].timescale);
    expect(t.nominalFps).toBeCloseTo(expected[clip].nominalFps, 3);
  });

  /**
   * These clips were re-encoded, and the re-encode left frames sharing
   * timestamps with their neighbors. Anything reported in seconds is only
   * good to one frame in those regions, and the quality report has to say so
   * rather than quietly presenting three decimal places.
   */
  it.each(SAMPLE_CLIPS)('%s detects the duplicated timestamps left by re-encoding', (clip) => {
    const t = results.get(clip)!.timing;
    expect(t.duplicateTimestampFrames.length).toBe(expected[clip].duplicates);
    expect(t.effectiveFps).not.toBeCloseTo(t.nominalFps, 2);
  });

  it('test51 is not 15 fps', () => {
    const t = results.get('test51')!.timing;
    expect(t.nominalFps).toBeLessThan(15);
    expect(t.nominalFps).toBeGreaterThan(14.98);
  });
});

function angleOf(g: { center: { x: number; y: number }; holes: ReadonlyArray<{ index: number; center: { x: number; y: number } }> }, i: number): number {
  const h = g.holes[i]!;
  return Math.atan2(h.center.y - g.center.y, h.center.x - g.center.x);
}
