import { describe, expect, it } from 'vitest';
import { detectEvents } from '../src/paradigms/barnes/events';
import { CENTER, hold, makeFrames, makeGeometry, makeTimebase, nearHole, params } from './helpers/synthetic';

const BODY = 700;

function run(specs: Parameters<typeof makeFrames>[0], target: number | null = null, over = {}) {
  const frames = makeFrames(specs, BODY);
  const geometry = makeGeometry(target);
  const timebase = makeTimebase(frames.length);
  return detectEvents({
    frames,
    geometry,
    params: params(over),
    timebase,
    bodyAreaPx: BODY,
    trialStartFrame: 0,
  });
}

const away = { nose: CENTER };

describe('investigations', () => {
  it('records a hole the nose lingered at', () => {
    const { events } = run([...hold(10, away), ...hold(30, { nose: nearHole(5, 1) }), ...hold(10, away)]);
    const inv = events.filter((e) => e.type === 'investigation');
    expect(inv).toHaveLength(1);
    expect(inv[0]!.holeIndex).toBe(5);
    expect(inv[0]!.minNoseDistanceCm).toBeCloseTo(1, 1);
  });

  /** The scoring disagreement that started all this: does a fly-past count? */
  it('ignores a hole the nose only flew past', () => {
    // Two frames at 30 fps is 0.067 s, well under the 0.25 s dwell.
    const { events } = run([...hold(10, away), ...hold(2, { nose: nearHole(5, 1) }), ...hold(10, away)]);
    expect(events.filter((e) => e.type === 'investigation')).toHaveLength(0);
  });

  it('counts a fly-past once the dwell threshold is lowered, and says so in the evidence', () => {
    const specs = [...hold(10, away), ...hold(2, { nose: nearHole(5, 1) }), ...hold(10, away)];
    const { events } = run(specs, null, { events: { ...params().events, minInvestigationSec: 0.05 } });
    const inv = events.filter((e) => e.type === 'investigation');
    expect(inv).toHaveLength(1);
    expect(inv[0]!.evidence).toMatch(/at least 0.05 s/);
  });

  it('uses elapsed timestamps rather than frame count for the dwell threshold', () => {
    const specs = [away, { nose: nearHole(5, 1) }, { nose: nearHole(5, 1) }, away];
    const frames = makeFrames(specs, BODY);
    const geometry = makeGeometry(null);
    const p = params();
    const detect = (ptsTicks: number[]) => detectEvents({
      frames,
      geometry,
      params: p,
      timebase: { timescale: 1000, ptsTicks },
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    }).events.filter((event) => event.type === 'investigation');

    expect(detect([0, 100, 200, 600])).toHaveLength(1);
    expect(detect([0, 100, 150, 200])).toHaveLength(0);
  });

  it('ignores a hole the nose never got close to', () => {
    const { events } = run([...hold(40, { nose: nearHole(5, 8) })]);
    expect(events.filter((e) => e.type === 'investigation')).toHaveLength(0);
  });

  it('respects the investigation radius', () => {
    const specs = [...hold(10, away), ...hold(30, { nose: nearHole(5, 4) }), ...hold(10, away)];
    expect(run(specs).events.filter((e) => e.type === 'investigation')).toHaveLength(0);
    const loose = run(specs, null, { events: { ...params().events, investigationRadiusCm: 5 } });
    expect(loose.events.filter((e) => e.type === 'investigation')).toHaveLength(1);
  });

  /**
   * The regression this guards: without hysteresis, an animal parked at a hole
   * holds its nose right about at the threshold, sub-pixel jitter flickers it in
   * and out, and one long investigation is reported as several. Measured on
   * `test51` hole 18.
   */
  it('does not fragment one long visit when the nose hovers at the threshold', () => {
    const inside = { nose: nearHole(5, 2.6) };
    const outside = { nose: nearHole(5, 3.4) };
    const chatter = [];
    for (let i = 0; i < 12; i++) chatter.push(...hold(5, inside), ...hold(5, outside));
    const { events } = run([...hold(10, away), ...chatter, ...hold(10, away)]);
    expect(events.filter((e) => e.type === 'investigation')).toHaveLength(1);
  });

  it('keeps genuinely separate visits to the same hole separate', () => {
    const at5 = { nose: nearHole(5, 1) };
    // Three seconds away is not a wobble.
    const { events } = run([...hold(20, at5), ...hold(90, away), ...hold(20, at5)]);
    expect(events.filter((e) => e.type === 'investigation')).toHaveLength(2);
  });

  it('merges a visit interrupted by a brief excursion', () => {
    const at5 = { nose: nearHole(5, 1) };
    // 0.4 s away, under the 0.75 s merge gap.
    const { events } = run([...hold(20, at5), ...hold(12, away), ...hold(20, at5)]);
    expect(events.filter((e) => e.type === 'investigation')).toHaveLength(1);
  });

  it('separates visits to different holes', () => {
    const { events } = run([...hold(20, { nose: nearHole(5, 1) }), ...hold(20, { nose: nearHole(9, 1) })]);
    const inv = events.filter((e) => e.type === 'investigation');
    expect(inv.map((e) => e.holeIndex)).toEqual([5, 9]);
  });

  it('uses stable hole indices even when the stored array is reordered', () => {
    const frames = makeFrames([...hold(20, { nose: nearHole(5, 1) })], BODY);
    const base = makeGeometry(null);
    const result = detectEvents({
      frames,
      geometry: { ...base, holes: [...base.holes].reverse() },
      params: params(),
      timebase: makeTimebase(frames.length),
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    });
    expect(result.events[0]).toMatchObject({ holeIndex: 5 });
    expect(result.events[0]!.minNoseDistanceCm).toBeCloseTo(1, 1);
  });

  it('does not treat an interpolated point as evidence of a hole visit', () => {
    const frames = makeFrames(hold(30, { nose: nearHole(5, 1) }), BODY)
      .map((frame) => ({ ...frame, interpolated: true }));
    const result = detectEvents({
      frames,
      geometry: makeGeometry(7),
      params: params(),
      timebase: makeTimebase(frames.length),
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    });
    expect(result.events).toEqual([]);
  });
});

