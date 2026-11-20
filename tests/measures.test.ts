import { describe, expect, it } from 'vitest';
import { detectEvents } from '../src/events';
import { computeMeasures } from '../src/measures/compute';
import { longestConsecutiveRun } from '../src/measures/strategy';

import type { TrackingQuality, Timebase } from '../src/types';
import { CENTER, PX_PER_CM, hold, makeFrames, makeGeometry, makeTimebase, nearHole, params } from './helpers/synthetic';

const BODY = 700;

const quality = (over: Partial<TrackingQuality> = {}): TrackingQuality => ({
  frameCount: 0,
  trackedFrames: 0,
  partialFrames: 0,
  inHoleFrames: 0,
  lostFrames: 0,
  preTrialFrames: 0,
  postTrialFrames: 0,
  manuallyEditedFrames: 0,
  measuredPositionFrames: 0,
  measuredPositionFraction: 1,
  trackedFraction: 1,
  bodyAreaPx: BODY,
  longestGapFrames: 0,
  longestGapStart: null,
  warnings: [],
  ...over,
});

function measure(
  specs: Parameters<typeof makeFrames>[0],
  target: number | null,
  over = {},
  timebase?: Timebase,
  trialStartFrame = 0,
) {
  const frames = makeFrames(specs, BODY);
  const geometry = makeGeometry(target);
  const tb = timebase ?? makeTimebase(frames.length);
  const p = params(over);
  const { events } = detectEvents({ frames, geometry, params: p, timebase: tb, bodyAreaPx: BODY, trialStartFrame });
  return {
    events,
    measures: computeMeasures({
      videoId: 'synthetic',
      frames,
      events,
      geometry,
      params: p,
      timebase: tb,
      trialStartFrame,
      quality: quality({ frameCount: frames.length, trackedFrames: frames.length }),
    }),
  };
}

const away = { nose: CENTER };
const visit = (h: number, n = 20) => hold(n, { nose: nearHole(h, 1) });

describe('latency', () => {
  it('measures primary latency from the trial start, not the file start', () => {
    // 60 frames of pre-trial at 30 fps = 2 s, then the animal reaches hole 5.
    const specs = [...hold(60, away), ...hold(30, away), ...visit(5)];
    const { measures } = measure(specs, 5, {}, makeTimebase(specs.length), 60);
    expect(measures.primaryLatency.observed).toBe(true);
    // Reached at frame 90, trial started at 60: one second.
    expect(measures.primaryLatency.sec).toBeCloseTo(1, 2);
    expect(measures.primaryLatency.frame).toBe(90);
  });

  it('measures total latency at the entry, which is later than the first approach', () => {
    const at = nearHole(5, 1.5);
    const specs = [...hold(30, away), ...hold(60, { nose: at }), ...hold(30, { nose: at, areaPx: Math.round(BODY * 0.2) })];
    const { measures } = measure(specs, 5);
    expect(measures.primaryLatency.sec).toBeCloseTo(1, 2);
    expect(measures.totalLatency.observed).toBe(true);
    expect(measures.totalLatency.sec).toBeCloseTo(3, 2);
    expect(measures.totalLatency.sec).toBeGreaterThan(measures.primaryLatency.sec);
  });

  it('carries a human event into the latency provenance instead of calling it automatic', () => {
    const specs = [
      ...hold(10, away),
      ...hold(20, { nose: nearHole(5, 1), provenance: 'manual' as const }),
    ];
    const { measures } = measure(specs, 5);
    expect(measures.primaryLatency.observed).toBe(true);
    expect(measures.primaryLatency.provenance).toBe('manual');
  });

  /** An undetected event is a censored lower bound, not a fabricated event time. */
  it('censors an undetected latency at the observed endpoint', () => {
    const specs = hold(300, away); // 10 s of wandering, 180 s cutoff
    const { measures } = measure(specs, 5, { trialCutoffSec: 180 });
    expect(measures.totalLatency.observed).toBe(false);
    expect(measures.totalLatency.frame).toBeNull();
    expect(measures.totalLatency.provenance).toBe('censored_cutoff');
    // The recording is only 10 s long, so claiming "at least 180 s" would be
    // a statement the data does not support.
    expect(measures.totalLatency.sec).toBeCloseTo(299 / 30, 1);
  });

  it('censors at the cutoff when the recording is longer than the cutoff', () => {
    const specs = hold(6000, away); // 200 s at 30 fps
    const { measures } = measure(specs, 5, { trialCutoffSec: 180 });
    expect(measures.totalLatency.observed).toBe(false);
    expect(measures.totalLatency.sec).toBe(180);
    expect(measures.warnings.join(' ')).toMatch(/censored/);
  });

  it('does not turn a target visit after the cutoff into an observed latency', () => {
    const specs = [...hold(40, away), ...visit(5, 30)];
    const { measures } = measure(specs, 5, { trialCutoffSec: 1 });
    expect(measures.primaryLatency).toMatchObject({ observed: false, sec: 1, frame: null });
  });
});

