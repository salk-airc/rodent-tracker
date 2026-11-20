import { describe, expect, it } from 'vitest';
import { darkBlobDetector } from '../src/detect/darkBlob';
import { silhouetteTaperDetector } from '../src/detect/silhouetteTaper';
import type { DetectorFactory, DetectorSetup } from '../src/detect/types';
import { DEFAULT_PARAMS } from '../src/paradigms/barnes/params';
import { REFERENCE_PX_PER_CM, scaleTrackingParams, sizeScaleFor } from '../src/detect/scale';

const W = 320;
const H = 240;
const FLOOR = 200;

/** A dark elongated body with a thin tail, nose pointing along +x or -x. */
function frameWithMouse(cx: number, cy: number, facing: 1 | -1 = 1): Uint8Array {
  const gray = new Uint8Array(W * H).fill(FLOOR);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) * facing;
      const inBody = (dx / 14) ** 2 + ((y - cy) / 7) ** 2 <= 1;
      const inTail = Math.abs(y - cy) <= 0 && dx < -12 && dx >= -40;
      if (inBody || inTail) gray[y * W + x] = 40;
    }
  }
  return gray;
}

const setup: DetectorSetup = {
  width: W,
  height: H,
  background: { data: new Uint8Array(W * H).fill(FLOOR), width: W, height: H },
  arenaMask: new Uint8Array(W * H).fill(1),
  params: DEFAULT_PARAMS.tracking,
};

const detectors: Array<[string, DetectorFactory]> = [
  ['dark-blob-v1', darkBlobDetector],
  ['silhouette-taper-v1', silhouetteTaperDetector],
];

describe.each(detectors)('%s', (id, factory) => {
  it('finds the body, with the nose at the thick end', () => {
    for (const facing of [1, -1] as const) {
      const det = factory(setup);
      expect(det.id).toBe(id);
      const { detection } = det.detect(0, frameWithMouse(160, 120, facing), 0);
      expect(detection).not.toBeNull();
      expect(Math.abs(detection!.body.x - 160)).toBeLessThan(6);
      expect(Math.abs(detection!.body.y - 120)).toBeLessThan(3);
      expect(Math.sign(detection!.nose.x - detection!.body.x)).toBe(facing);
    }
  });

  it('reports a miss, and finds the animal again on the next frame', () => {
    const det = factory(setup);
    det.detect(0, frameWithMouse(150, 120), 0);
    const miss = det.detect(1, new Uint8Array(W * H).fill(FLOOR), 1 / 30);
    expect(miss).toEqual({ detection: null, darkPixelsPx: 0 });
    expect(det.detect(2, frameWithMouse(152, 120), 2 / 30).detection).not.toBeNull();
  });
});

describe('silhouette-taper-v1', () => {
  it('explains each frame', () => {
    const det = silhouetteTaperDetector(setup);
    expect(det.detect(0, frameWithMouse(160, 120), 0).detection?.reason).toBe('single foreground component');
  });

  it('rejects a jump faster than two arena diameters a second', () => {
    const det = silhouetteTaperDetector(setup);
    det.detect(0, frameWithMouse(60, 120), 0);
    // 200 px in one frame at 30 fps, in an arena about 300 px across.
    expect(det.detect(1, frameWithMouse(260, 120), 1 / 30).detection).toBeNull();
  });
});

describe('size scaling', () => {
  const W2 = 640;
  const H2 = 480;
  /** The same mouse imaged at twice the px/cm. */
  function bigMouse(cx: number, cy: number, facing: 1 | -1 = 1): Uint8Array {
    const gray = new Uint8Array(W2 * H2).fill(FLOOR);
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const dx = (x - cx) * facing;
        const inBody = (dx / 28) ** 2 + ((y - cy) / 14) ** 2 <= 1;
        const inTail = Math.abs(y - cy) <= 1 && dx < -24 && dx >= -80;
        if (inBody || inTail) gray[y * W2 + x] = 40;
      }
    }
    return gray;
  }
  const bigSetup = (sizeScale?: number): DetectorSetup => {
    const params = sizeScale === undefined ? DEFAULT_PARAMS.tracking : scaleTrackingParams(DEFAULT_PARAMS.tracking, sizeScale);
    return {
      width: W2,
      height: H2,
      background: { data: new Uint8Array(W2 * H2).fill(FLOOR), width: W2, height: H2 },
      arenaMask: new Uint8Array(W2 * H2).fill(1),
      params,
      ...(sizeScale === undefined ? {} : { sizeScale }),
    };
  };

  it('scales lengths by s and areas by s²', () => {
    const p = scaleTrackingParams(DEFAULT_PARAMS.tracking, 2);
    expect(p.minBlobPx).toBe(DEFAULT_PARAMS.tracking.minBlobPx * 4);
    expect(p.bodyCoreErodePx).toBe(DEFAULT_PARAMS.tracking.bodyCoreErodePx * 2);
    expect(p.holeLockRadiusPx).toBe(DEFAULT_PARAMS.tracking.holeLockRadiusPx * 2);
    expect(p.maxAreaRatio).toBe(DEFAULT_PARAMS.tracking.maxAreaRatio);
    expect(scaleTrackingParams(DEFAULT_PARAMS.tracking, 1)).toBe(DEFAULT_PARAMS.tracking);
    expect(sizeScaleFor(REFERENCE_PX_PER_CM * 1.5)).toBeCloseTo(1.5);
  });

  it.each(detectors)('%s finds a mouse imaged at twice the scale', (_id, factory) => {
    for (const facing of [1, -1] as const) {
      const { detection } = factory(bigSetup(2)).detect(0, bigMouse(320, 240, facing), 0);
      expect(detection).not.toBeNull();
      expect(Math.abs(detection!.body.x - 320)).toBeLessThan(12);
      expect(Math.sign(detection!.nose.x - detection!.body.x)).toBe(facing);
    }
  });

  it('dark-blob-v1 drops specks that are noise at the larger scale', () => {
    const speck = new Uint8Array(W2 * H2).fill(FLOOR);
    for (let y = 100; y < 108; y++) for (let x = 100; x < 108; x++) speck[y * W2 + x] = 40;
    expect(darkBlobDetector(bigSetup()).detect(0, speck, 0).detection).not.toBeNull();
    expect(darkBlobDetector(bigSetup(2)).detect(0, speck, 0).detection).toBeNull();
  });
});
