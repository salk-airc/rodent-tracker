import { describe, expect, it } from 'vitest';
import { buildIndex, presentationIndicesInDecodeSpan } from '../src/video/webcodecs';
import { describeTiming, frameAtTime, frameDurations, timingUncertaintySec } from '../src/time';
import type { Timebase } from '../src/paradigms/barnes/types';

const sample = (cts: number, is_sync = false) => ({ cts, is_sync });

describe('buildIndex', () => {
  /**
   * These clips use B-frames, so the order the container stores samples in is
   * not the order they are displayed in. Treating the nth decoded frame as the
   * nth displayed frame would shift every position against its timestamp.
   */
  it('recovers presentation order from a B-frame decode order', () => {
    // A common IBBP pattern: I0 P3 B1 B2, stored in that order.
    const samples = [sample(0, true), sample(3), sample(1), sample(2)];
    const index = buildIndex(samples);
    expect(index.presentationOrder).toEqual([0, 2, 3, 1]);
  });

  it('keeps the true frame identities when B-frame lookahead creates a presentation gap', () => {
    // To request frames 0-1, decoding must feed samples 0-2. That span also
    // contains P3; assigning outputs as 0,1,2 would cache P3 under frame 2.
    const index = buildIndex([sample(0, true), sample(3), sample(1), sample(2)]);
    expect(presentationIndicesInDecodeSpan(index.presentationIndexOfSample, 0, 2)).toEqual([0, 1, 3]);
  });

  it('leaves an already-ordered file alone', () => {
    const samples = [sample(0, true), sample(1), sample(2), sample(3)];
    expect(buildIndex(samples).presentationOrder).toEqual([0, 1, 2, 3]);
  });

  it('records keyframes by presentation index, not by decode index', () => {
    // I0 P3 B1 B2 I4 P7 B5 B6
    const samples = [
      sample(0, true), sample(3), sample(1), sample(2),
      sample(4, true), sample(7), sample(5), sample(6),
    ];
    const index = buildIndex(samples);
    expect(index.presentationOrder).toEqual([0, 2, 3, 1, 4, 6, 7, 5]);
    expect(index.keyframePresentationIndices).toEqual([0, 4]);
  });

  it('treats frame 0 as a keyframe even if the container does not say so', () => {
    const samples = [sample(0), sample(1), sample(2, true)];
    expect(buildIndex(samples).keyframePresentationIndices).toEqual([0, 2]);
  });

  /**
   * Frames sharing a timestamp exist in all three sample clips. The order
   * between them has to stay stable, and decode order is the only tiebreaker
   * the container offers.
   */
  it('keeps duplicate timestamps in decode order', () => {
    const samples = [sample(0, true), sample(512), sample(512), sample(1024)];
    const index = buildIndex(samples);
    expect(index.presentationOrder).toEqual([0, 1, 2, 3]);
  });

  it('handles a single-frame file', () => {
    const index = buildIndex([sample(0, true)]);
    expect(index.presentationOrder).toEqual([0]);
    expect(index.keyframePresentationIndices).toEqual([0]);
  });
});

describe('describeTiming', () => {
  it('reports the nominal rate from the commonest interval', () => {
    const pts = Array.from({ length: 100 }, (_, i) => i * 1001);
    const t = describeTiming(15000, pts);
    expect(t.nominalDeltaTicks).toBe(1001);
    // 15000/1001 is 14.985, not 15. This is the difference that turns a 30.00 s
    // latency into 30.06 s.
    expect(t.nominalFps).toBeCloseTo(14.985, 3);
    expect(t.nominalFps).not.toBeCloseTo(15, 2);
  });

  it('finds frames that share a timestamp with their predecessor', () => {
    const pts = [0, 512, 512, 1024, 1536, 1536, 2048];
    const t = describeTiming(15360, pts);
    expect(t.duplicateTimestampFrames).toEqual([2, 5]);
  });

  it('finds intervals that are not the nominal one', () => {
    const pts = [0, 512, 1024, 2048, 2560];
    const t = describeTiming(15360, pts);
    expect(t.irregularIntervalFrames).toEqual([3]);
  });

  it('reports an effective rate that differs from the nominal one when frames are held', () => {
    // Half the intervals doubled: nominally 30 fps, effectively 20.
    const pts: number[] = [0];
    for (let i = 1; i < 100; i++) pts.push(pts[i - 1]! + (i % 2 ? 512 : 1024));
    const t = describeTiming(15360, pts);
    expect(t.nominalFps).toBeCloseTo(30, 1);
    expect(t.effectiveFps).toBeLessThan(25);
  });

  it('does not crash on an empty or single-frame file', () => {
    expect(describeTiming(15360, []).frameCount).toBe(0);
    expect(describeTiming(15360, [0]).durationSec).toBe(0);
  });
});