describe('errors', () => {
  it('splits primary from total errors at the first target visit', () => {
    const specs = [...visit(1), ...visit(2), ...visit(5), ...visit(8), ...visit(9)];
    const { measures } = measure(specs, 5);
    expect(measures.primaryErrors).toBe(2);
    expect(measures.totalErrors).toBe(4);
  });

  it('stops counting total errors at the escape', () => {
    const at = nearHole(5, 1.5);
    const specs = [
      ...visit(1),
      ...hold(20, { nose: at }),
      ...hold(30, { nose: at, areaPx: Math.round(BODY * 0.2) }),
      ...visit(8), // after the escape; should not be counted
    ];
    const { events, measures } = measure(specs, 5);
    expect(measures.totalErrors).toBe(1);
    expect(events.some((event) => event.holeIndex === 8)).toBe(false);
  });

  it('marks error counts unavailable when no frame can support a hole visit', () => {
    const frames = makeFrames(hold(30, { nose: CENTER, status: 'lost' as const, areaPx: 0 }), BODY)
      .map((frame) => ({ ...frame, body: null, nose: null }));
    const geometry = makeGeometry(5);
    const timebase = makeTimebase(frames.length);
    const measures = computeMeasures({
      videoId: 'missing',
      frames,
      events: [],
      geometry,
      params: params(),
      timebase,
      trialStartFrame: 0,
      quality: quality({ frameCount: frames.length, lostFrames: frames.length, measuredPositionFraction: 0 }),
    });
    expect(measures.primaryErrors).toBe(0);
    expect(measures.totalErrors).toBe(0);
    expect(measures.primaryErrorCoverage).toBe(0);
    expect(measures.totalErrorCoverage).toBe(0);
    expect(measures.warnings.join(' ')).toMatch(/Error counts are unavailable/);
  });

  it('marks partially observed error counts as lower bounds', () => {
    const measured = makeFrames(hold(15, { nose: CENTER }), BODY);
    const missing = makeFrames(hold(15, { nose: CENTER, status: 'lost' as const, areaPx: 0 }), BODY)
      .map((frame, index) => ({ ...frame, frame: index + 15, body: null, nose: null }));
    const frames = [...measured, ...missing];
    const geometry = makeGeometry(5);
    const timebase = makeTimebase(frames.length);
    const measures = computeMeasures({
      videoId: 'partial', frames, events: [], geometry, params: params(), timebase, trialStartFrame: 0,
      quality: quality({ frameCount: frames.length }),
    });
    expect(measures.totalErrorCoverage).toBeCloseTo(0.5);
    expect(measures.warnings.join(' ')).toMatch(/lower bounds/);
  });
});

