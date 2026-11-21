import { describe, expect, it } from 'vitest';
import { area, contains, distanceToEdge, type Shape } from '../src/arena/shapes';
import {
  calibrationResidualCm,
  homographyFromPoints,
  pxPerCmAt,
  scaleFromTwoPoints,
  toImage,
  toWorld,
} from '../src/arena/calibration';
import { arenaMask, arenaPxPerCm, openFieldZones, roundArenaZones, zonesAt } from '../src/arena/arena';
import { measureZones, type WorldSample } from '../src/arena/zoneMeasures';

describe('shapes', () => {
  const square: Shape = { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
  const plus: Shape = {
    kind: 'polygon',
    points: [
      { x: 4, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 10, y: 4 }, { x: 10, y: 6 }, { x: 6, y: 6 },
      { x: 6, y: 10 }, { x: 4, y: 10 }, { x: 4, y: 6 }, { x: 0, y: 6 }, { x: 0, y: 4 }, { x: 4, y: 4 },
    ],
  };

  it('tests containment for each kind', () => {
    expect(contains({ kind: 'circle', center: { x: 0, y: 0 }, radius: 5 }, { x: 3, y: 4 })).toBe(true);
    expect(contains({ kind: 'circle', center: { x: 0, y: 0 }, radius: 5 }, { x: 4, y: 4 })).toBe(false);
    expect(contains({ kind: 'rect', x: 0, y: 0, width: 2, height: 1 }, { x: 1.5, y: 0.5 })).toBe(true);
    expect(contains({ kind: 'annulus', center: { x: 0, y: 0 }, inner: 2, outer: 4 }, { x: 1, y: 0 })).toBe(false);
    expect(contains({ kind: 'annulus', center: { x: 0, y: 0 }, inner: 2, outer: 4 }, { x: 3, y: 0 })).toBe(true);
    // A concave shape: an elevated plus maze's outline.
    expect(contains(plus, { x: 5, y: 1 })).toBe(true);
    expect(contains(plus, { x: 1, y: 1 })).toBe(false);
    expect(contains(plus, { x: 9, y: 5 })).toBe(true);
  });

  it('measures area and distance to the edge', () => {
    expect(area(square)).toBe(100);
    expect(area(plus)).toBe(36);
    expect(area({ kind: 'annulus', center: { x: 0, y: 0 }, inner: 1, outer: 2 })).toBeCloseTo(3 * Math.PI);
    expect(distanceToEdge(square, { x: 2, y: 5 })).toBe(2);
    expect(distanceToEdge({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 13 })).toBe(3);
    expect(distanceToEdge({ kind: 'circle', center: { x: 0, y: 0 }, radius: 10 }, { x: 0, y: 7 })).toBeCloseTo(3);
  });
});

describe('calibration', () => {
  it('maps through a two-point scale and back', () => {
    const cal = scaleFromTwoPoints({ x: 100, y: 50 }, { x: 500, y: 50 }, 40);
    expect(toWorld(cal, { x: 300, y: 150 })).toEqual({ x: 20, y: 10 });
    expect(toImage(cal, { x: 20, y: 10 })).toEqual({ x: 300, y: 150 });
    expect(pxPerCmAt(cal, { x: 0, y: 0 })).toBe(10);
  });

  it('recovers a perspective view of a 40 cm square from its four corners', () => {
    // A known homography: a tilted camera looking at the floor.
    const truth = [8, 1.5, 120, -0.8, 7, 60, 0.0015, 0.002, 1];
    const project = (p: { x: number; y: number }) => {
      const w = truth[6]! * p.x + truth[7]! * p.y + truth[8]!;
      return { x: (truth[0]! * p.x + truth[1]! * p.y + truth[2]!) / w, y: (truth[3]! * p.x + truth[4]! * p.y + truth[5]!) / w };
    };
    const corners = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
    const pairs = corners.map((world) => ({ world, image: project(world) }));
    const cal = homographyFromPoints(pairs);
    expect(calibrationResidualCm(cal, pairs)).toBeLessThan(1e-6);
    const inside = toWorld(cal, project({ x: 13, y: 27 }));
    expect(inside.x).toBeCloseTo(13, 6);
    expect(inside.y).toBeCloseTo(27, 6);
    const back = toImage(cal, { x: 13, y: 27 });
    expect(back.x).toBeCloseTo(project({ x: 13, y: 27 }).x, 6);
  });

  it('fits more than four noisy points by least squares', () => {
    const pairs = [];
    for (let x = 0; x <= 40; x += 10) for (let y = 0; y <= 40; y += 10) {
      const jitter = ((x * 7 + y * 13) % 5) / 10 - 0.2;
      pairs.push({ world: { x, y }, image: { x: 50 + x * 9 + jitter, y: 30 + y * 9 - jitter } });
    }
    const cal = homographyFromPoints(pairs);
    expect(calibrationResidualCm(cal, pairs)).toBeLessThan(0.1);
    expect(pxPerCmAt(cal, { x: 230, y: 210 })).toBeCloseTo(9, 1);
  });

  it('rejects degenerate input', () => {
    expect(() => scaleFromTwoPoints({ x: 1, y: 1 }, { x: 1, y: 1 }, 10)).toThrow();
    const collinear = [0, 1, 2, 3].map((i) => ({ world: { x: i, y: i }, image: { x: i * 10, y: i * 10 } }));
    expect(() => homographyFromPoints(collinear)).toThrow();
  });
});

describe('arena', () => {
  const field = openFieldZones(40, 40);
  const arena = { ...field, calibration: scaleFromTwoPoints({ x: 20, y: 10 }, { x: 220, y: 10 }, 40) };

  it('rasterizes the boundary to an image mask', () => {
    const mask = arenaMask(arena, 260, 230);
    const ones = mask.reduce((s, v) => s + v, 0);
    // The box runs from pixel 20 to pixel 220 on each axis, edges included.
    expect(ones).toBe(201 * 201);
    expect(mask[10 * 260 + 20]).toBe(1);
    expect(mask[5 * 260 + 20]).toBe(0);
    expect(arenaPxPerCm(arena)).toBe(5);
  });

  it('names the zones a point falls in', () => {
    expect(zonesAt(arena, { x: 20, y: 20 })).toEqual(['center']);
    expect(zonesAt(arena, { x: 2, y: 2 })).toEqual([]);
    const round = roundArenaZones(50);
    expect(zonesAt(round, { x: 0, y: 5 })).toEqual(['center']);
    expect(zonesAt(round, { x: 0, y: 20 })).toEqual(['periphery']);
  });
});

describe('zone measures', () => {
  const zones = openFieldZones(40, 40).zones;
  const at = (timeS: number, x: number | null, y = 20): WorldSample => ({ timeS, point: x === null ? null : { x, y } });

  it('credits time, entries, latency and distance', () => {
    // Corner, walk into the center, stay, walk out, come back.
    const samples = [at(0, 2), at(1, 8), at(2, 15), at(3, 20), at(4, 25), at(5, 32), at(6, 20), at(7, 20)];
    const s = measureZones(samples, zones, { maxGapS: 2 });
    const center = s.zones[0]!;
    expect(center.entries).toBe(2);
    expect(center.latencyS).toBe(2);
    expect(center.timeS).toBe(4); // 2→3, 3→4, 4→5, 6→7
    expect(center.distanceCm).toBe(5 + 5 + 7 + 0);
    expect(s.distanceCm).toBe(6 + 7 + 5 + 5 + 7 + 12 + 0);
    expect(s.trackedS).toBe(7);
  });

  it('counts a start inside as an entry at latency 0', () => {
    const s = measureZones([at(0, 20), at(1, 21)], zones);
    expect(s.zones[0]).toMatchObject({ entries: 1, latencyS: 0 });
  });

  it('does not credit untracked stretches or break a presence on a dropout', () => {
    const samples = [at(0, 20), at(0.1, null), at(0.2, 20), at(5, 20)];
    const s = measureZones(samples, zones);
    expect(s.zones[0]!.entries).toBe(1);
    expect(s.zones[0]!.timeS).toBeCloseTo(0.1); // 0→0.1; the 4.8 s gap is not credited
    expect(s.trackedS).toBeCloseTo(0.1);
  });

  it('ignores line flicker shorter than minEntryS', () => {
    const samples = [at(0, 5), at(0.1, 11), at(0.2, 9), at(0.3, 11), at(0.4, 9), at(0.5, 15), at(0.6, 15), at(0.7, 15)];
    expect(measureZones(samples, zones).zones[0]!.entries).toBe(3);
    expect(measureZones(samples, zones, { minEntryS: 0.15 }).zones[0]).toMatchObject({ entries: 1, latencyS: 0.5 });
  });

  it('reports a zone never entered', () => {
    expect(measureZones([at(0, 1), at(1, 2)], zones).zones[0]).toMatchObject({ entries: 0, latencyS: null, timeS: 0 });
  });
});
