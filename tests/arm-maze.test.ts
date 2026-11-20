import { describe, expect, it } from 'vitest';
import { armMazeLayout, elevatedPlusMaze, yMaze } from '../src/arena/armMaze';
import { zonesAt } from '../src/arena/arena';
import { homographyFromPoints, scaleFromTwoPoints, toImage } from '../src/arena/calibration';
import { area } from '../src/arena/shapes';
import { zoneVisits, type WorldSample } from '../src/arena/zoneMeasures';
import { elevatedPlus } from '../src/paradigms/elevated-plus';
import { alternation, yMazeAlternation } from '../src/paradigms/y-maze';
import { openField } from '../src/paradigms/open-field';
import { barnesMaze } from '../src/paradigms/barnes';
import { arenaRecording, PathBuilder } from './helpers/arenaVideo';

const SIZE = 360;
/** 5 px/cm, world origin (the hub's center) at the middle of the image. */
const camera = scaleFromTwoPoints({ x: SIZE / 2, y: SIZE / 2 }, { x: SIZE / 2 + 100, y: SIZE / 2 }, 20);

describe('arm maze layouts', () => {
  it('builds a plus maze whose zones tile the outline', () => {
    const epm = elevatedPlusMaze({ armLengthCm: 30, armWidthCm: 5 });
    expect(area(epm.boundary)).toBeCloseTo(4 * 30 * 5 + 5 * 5, 6);
    const sum = epm.zones.reduce((t, z) => t + area(z.shape), 0);
    expect(sum).toBeCloseTo(area(epm.boundary), 6);
    expect(epm.zones.map((z) => z.id)).toEqual(['center', 'open-north', 'closed-east', 'open-south', 'closed-west']);
    expect(zonesAt(epm, { x: 0, y: 0 })).toEqual(['center']);
    expect(zonesAt(epm, { x: 0, y: -20 })).toEqual(['open-north']);
    expect(zonesAt(epm, { x: 20, y: 0 })).toEqual(['closed-east']);
    expect(zonesAt(epm, { x: 20, y: 20 })).toEqual([]);
    expect(epm.landmarks.find((l) => l.id === 'open-north:tip')!.world).toEqual({ x: 0, y: -32.5 });
  });

  it('turns the open arms sideways on request', () => {
    expect(elevatedPlusMaze({ openArms: 'horizontal' }).zones.map((z) => z.id)).toEqual(['center', 'closed-north', 'open-east', 'closed-south', 'open-west']);
  });

  it('builds a Y-maze with a triangular hub, and moves arm lines out by the entry margin', () => {
    const y = yMaze({ armLengthCm: 35, armWidthCm: 5 });
    const triangle = (Math.sqrt(3) / 4) * 25;
    expect(area(y.boundary)).toBeCloseTo(3 * 35 * 5 + triangle, 6);
    expect(area(y.zones[0]!.shape)).toBeCloseTo(triangle, 6);
    const tipA = y.landmarks.find((l) => l.id === 'A:tip')!.world;
    expect(tipA.x).toBeCloseTo(0, 9);
    expect(tipA.y).toBeCloseTo(-(35 + 2.5 / Math.sqrt(3)), 9);
    expect(zonesAt(y, { x: 0, y: -3 })).toEqual(['A']);

    const deep = yMaze({ entryMarginCm: 3 });
    expect(zonesAt(deep, { x: 0, y: -3 })).toEqual(['center']);
    const sum = deep.zones.reduce((t, z) => t + area(z.shape), 0);
    expect(sum).toBeCloseTo(area(deep.boundary), 6);
  });

  it('builds an 8-arm radial maze from the same function', () => {
    const radial = armMazeLayout(
      Array.from({ length: 8 }, (_, i) => ({ id: `arm-${i + 1}`, name: `Arm ${i + 1}` })),
      { armLengthCm: 35, armWidthCm: 10 },
    );
    expect(radial.zones).toHaveLength(9);
    const sum = radial.zones.reduce((t, z) => t + area(z.shape), 0);
    expect(sum).toBeCloseTo(area(radial.boundary), 6);
  });

  it('rejects mazes that cannot be built', () => {
    expect(() => armMazeLayout([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { armLengthCm: 10, armWidthCm: 5 })).toThrow();
    expect(() => yMaze({ entryMarginCm: 40 })).toThrow();
  });
});

describe('zone visits and alternation', () => {
  it('lists entries in order, with the same entry rule as the zone measures', () => {
    const y = yMaze();
    const at = (timeS: number, x: number, yy: number): WorldSample => ({ timeS, point: { x, y: yy } });
    const samples = [at(0, 0, 0), at(0.5, 0, -10), at(1, 0, 0), at(1.1, 0, -10), at(1.2, 0, 0), at(2, 10, 6), at(3, 10, 6)];
    expect(zoneVisits(samples, y.zones.slice(1)).map((v) => v.zoneId)).toEqual(['A', 'A', 'B']);
    expect(zoneVisits(samples, y.zones.slice(1), { minEntryS: 0.2 }).map((v) => v.zoneId)).toEqual(['B']);
  });

  it('counts alternations', () => {
    expect(alternation([...'ABCACCBA'])).toEqual({ alternations: 3, alternationPct: 50, sameArmReturns: 1 });
    expect(alternation([...'ABCABC'])).toMatchObject({ alternations: 4, alternationPct: 100 });
    expect(alternation([...'AB']).alternationPct).toBeNull();
  });
});

describe('elevated plus maze', () => {
  it('scores open and closed arms on a synthetic session', async () => {
    const layout = elevatedPlusMaze();
    const arena = { ...layout, calibration: camera };
    const path = new PathBuilder({ x: 0, y: 0 })
      .stay(1)
      .to({ x: 0, y: -20 }, 1).stay(2).to({ x: 0, y: 0 }, 1)
      .to({ x: 20, y: 0 }, 1).stay(3).to({ x: 0, y: 0 }, 1)
      .to({ x: -20, y: 0 }, 1).stay(3).to({ x: 0, y: 0 }, 1)
      .stay(1).points;
    const { summary, warnings } = await elevatedPlus.analyze(arenaRecording(arena, SIZE, SIZE, path), { arena });
    expect(warnings).toEqual([]);
    expect(summary.trackedFraction).toBe(1);
    expect(summary.open.entries).toBe(1);
    expect(summary.closed.entries).toBe(2);
    expect(summary.openEntriesPct).toBeCloseTo(100 / 3, 6);
    // Beyond the hub edge (2.5 cm): 2 s standing plus 17.5/20 of each 1 s walk.
    expect(summary.open.timeS).toBeGreaterThan(3.5);
    expect(summary.open.timeS).toBeLessThan(4.0);
    expect(summary.closed.timeS).toBeGreaterThan(9.2);
    expect(summary.closed.timeS).toBeLessThan(9.8);
    expect(summary.openTimePct).toBeGreaterThan(25);
    expect(summary.openTimePct).toBeLessThan(31);
    expect(summary.open.latencyS).toBeGreaterThan(1);
    expect(summary.open.latencyS).toBeLessThan(1.3);
    expect(summary.offMazeS).toBeLessThan(0.1);
  });
});

describe('Y-maze', () => {
  it('reads the arm order from a synthetic session calibrated from arm-end landmarks', async () => {
    const layout = yMaze();
    // Calibrate the way an app would: click the six arm-end corners on the image.
    const calibration = homographyFromPoints(
      layout.landmarks.filter((l) => !l.id.endsWith(':tip')).map((l) => ({ world: l.world, image: toImage(camera, l.world) })),
    );
    const arena = { ...layout, calibration };
    const dir: Record<string, { x: number; y: number }> = {
      A: { x: 0, y: -1 },
      B: { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) },
      C: { x: -Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) },
    };
    const builder = new PathBuilder({ x: 0, y: 0 }).stay(0.5);
    for (const arm of 'ABCACCBA') {
      const d = dir[arm]!;
      builder.to({ x: 20 * d.x, y: 20 * d.y }, 0.7).stay(0.3).to({ x: 0, y: 0 }, 0.7).stay(0.3);
    }
    const result = await yMazeAlternation.analyze(arenaRecording(arena, SIZE, SIZE, builder.points), { arena });
    expect(result.summary.sequence.join('')).toBe('ABCACCBA');
    expect(result.summary).toMatchObject({ armEntries: 8, alternations: 3, alternationPct: 50, sameArmReturns: 1 });
    expect(result.warnings).toEqual(['Only 8 arm entries; alternation is unreliable below about 10.']);
  });
});

describe('paradigm registry', () => {
  it('describes every paradigm the same way', () => {
    const all = [barnesMaze, openField, elevatedPlus, yMazeAlternation];
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) {
      expect(p.id).toMatch(/^[a-z-]+$/);
      expect(p.measures.length).toBeGreaterThan(0);
    }
  });
});