describe('path length and speed', () => {
  it('converts pixels to centimeters using the stated platform diameter', () => {
    // Walk 40 cm in a straight line across the middle of the platform.
    const specs = [];
    for (let i = 0; i <= 40; i++) specs.push({ nose: { x: CENTER.x - 100 + i * PX_PER_CM, y: CENTER.y } });
    const { measures } = measure(specs, null);
    expect(measures.pathLengthCm).toBeCloseTo(40, 0);
  });

  it('halves the reported distance when the platform is declared half as wide', () => {
    const specs = [];
    for (let i = 0; i <= 40; i++) specs.push({ nose: { x: CENTER.x - 100 + i * PX_PER_CM, y: CENTER.y } });
    const frames = makeFrames(specs, BODY);
    const tb = makeTimebase(frames.length);
    const p = params();
    const measures = (diameterCm: number) => {
      const geometry = makeGeometry(null, diameterCm);
      const { events } = detectEvents({ frames, geometry, params: p, timebase: tb, bodyAreaPx: BODY, trialStartFrame: 0 });
      return computeMeasures({
        videoId: 'x', frames, events, geometry, params: p, timebase: tb, trialStartFrame: 0,
        quality: quality(),
      });
    };
    expect(measures(45.75).pathLengthCm).toBeCloseTo(measures(91.5).pathLengthCm / 2, 1);
  });

  /**
   * The regression this guards. These files contain presentation-timestamp
   * intervals of a single tick — 0.067 ms — left behind by the re-encode. An
   * ordinary 0.6 cm step across one of those divides out to 8,775 cm/s, which
   * is what an early version reported as the animal's top speed.
   */
  it('is not fooled by a single-tick timestamp interval', () => {
    const timescale = 15000;
    const nominal = 1001;
    const ptsTicks: number[] = [];
    for (let i = 0; i < 60; i++) ptsTicks.push(i * nominal);
    // Frame 30 lands one tick after frame 29, as happens in test51.
    ptsTicks[30] = ptsTicks[29]! + 1;
    const timebase: Timebase = { timescale, ptsTicks };

    const specs = [];
    for (let i = 0; i < 60; i++) specs.push({ nose: { x: CENTER.x + i * 3, y: CENTER.y } });
    const { measures } = measure(specs, null, {}, timebase);
    // Three pixels per frame at ~15 fps is about 10 cm/s. Anything in the
    // thousands means an interval was divided by when it should not have been.
    expect(measures.maxSpeedCmPerSec).toBeLessThan(60);
    expect(measures.maxSpeedCmPerSec).toBeGreaterThan(1);
  });

  it('reports moving speed separately, so a long freeze does not halve the mean', () => {
    const specs = [];
    for (let i = 0; i < 30; i++) specs.push({ nose: { x: CENTER.x + i * 4, y: CENTER.y } });
    specs.push(...hold(120, { nose: { x: CENTER.x + 29 * 4, y: CENTER.y } })); // 4 s frozen
    const { measures } = measure(specs, null);
    expect(measures.meanMovingSpeedCmPerSec).toBeGreaterThan(measures.meanSpeedCmPerSec * 2);
  });

  it('reports how much of the trial the path length actually covers', () => {
    const specs = [
      ...hold(30, { nose: CENTER }),
      ...hold(30, { nose: CENTER, status: 'lost' as const, areaPx: 0 }),
      ...hold(30, { nose: CENTER }),
    ];
    const frames = makeFrames(specs, BODY).map((f, i) => (i >= 30 && i < 60 ? { ...f, body: null, nose: null } : f));
    const geometry = makeGeometry(null);
    const tb = makeTimebase(frames.length);
    const p = params();
    const { events } = detectEvents({ frames, geometry, params: p, timebase: tb, bodyAreaPx: BODY, trialStartFrame: 0 });
    const m = computeMeasures({
      videoId: 'x', frames, events, geometry, params: p, timebase: tb, trialStartFrame: 0, quality: quality(),
    });
    expect(m.pathLengthCoverage).toBeLessThan(0.75);
    expect(m.warnings.join(' ')).toMatch(/Missing, interpolated and in-hole positions are excluded/);
  });

  it('does not count an inferred hole center or bridge across it as traveled distance', () => {
    const oneCm = PX_PER_CM;
    const specs = [
      { nose: { x: CENTER.x, y: CENTER.y } },
      { nose: { x: CENTER.x + oneCm, y: CENTER.y } },
      { nose: nearHole(5, 1), status: 'inHole' as const, areaPx: 0, holeIndex: 5 },
      { nose: { x: CENTER.x + 100, y: CENTER.y } },
      { nose: { x: CENTER.x + 100 + oneCm, y: CENTER.y } },
    ];
    const { measures } = measure(specs, null);
    expect(measures.pathLengthCm).toBeCloseTo(2, 5);
    expect(measures.pathLengthCoverage).toBeCloseTo(0.5, 5);
  });

  it('stops path, duration, and quadrant measures at the protocol cutoff', () => {
    const specs = [...hold(31, { nose: nearHole(15, 1) })];
    for (let i = 0; i < 60; i++) {
      specs.push({ nose: { x: CENTER.x + i * PX_PER_CM, y: CENTER.y } });
    }
    const { measures } = measure(specs, 5, { trialCutoffSec: 1 });
    expect(measures.trialDurationSec).toBeCloseTo(1, 8);
    expect(measures.pathLengthCm).toBeCloseTo(0, 8);
    expect(measures.timeInTargetQuadrantSec).toBeLessThanOrEqual(measures.trialDurationSec);
  });
});