describe('errors', () => {
  const visit = (h: number) => hold(20, { nose: nearHole(h, 1) });

  it('does not count the target as an error', () => {
    const { events } = run([...visit(3), ...visit(7)], 7);
    const errors = events.filter((e) => e.isError);
    expect(errors.map((e) => e.holeIndex)).toEqual([3]);
  });

  it('counts each hole once under unique counting', () => {
    const { events } = run([...visit(3), ...hold(60, { nose: CENTER }), ...visit(3), ...visit(7)], 7);
    expect(events.filter((e) => e.isError)).toHaveLength(1);
  });

  it('counts every visit under all-visits counting', () => {
    const specs = [...visit(3), ...hold(60, { nose: CENTER }), ...visit(3), ...visit(7)];
    const { events } = run(specs, 7, { events: { ...params().events, errorCounting: 'all' as const } });
    expect(events.filter((e) => e.isError)).toHaveLength(2);
  });

  it('can treat the holes either side of the target as near-misses', () => {
    const specs = [...visit(6), ...visit(8), ...visit(3)];
    expect(run(specs, 7).events.filter((e) => e.isError)).toHaveLength(3);
    const lenient = run(specs, 7, { events: { ...params().events, adjacentHolesAreErrors: false } });
    expect(lenient.events.filter((e) => e.isError).map((e) => e.holeIndex)).toEqual([3]);
  });

  it('wraps around the ring when deciding which holes are adjacent', () => {
    const specs = [...visit(19), ...visit(1)];
    const lenient = run(specs, 0, { events: { ...params().events, adjacentHolesAreErrors: false } });
    expect(lenient.events.filter((e) => e.isError)).toHaveLength(0);
  });

  it('counts no errors at all when no target is set, and says why', () => {
    const { events, warnings } = run([...visit(3), ...visit(7)], null);
    expect(events.filter((e) => e.isError)).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/No target hole/);
  });
});