describe('frameDurations', () => {
  it('gives a frame that shares its timestamp a duration of zero', () => {
    const tb: Timebase = { timescale: 15360, ptsTicks: [0, 512, 512, 1024] };
    const d = frameDurations(tb);
    expect(d[0]).toBeCloseTo(512 / 15360, 8);
    // The container says frames 1 and 2 are simultaneous. Zero is the honest
    // answer, and it is what keeps a real step from being divided by nothing.
    expect(d[1]).toBe(0);
    expect(d[2]).toBeCloseTo(512 / 15360, 8);
  });

  it('does not infer a duration for the final frame', () => {
    const tb: Timebase = { timescale: 15360, ptsTicks: [0, 512, 1024] };
    const d = frameDurations(tb);
    expect(d[2]).toBe(0);
  });

  it('sums to the interval covered by observed timestamps', () => {
    const tb: Timebase = { timescale: 15360, ptsTicks: Array.from({ length: 50 }, (_, i) => i * 512) };
    const total = Array.from(frameDurations(tb)).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo((49 * 512) / 15360, 6);
  });
});

describe('frameAtTime', () => {
  it('uses presentation timestamps, clamps at both ends, and skips zero-duration duplicates', () => {
    const tb: Timebase = { timescale: 1000, ptsTicks: [0, 40, 80, 80, 160] };
    expect(frameAtTime(tb, -1)).toBe(0);
    expect(frameAtTime(tb, 0.079)).toBe(1);
    expect(frameAtTime(tb, 0.08)).toBe(3);
    expect(frameAtTime(tb, 99)).toBe(4);
    expect(frameAtTime({ timescale: 1000, ptsTicks: [] }, 0)).toBe(0);
  });
});

describe('timingUncertaintySec', () => {
  it('is zero for a clean file', () => {
    const pts = Array.from({ length: 100 }, (_, i) => i * 512);
    expect(timingUncertaintySec(describeTiming(15360, pts))).toBe(0);
  });

  it('is one frame for a file with timestamp defects', () => {
    const pts = [0, 512, 512, 1024, 1536];
    const u = timingUncertaintySec(describeTiming(15360, pts));
    expect(u).toBeCloseTo(512 / 15360, 8);
  });
});

describe('luminance range', () => {
  /**
   * Video Y is studio range: black at 16, white at 235.
   *
   * This test exists because of a real bug. The browser decoder handed back the
   * raw Y plane while the dev-side ffmpeg harness expanded it to full range, so
   * identical code on an identical file produced blobs about 4% smaller in the
   * browser. That was enough to move an escape-hole suggestion from one hole to
   * another and flip a trial's search strategy from serial to spatial: the app
   * and the numbers committed to this repo disagreed.
   *
   * The expansion below was verified against `ffmpeg -vf format=gray` on a real
   * frame of `test50`, with a maximum per-pixel difference of zero.
   */
  const expand = (v: number) => Math.max(0, Math.min(255, Math.round(((v - 16) * 255) / 219)));

  it('maps studio black and white onto the full range', () => {
    expect(expand(16)).toBe(0);
    expect(expand(235)).toBe(255);
  });

  it('clamps values outside the studio range rather than wrapping them', () => {
    expect(expand(0)).toBe(0);
    expect(expand(8)).toBe(0);
    expect(expand(255)).toBe(255);
    expect(expand(240)).toBe(255);
  });

  it('is monotonic, so it cannot reorder two gray levels', () => {
    for (let v = 1; v < 256; v++) expect(expand(v)).toBeGreaterThanOrEqual(expand(v - 1));
  });

  /**
   * The reason the bug mattered: it is not a small correction. A mid-gray
   * platform against a dark animal gains about a seventh more contrast, and the
   * detector threshold is expressed in gray levels.
   */
  it('adds about 14% of contrast, which is why a threshold in gray levels moves', () => {
    const rawContrast = 160 - 40;
    const expandedContrast = expand(160) - expand(40);
    expect(expandedContrast / rawContrast).toBeGreaterThan(1.1);
    expect(expandedContrast / rawContrast).toBeLessThan(1.2);
  });
});