describe('target quadrant', () => {
  it('is defined by angle from the platform center, not by the image axes', () => {
    // Sit in the target's 90-degree sector for the whole trial.
    const specs = hold(60, { nose: nearHole(5, 1) });
    const { measures } = measure(specs, 5);
    expect(measures.targetQuadrantFraction).toBeCloseTo(1, 1);
  });

  it('is near zero on the opposite side of the maze', () => {
    const specs = hold(60, { nose: nearHole(15, 1) });
    const { measures } = measure(specs, 5);
    expect(measures.targetQuadrantFraction).toBeLessThan(0.05);
  });

  it('is a quarter of the time for an animal spread evenly round the ring', () => {
    const specs = [];
    for (let h = 0; h < 20; h++) specs.push(...hold(15, { nose: nearHole(h, 1) }));
    const { measures } = measure(specs, 5);
    expect(measures.targetQuadrantFraction).toBeGreaterThan(0.15);
    expect(measures.targetQuadrantFraction).toBeLessThan(0.35);
  });

  it('excludes interpolated positions from both the numerator and denominator', () => {
    const specs = [
      ...hold(30, { nose: nearHole(5, 1) }),
      ...hold(30, { nose: nearHole(15, 1) }),
    ];
    const frames = makeFrames(specs, BODY).map((frame, index) =>
      index < 30 ? frame : { ...frame, interpolated: true },
    );
    const geometry = makeGeometry(5);
    const tb = makeTimebase(frames.length);
    const p = params();
    const { events } = detectEvents({ frames, geometry, params: p, timebase: tb, bodyAreaPx: BODY, trialStartFrame: 0 });
    const measures = computeMeasures({
      videoId: 'x', frames, events, geometry, params: p, timebase: tb, trialStartFrame: 0, quality: quality(),
    });
    expect(measures.targetQuadrantFraction).toBeCloseTo(1, 5);
    expect(measures.targetQuadrantCoverage).toBeCloseTo(0.5, 1);
  });
});

describe('longestConsecutiveRun', () => {
  it('counts a sweep in one direction', () => {
    expect(longestConsecutiveRun([4, 5, 6, 7, 8], 20)).toBe(5);
  });

  it('counts a sweep in the other direction', () => {
    expect(longestConsecutiveRun([8, 7, 6, 5], 20)).toBe(4);
  });

  it('wraps around the ring', () => {
    expect(longestConsecutiveRun([18, 19, 0, 1], 20)).toBe(4);
  });

  it('ignores a repeat of the hole just checked', () => {
    expect(longestConsecutiveRun([4, 5, 5, 6, 7], 20)).toBe(4);
  });

  it('breaks the run when the animal jumps across the maze', () => {
    expect(longestConsecutiveRun([4, 5, 6, 15, 16], 20)).toBe(3);
  });

  it('breaks the run when the direction reverses', () => {
    expect(longestConsecutiveRun([4, 5, 6, 5, 4], 20)).toBe(3);
  });

  it('is 0 for an empty sequence and 1 for a single hole', () => {
    expect(longestConsecutiveRun([], 20)).toBe(0);
    expect(longestConsecutiveRun([7], 20)).toBe(1);
  });
});