describe('entries', () => {
  /**
   * An entry is not "the nose got very close". It is the visible area of the
   * animal collapsing while it stays on one hole, which is what a mouse putting
   * its head down a hole actually looks like.
   */
  it('is called when the visible area collapses and holds', () => {
    const at = nearHole(5, 1.5);
    const { events } = run([
      ...hold(20, { nose: at }),
      ...hold(30, { nose: at, areaPx: Math.round(BODY * 0.2) }),
    ]);
    const entries = events.filter((e) => e.type === 'entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.holeIndex).toBe(5);
    expect(entries[0]!.minAreaRatio).toBeCloseTo(0.2, 1);
    expect(entries[0]!.evidence).toMatch(/Visible area/);
  });

  /** A proximity event without the configured area collapse is not an entry. */
  it('is not called when the animal only has its head at the hole', () => {
    const at = nearHole(5, 2.5);
    const { events } = run([
      ...hold(20, { nose: at }),
      ...hold(60, { nose: at, areaPx: Math.round(BODY * 0.49) }),
    ]);
    expect(events.filter((e) => e.type === 'entry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'investigation')).toHaveLength(1);
  });

  it('is not called for a brief dip in visible area', () => {
    const at = nearHole(5, 1.5);
    const { events } = run([
      ...hold(20, { nose: at }),
      ...hold(6, { nose: at, areaPx: Math.round(BODY * 0.2) }), // 0.2 s, under the 0.5 s minimum
      ...hold(20, { nose: at }),
    ]);
    expect(events.filter((e) => e.type === 'entry')).toHaveLength(0);
  });

  it('uses elapsed timestamps rather than frame count for the entry threshold', () => {
    const at = nearHole(5, 1.5);
    const frames = makeFrames([
      ...hold(2, { nose: at }),
      ...hold(2, { nose: at, areaPx: Math.round(BODY * 0.2) }),
      { nose: at },
    ], BODY);
    const result = detectEvents({
      frames,
      geometry: makeGeometry(5),
      params: params(),
      timebase: { timescale: 1000, ptsTicks: [0, 100, 200, 300, 800] },
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    });
    expect(result.events.filter((event) => event.type === 'entry')).toHaveLength(1);
  });

  it('does not turn an automatically inferred absence into entry evidence', () => {
    const at = nearHole(5, 1.5);
    const { events } = run([
      ...hold(20, { nose: at }),
      ...hold(30, { nose: at, areaPx: 0, status: 'inHole' as const, holeIndex: 5 }),
    ]);
    expect(events.filter((e) => e.type === 'entry')).toHaveLength(0);
  });

  it('keeps a manually labeled inside-hole frame\'s measured visible area', () => {
    const frames = makeFrames(
      hold(20, {
        nose: nearHole(5, 1),
        areaPx: BODY,
        status: 'inHole' as const,
        holeIndex: 5,
        provenance: 'manual' as const,
      }),
      BODY,
    );
    const result = detectEvents({
      frames,
      geometry: makeGeometry(7),
      params: params(),
      timebase: makeTimebase(frames.length),
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    });
    expect(result.events.find((event) => event.type === 'investigation')?.minAreaRatio).toBe(1);
    expect(Number.isNaN(result.events.find((event) => event.type === 'entry')!.minAreaRatio)).toBe(true);
  });

  it('does not invent visible-area evidence for an imported pose track', () => {
    const at = nearHole(5, 1.5);
    const frames = makeFrames([
      ...hold(20, { nose: at }),
      ...hold(30, { nose: at, areaPx: 0 }),
    ], BODY).map((frame) => ({ ...frame, areaMeasured: false }));
    const geometry = makeGeometry(5);
    const timebase = makeTimebase(frames.length);
    const { events } = detectEvents({
      frames,
      geometry,
      params: params(),
      timebase,
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    });
    expect(events.filter((event) => event.type === 'entry')).toHaveLength(0);
    expect(Number.isNaN(events.find((event) => event.type === 'investigation')!.minAreaRatio)).toBe(true);
  });

  it('labels events derived from imported pose coordinates as imported', () => {
    const at = nearHole(5, 1.5);
    const { events } = run([...hold(20, { nose: at, provenance: 'imported' })]);
    expect(events.find((event) => event.type === 'investigation')!.provenance).toBe('imported');
  });

  it('accepts an explicit manual inside-hole label as entry evidence', () => {
    const at = nearHole(5, 1.5);
    const { events } = run([
      ...hold(20, { nose: at }),
      { nose: at, areaPx: 0, status: 'inHole' as const, holeIndex: 5, provenance: 'manual' as const },
    ]);
    const entries = events.filter((e) => e.type === 'entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.provenance).toBe('manual');
  });

  it('keeps an isolated manual inside-hole label even below the automatic dwell threshold', () => {
    const at = nearHole(5, 1.5);
    const { events } = run([
      { nose: CENTER },
      { nose: at, areaPx: 0, status: 'inHole' as const, holeIndex: 5, provenance: 'manual' as const },
      { nose: CENTER },
    ]);

    expect(events.filter((event) => event.type === 'investigation')).toEqual([
      expect.objectContaining({ holeIndex: 5, provenance: 'manual' }),
    ]);
    expect(events.filter((event) => event.type === 'entry')).toEqual([
      expect.objectContaining({ holeIndex: 5, startFrame: 1, provenance: 'manual' }),
    ]);
  });

  it('accepts a manual inside-hole label without inventing a body-area estimate', () => {
    const at = nearHole(5, 1.5);
    const frames = makeFrames([
      ...hold(20, { nose: at }),
      { nose: at, status: 'inHole' as const, holeIndex: 5, provenance: 'manual' as const },
    ], BODY).map((frame) => ({ ...frame, areaMeasured: false, areaPx: 0 }));
    const result = detectEvents({
      frames,
      geometry: makeGeometry(5),
      params: params(),
      timebase: makeTimebase(frames.length),
      bodyAreaPx: 0,
      trialStartFrame: 0,
    });
    expect(result.events.filter((event) => event.type === 'entry')).toHaveLength(1);
    expect(result.events.find((event) => event.type === 'entry')!.provenance).toBe('manual');
  });

  it('does not double-count an entry as an extra error', () => {
    const at = nearHole(5, 1.5);
    const { events } = run(
      [...hold(20, { nose: at }), ...hold(30, { nose: at, areaPx: Math.round(BODY * 0.2) })],
      9,
    );
    expect(events.filter((e) => e.isError)).toHaveLength(1);
    expect(events.find((e) => e.type === 'entry')!.isError).toBe(false);
  });
});

describe('target hole suggestion', () => {
  it('is confident when a terminal entry signature is detected', () => {
    const at = nearHole(5, 1.5);
    const { targetSuggestion } = run([
      ...hold(20, { nose: at }),
      ...hold(40, { nose: at, areaPx: Math.round(BODY * 0.2) }),
    ]);
    expect(targetSuggestion?.holeIndex).toBe(5);
    expect(targetSuggestion?.confidence).toBe('high');
  });

  /** Terminal dwell is stronger suggestion evidence than an earlier pause. */
  it('prefers where the animal ends over where it spent the most time', () => {
    const { targetSuggestion } = run([
      ...hold(150, { nose: nearHole(11, 1) }), // 5 s here
      ...hold(30, { nose: CENTER }),
      ...hold(60, { nose: nearHole(18, 1) }), // 2 s, but it ends here
    ]);
    expect(targetSuggestion?.holeIndex).toBe(18);
    expect(targetSuggestion?.confidence).toBe('medium');
  });

  it('falls back to the longest dwell, flagged as weak, when the animal ends nowhere', () => {
    const { targetSuggestion } = run([
      ...hold(150, { nose: nearHole(11, 1) }),
      ...hold(60, { nose: nearHole(18, 1) }),
      ...hold(60, { nose: CENTER }),
    ]);
    expect(targetSuggestion?.holeIndex).toBe(11);
    expect(targetSuggestion?.confidence).toBe('low');
    expect(targetSuggestion?.evidence).toMatch(/Low-confidence suggestion/);
  });

  it('offers nothing when the animal never visited a hole', () => {
    expect(run(hold(60, { nose: CENTER })).targetSuggestion).toBeNull();
  });
});

describe('trial start', () => {
  it('ignores everything before the trial started', () => {
    const frames = makeFrames([...hold(30, { nose: nearHole(5, 1) }), ...hold(30, { nose: nearHole(9, 1) })], BODY);
    const result = detectEvents({
      frames,
      geometry: makeGeometry(null),
      params: params(),
      timebase: makeTimebase(frames.length),
      bodyAreaPx: BODY,
      trialStartFrame: 30,
    });
    const inv = result.events.filter((e) => e.type === 'investigation');
    expect(inv.map((e) => e.holeIndex)).toEqual([9]);
  });

  it('ignores events that begin after the protocol cutoff', () => {
    const frames = makeFrames([
      ...hold(40, away),
      ...hold(30, { nose: nearHole(9, 1) }),
    ], BODY);
    const result = detectEvents({
      frames,
      geometry: makeGeometry(9),
      params: params({ trialCutoffSec: 1 }),
      timebase: makeTimebase(frames.length),
      bodyAreaPx: BODY,
      trialStartFrame: 0,
    });
    expect(result.events).toHaveLength(0);
  });
});
