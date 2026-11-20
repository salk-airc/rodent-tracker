import { describe, expect, it } from 'vitest';
import { darkBlobDetector } from '../src/detect/darkBlob';
import { DEFAULT_PARAMS } from '../src/params';

const W = 64;
const H = 48;

function frameWithMouse(cx: number, cy: number): Uint8Array {
  const gray = new Uint8Array(W * H).fill(200);
  // An elongated dark body with a thin tail, pointing right.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBody = ((x - cx) / 7) ** 2 + ((y - cy) / 3.5) ** 2 <= 1;
      const inTail = y === cy && x < cx - 6 && x >= cx - 16;
      if (inBody || inTail) gray[y * W + x] = 40;
    }
  }
  return gray;
}

describe('darkBlobDetector', () => {
  const setup = {
    width: W,
    height: H,
    background: { data: new Uint8Array(W * H).fill(200), width: W, height: H },
    arenaMask: new Uint8Array(W * H).fill(1),
    params: { ...DEFAULT_PARAMS.tracking, minBlobPx: 10 },
  };

  it('finds the animal, with the nose at the thick end and the tail at the thin one', () => {
    const det = darkBlobDetector(setup);
    const { detection } = det.detect(0, frameWithMouse(36, 24));
    expect(det.id).toBe('dark-blob-v1');
    expect(detection).not.toBeNull();
    expect(Math.abs(detection!.body.x - 36)).toBeLessThan(3);
    expect(detection!.nose.x).toBeGreaterThan(detection!.body.x);
    expect(detection!.tail.x).toBeLessThan(detection!.body.x);
  });

  it('reports a miss with the foreground count, and keeps tracking afterwards', () => {
    const det = darkBlobDetector(setup);
    det.detect(0, frameWithMouse(30, 24));
    const miss = det.detect(1, new Uint8Array(W * H).fill(200));
    expect(miss).toEqual({ detection: null, darkPixelsPx: 0 });
    expect(det.detect(2, frameWithMouse(32, 24)).detection).not.toBeNull();
  });
});
