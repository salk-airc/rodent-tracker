import { describe, expect, it } from 'vitest';
import { detectEvents } from '../src/events';
import { classifyStrategy } from '../src/measures/strategy';
import { frameDurations } from '../src/time';
import { CENTER, PX_PER_CM, RING_R, hold, makeFrames, makeGeometry, makeTimebase, nearHole, params } from './helpers/synthetic';

const BODY = 700;

function classify(specs: Parameters<typeof makeFrames>[0], target: number, coverage = 1, over = {}) {
  const frames = makeFrames(specs, BODY);
  const geometry = makeGeometry(target);
  const timebase = makeTimebase(frames.length);
  const p = params(over);
  const { events } = detectEvents({ frames, geometry, params: p, timebase, bodyAreaPx: BODY, trialStartFrame: 0 });
  const targetVisit = events.find((e) => e.type === 'investigation' && e.isTarget);
  return classifyStrategy({
    frames,
    events,
    geometry,
    params: p.strategy,
    centerZoneFraction: p.centerZoneFraction,
    trialStartFrame: 0,
    trialEndFrame: frames.length - 1,
    primaryFrame: targetVisit?.startFrame ?? null,
    frameDurationsSec: frameDurations(timebase),
    coverage,
  });
}

/** A straight run from the platform center out to a hole. */
function runToHole(hole: number, steps = 40) {
  const target = makeGeometry().holes[hole]!.center;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ nose: { x: CENTER.x + (target.x - CENTER.x) * t, y: CENTER.y + (target.y - CENTER.y) * t } });
  }
  return out;
}

/** Work around the rim, hole by hole, in order. */
function sweep(from: number, count: number, framesPerHole = 12) {
  const out = [];
  for (let k = 0; k < count; k++) out.push(...hold(framesPerHole, { nose: nearHole((from + k) % 20, 1) }));
  return out;
}

describe('spatial', () => {
  it('is called for a direct run to the target', () => {
    const r = classify([...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })], 5);
    expect(r.strategy).toBe('spatial');
    expect(r.features.pathEfficiency).toBeGreaterThan(0.7);
    expect(r.notes).toMatch(/straight to the target/);
  });

  it('is not called when the animal checked several wrong holes on the way', () => {
    const r = classify([...runToHole(5), ...sweep(9, 4), ...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })], 5);
    expect(r.strategy).not.toBe('spatial');
  });

  it('names the thresholds it used, so a disagreement has something to argue with', () => {
    const r = classify([...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })], 5);
    expect(r.notes).toMatch(/threshold 0\.7/);
    expect(r.rule).toMatch(/spatial/);
  });
});

describe('serial', () => {
  /**
   * This is `test50`: eight consecutive holes in one direction, twice around,
   * 91% of the trial spent at the rim. It is also the classification most often
   * scored inconsistently by eye, which is the reason for showing the features.
   */
  it('is called for a systematic sweep around the ring', () => {
    const r = classify(sweep(4, 8), 15);
    expect(r.strategy).toBe('serial');
    expect(r.features.longestSerialRun).toBeGreaterThanOrEqual(4);
    expect(r.features.peripheryFraction).toBeGreaterThan(0.6);
  });

  it('is not called for a sweep that keeps crossing the middle', () => {
    const out = [];
    for (let k = 0; k < 8; k++) {
      out.push(...hold(12, { nose: nearHole((4 + k) % 20, 1) }));
      out.push(...hold(12, { nose: CENTER }));
    }
    const r = classify(out, 15);
    expect(r.strategy).not.toBe('serial');
  });

  it('is not called when the holes checked are scattered', () => {
    const r = classify(
      [...hold(12, { nose: nearHole(2, 1) }), ...hold(12, { nose: nearHole(11, 1) }), ...hold(12, { nose: nearHole(6, 1) }), ...hold(12, { nose: nearHole(17, 1) })],
      15,
    );
    expect(r.strategy).not.toBe('serial');
  });

  it('fires on a sweep that wraps past hole 0', () => {
    const r = classify(sweep(17, 6), 8);
    expect(r.strategy).toBe('serial');
  });
});

describe('random', () => {
  it('is called for a search that keeps crossing the middle', () => {
    const out = [];
    for (const h of [3, 12, 7, 16]) {
      out.push(...hold(12, { nose: nearHole(h, 1) }));
      out.push(...hold(12, { nose: CENTER }));
    }
    // Reach the target the long way round so the route is informative.
    out.push(...hold(20, { nose: nearHole(10, 1) }));
    const r = classify(out, 10);
    expect(r.strategy).toBe('random');
    expect(r.features.centerCrossings).toBeGreaterThanOrEqual(2);
  });

  it('is not assigned merely because spatial and serial rules did not match', () => {
    const r = classify(
      [
        ...hold(20, { nose: nearHole(0, 1) }),
        ...hold(20, { nose: nearHole(7, 1) }),
        ...hold(20, { nose: nearHole(14, 1) }),
      ],
      10,
    );
    expect(r.features.centerCrossings).toBe(0);
    expect(r.strategy).toBe('unclassified');
    expect(r.rule).toBe('insufficient-pattern-evidence');
  });
});

describe('refusing to classify', () => {
  it('will not classify when too little of the trial was tracked', () => {
    const r = classify([...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })], 5, 0.4);
    expect(r.strategy).toBe('unclassified');
    expect(r.rule).toBe('insufficient-coverage');
  });

  it('will not classify without a target hole', () => {
    const frames = makeFrames([...runToHole(5)], BODY);
    const geometry = makeGeometry(null);
    const timebase = makeTimebase(frames.length);
    const p = params();
    const { events } = detectEvents({ frames, geometry, params: p, timebase, bodyAreaPx: BODY, trialStartFrame: 0 });
    const r = classifyStrategy({
      frames, events, geometry, params: p.strategy, centerZoneFraction: p.centerZoneFraction,
      trialStartFrame: 0, trialEndFrame: frames.length - 1, primaryFrame: null,
      frameDurationsSec: frameDurations(timebase), coverage: 1,
    });
    expect(r.strategy).toBe('unclassified');
    expect(r.rule).toBe('no-target');
  });

  /**
   * `test53`: the animal appears beside hole 0 with the escape at hole 1 and
   * reaches it with a path efficiency of 1.00. Calling that a spatial search
   * would credit the animal for where the experimenter put it.
   */
  it('will not call a trial spatial when the animal started next to the target', () => {
    const r = classify([...hold(10, { nose: nearHole(4, 3) }), ...hold(30, { nose: nearHole(5, 1) })], 5);
    expect(r.strategy).toBe('unclassified');
    expect(r.rule).toBe('route-not-informative');
    expect(r.notes).toMatch(/from the target hole/);
    expect(r.features.startDistanceCm).toBeLessThan(20);
  });

  it('does not use a post-target sweep to assign the search strategy', () => {
    const r = classify(sweep(4, 8), 4);
    expect(r.features.startDistanceCm).toBeLessThan(25);
    expect(r.strategy).toBe('unclassified');
    expect(r.features.longestSerialRun).toBe(1);
  });
});

describe('features', () => {
  it('reports the distance from the start to the target', () => {
    const r = classify([...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })], 5);
    expect(r.features.startDistanceCm).toBeCloseTo(RING_R / PX_PER_CM, 0);
  });

  it('does not count leaving the center at the start as a center crossing', () => {
    const r = classify([...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })], 5);
    expect(r.features.centerCrossings).toBe(0);
  });

  it('does not count a center crossing after the target was reached', () => {
    const out = [...runToHole(5), ...hold(20, { nose: nearHole(5, 1) })];
    for (let i = 40; i >= 0; i--) {
      const t = i / 40;
      const tgt = makeGeometry().holes[5]!.center;
      out.push({ nose: { x: CENTER.x + (tgt.x - CENTER.x) * t, y: CENTER.y + (tgt.y - CENTER.y) * t } });
    }
    out.push(...hold(20, { nose: CENTER }));
    const r = classify(out, 5);
    expect(r.features.centerCrossings).toBe(0);
  });

  /**
   * Turn rate taken from frame-to-frame steps is heading noise: a one-pixel
   * step carries almost no directional information, and an early version
   * reported 636 deg/s for an animal barely moving.
   */
  it('reports a low turn rate for an animal walking in a straight line', () => {
    const specs = [];
    for (let i = 0; i < 120; i++) specs.push({ nose: { x: CENTER.x - 150 + i * 2.5, y: CENTER.y } });
    const r = classify(specs, 0);
    expect(r.features.meanTurnRateDegPerSec).toBeLessThan(20);
  });
});
